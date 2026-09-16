import { deflateSync } from "node:zlib";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  DEVIN_IMAGE_BASE64_BUDGET,
  prepareDevinImages,
} from "../../src/adapters/devin-http/images";
import { resetNormalizeStateForTests, type EncodeFn } from "../../src/adapters/anthropic-image-normalize";
import type { OcxMessage } from "../../src/types";

/** 1x1 red PNG — the smallest real, fully-decodable fixture. */
const ONE_PX_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function realPngBase64(width: number, height: number): Promise<string> {
  const buf = await new Bun.Image(Buffer.from(ONE_PX_PNG, "base64")).resize(width, height).png().toBuffer();
  return Buffer.from(buf).toString("base64");
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * Noise PNG: solid-color fixtures compress to nothing and ride pass-through, so a
 * test that needs the ENCODE path must carry real entropy. Random RGB pixels are
 * incompressible as PNG but shrink dramatically as JPEG. Bun.Image has no raw-pixel
 * input, so the PNG is hand-assembled (same trick as the size probe scripts).
 */
function noisyPngBase64(width: number, height: number, seed = 1): string {
  let s = seed;
  const rnd = (): number => (s = (s * 1103515245 + 12345) & 0x7fffffff) % 256;
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width * 3; x++) raw[row + 1 + x] = rnd();
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const png = new Uint8Array(8);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [png, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", new Uint8Array(0))];
  return Buffer.concat(parts.map(p => Buffer.from(p))).toString("base64");
}

function userMsg(parts: unknown[]): OcxMessage {
  return { role: "user", content: parts as OcxMessage["content"], timestamp: 0 };
}

function imagePart(b64: string, mediaType = "image/png"): Record<string, unknown> {
  return { type: "image", imageUrl: `data:${mediaType};base64,${b64}` };
}

beforeEach(() => resetNormalizeStateForTests());

describe("prepareDevinImages", () => {
  test("returns the same array when no message carries an image", async () => {
    const messages = [userMsg([{ type: "text", text: "hi" }])];
    expect(await prepareDevinImages(messages)).toBe(messages);
  });

  test("a small decodable image passes through unchanged and the message is not cloned", async () => {
    const messages = [userMsg([{ type: "text", text: "look" }, imagePart(ONE_PX_PNG)])];
    const out = await prepareDevinImages(messages);
    expect(out).toBe(messages);
    expect((out[0]!.content as Array<{ imageUrl?: string }>)[1]!.imageUrl)
      .toBe(`data:image/png;base64,${ONE_PX_PNG}`);
  });

  test("an oversized image is re-encoded smaller and the source history is not mutated", async () => {
    const big = noisyPngBase64(2400, 2400); // exceeds tier-0 maxEdge 2000
    const original = `data:image/png;base64,${big}`;
    const messages = [userMsg([{ type: "text", text: "look" }, imagePart(big)])];
    const out = await prepareDevinImages(messages);
    expect(out).not.toBe(messages);
    const part = (out[0]!.content as Array<{ type: string; imageUrl?: string }>)[1]!;
    expect(part.type).toBe("image");
    expect(part.imageUrl).toMatch(/^data:image\/jpeg;base64,/);
    // Re-encoded output must fit the tier-0 hard cap (2 MiB base64).
    expect(part.imageUrl!.length).toBeLessThan(2 * 1024 * 1024);
    // Original message untouched — a retry must replay identical history.
    expect((messages[0]!.content as Array<{ imageUrl?: string }>)[1]!.imageUrl).toBe(original);
  });

  test("a remote URL image is left alone (dropped later at projection, never fetched)", async () => {
    const messages = [userMsg([imagePart("AAAA"), { type: "image", imageUrl: "https://example.com/a.png" }])];
    const out = await prepareDevinImages(messages);
    expect((out[0]!.content as Array<{ imageUrl?: string }>)[1]!.imageUrl).toBe("https://example.com/a.png");
  });

  test("undecodable image data is replaced with a text note", async () => {
    const messages = [userMsg([imagePart("aGVsbG8gd29ybGQ=")])]; // "hello world", not an image
    const out = await prepareDevinImages(messages);
    const part = (out[0]!.content as Array<{ type: string; text?: string }>)[0]!;
    expect(part.type).toBe("text");
    expect(part.text).toContain("image omitted");
  });

  test("assistant messages are not scanned for images (projection ignores them too)", async () => {
    const messages: OcxMessage[] = [{
      role: "assistant",
      content: [{ type: "image", imageUrl: `data:image/png;base64,${ONE_PX_PNG}` } as never],
      timestamp: 0,
    }];
    expect(await prepareDevinImages(messages)).toBe(messages);
  });

  test("aggregate overflow drops the oldest images until the budget fits", async () => {
    // Injected encoder: every image "compresses" to a fixed 2KB payload regardless of
    // tier, so only the overflow-drop path can bring the sum under a tiny budget.
    const encode: EncodeFn = () =>
      Promise.resolve({ data: "A".repeat(2048), mediaType: "image/jpeg" });
    // Noise >2000px forces the encode path (pass-through requires dims within maxEdge).
    const big = noisyPngBase64(2200, 2200);
    const messages = [
      userMsg([imagePart(big)]),
      userMsg([imagePart(big)]),
      userMsg([imagePart(big)]),
    ];
    const out = await prepareDevinImages(messages, { encode, budget: 4096 });
    const parts = out.map(m => (m.content as Array<{ type: string; text?: string; imageUrl?: string }>)[0]!);
    // 3 × 2048 = 6144 > 4096: demotion can't shrink (fixed-size encoder), so the
    // OLDEST image is dropped to a text note; the two newest survive as images.
    expect(parts[0]!.type).toBe("text");
    expect(parts[0]!.text).toContain("image omitted");
    expect(parts[1]!.type).toBe("image");
    expect(parts[2]!.type).toBe("image");
  });

  test("budget constant stays under the measured upstream ~14MB body cap", () => {
    expect(DEVIN_IMAGE_BASE64_BUDGET).toBeLessThan(14 * 1024 * 1024);
  });
});
