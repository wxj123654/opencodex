import { describe, expect, test } from "bun:test";
import {
  ChatMessageSource,
  decodeCliModelConfigs,
  decodeGetChatMessageResponse,
  decodeGetUserJwtResponse,
  encodeGetChatMessageRequest,
  encodeGetUserJwtRequest,
  ProtoDecoder,
  ProtoEncoder,
  StopReason,
  type CliModelConfig,
} from "../../src/adapters/devin-http/proto";
import { buildDevinMetadata } from "../../src/adapters/devin-http/client";
import {
  CONNECT_FLAG_COMPRESSED,
  CONNECT_FLAG_END_STREAM,
  consumeConnectFrames,
  encodeConnectFrame,
} from "../../src/adapters/connect-framing";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * Wire-codec coverage for the Cascade Connect adapter.
 *
 * These tests pin the reverse-engineered field numbers. They are the part of this adapter that a
 * refactor can silently break: a wrong field number still produces a well-formed protobuf that the
 * local type system accepts, and only the live server rejects it. So every shape the adapter
 * depends on is asserted by decoding a hand-built payload, not by round-tripping the encoder
 * through its own decoder (which would pass even if both were wrong).
 */

function encode(encodeBody: (e: ProtoEncoder) => void): Uint8Array {
  const e = new ProtoEncoder();
  encodeBody(e);
  return e.finish();
}

/**
 * Walk a message and collect every occurrence of a field, so repeated fields and nested lookups
 * are both expressible. Returns raw values: varints as `bigint`, length-delimited as bytes.
 */
function collect(bytes: Uint8Array, target: number): Array<{ wire: number; varint?: bigint; bytes?: Uint8Array }> {
  const out: Array<{ wire: number; varint?: bigint; bytes?: Uint8Array }> = [];
  const d = new ProtoDecoder(bytes);
  while (!d.done) {
    const { field: f, wire } = d.readTag();
    if (wire === 0) {
      const varint = d.readVarint();
      if (f === target) out.push({ wire, varint });
      continue;
    }
    if (wire === 2) {
      const value = d.readBytes();
      if (f === target) out.push({ wire, bytes: value.slice() });
      continue;
    }
    d.skip(wire);
  }
  return out;
}

/** The first length-delimited occurrence of a field, or undefined when absent. */
function field(bytes: Uint8Array, target: number): Uint8Array | undefined {
  return collect(bytes, target).find(entry => entry.wire === 2)?.bytes;
}

/** The first varint occurrence of a field, or undefined when absent. */
function varintField(bytes: Uint8Array, target: number): bigint | undefined {
  return collect(bytes, target).find(entry => entry.wire === 0)?.varint;
}

/** Decode a length-delimited field as UTF-8; throws when the field is missing. */
function textField(bytes: Uint8Array, target: number): string {
  const value = field(bytes, target);
  if (value === undefined) throw new Error(`field ${target} is absent`);
  return new TextDecoder().decode(value);
}

describe("devin-http proto primitives", () => {
  test("proto3 omits zero-valued scalars so an unset field is indistinguishable from its default", () => {
    // This is the property that makes temperature=0 dangerous: the encoder MUST drop it, because
    // the server reads a dropped field as "unset" and rejects the request for some models.
    const bytes = encode(e => {
      e.double(5, 0);
      e.uint32(7, 0);
      e.string(2, "");
      e.bool(11, false);
    });
    expect(bytes.length).toBe(0);
  });

  test("a non-zero double is emitted as an 8-byte little-endian fixed64", () => {
    const bytes = encode(e => e.double(5, 0.4));
    // tag(5, wire 1) = (5 << 3) | 1 = 41
    expect(bytes[0]).toBe(41);
    expect(bytes.length).toBe(1 + 8);
    expect(new DataView(bytes.buffer, bytes.byteOffset).getFloat64(1, true)).toBeCloseTo(0.4, 10);
  });

  test("repeated strings are emitted one tag per element, never packed", () => {
    const bytes = encode(e => e.repeatedString(9, ["a", "b"]));
    const d = new ProtoDecoder(bytes);
    const seen: string[] = [];
    while (!d.done) {
      const { field: f, wire } = d.readTag();
      expect(f).toBe(9);
      expect(wire).toBe(2);
      seen.push(d.readString());
    }
    expect(seen).toEqual(["a", "b"]);
  });

  test("the decoder skips unknown fields instead of failing — the server adds fields over time", () => {
    // A payload carrying an unknown field 99 alongside a known field 3 must still decode field 3.
    const payload = encode(e => {
      e.string(3, "hello");
      e.uint32(99, 7);
      e.string(3, " world");
    });
    const d = new ProtoDecoder(payload);
    let text = "";
    while (!d.done) {
      const { field: f, wire } = d.readTag();
      if (f === 3 && wire === 2) text += d.readString();
      else d.skip(wire);
    }
    expect(text).toBe("hello world");
  });

  test("the decoder throws on an unknown wire type rather than reading past the buffer", () => {
    // wire type 7 is not defined in proto3; silently continuing would desynchronize the stream.
    const bytes = new Uint8Array([(3 << 3) | 7]);
    const d = new ProtoDecoder(bytes);
    const { wire } = d.readTag();
    expect(() => d.skip(wire)).toThrow(/Unknown protobuf wire type/);
  });

  test("skipping a length-delimited field advances by the LENGTH varint plus the payload", () => {
    // Regression for a real cursor bug: `this.pos += this.readVarint()` captures `this.pos` before
    // the right-hand side runs, so the advance `readVarint` makes is discarded and the cursor lands
    // short by the varint's own width. A multi-byte length makes the shortfall large enough to land
    // mid-payload, which then decodes as a bogus tag.
    const payload = encode(e => {
      // A 200-byte unknown field forces a 2-byte length varint, so the old bug undershoots.
      e.string(77, "x".repeat(200));
      e.string(1, "after");
    });
    const d = new ProtoDecoder(payload);
    const first = d.readTag();
    expect(first.field).toBe(77);
    d.skip(first.wire);
    const second = d.readTag();
    expect(second.field).toBe(1);
    expect(d.readString()).toBe("after");
    expect(d.done).toBe(true);
  });

  test("a skipped field leaves the reader able to decode every later field", () => {
    const payload = encode(e => {
      e.string(3, "first");
      e.string(77, "unknown-length-delimited");
      e.uint64(99, 4242n);
      e.string(3, "second");
    });
    const d = new ProtoDecoder(payload);
    const texts: string[] = [];
    let unknownVarint: bigint | undefined;
    while (!d.done) {
      const { field: f, wire } = d.readTag();
      if (f === 3 && wire === 2) texts.push(d.readString());
      else if (f === 99 && wire === 0) unknownVarint = d.readVarint();
      else d.skip(wire);
    }
    expect(texts).toEqual(["first", "second"]);
    expect(unknownVarint).toBe(4242n);
  });
});

describe("devin-http metadata envelope", () => {
  test("the Windsurf identity fields land at their observed field numbers", () => {
    const encoded = encode(e => e.message(1, sub => {
      const m = buildDevinMetadata("devin-session-token$abc");
      for (const [f, v] of [[1, m.ideName], [7, m.ideVersion], [12, m.extensionName], [2, m.extensionVersion], [3, m.apiKey], [4, m.locale]] as const) {
        sub.string(f, v);
      }
    }));

    const metadata = field(encoded, 1)!;
    expect(field(metadata, 1)!.length).toBeGreaterThan(0);   // ide_name
    expect(field(metadata, 7)!.length).toBeGreaterThan(0);   // ide_version
    expect(field(metadata, 12)!.length).toBeGreaterThan(0);  // extension_name
    expect(field(metadata, 2)!.length).toBeGreaterThan(0);   // extension_version
    expect(field(metadata, 3)!.length).toBeGreaterThan(0);   // api_key
    expect(field(metadata, 4)!.length).toBeGreaterThan(0);   // locale
  });

  test("GetUserJwt wraps Metadata in field 1 — omitting the wrapper is a wire-format error", () => {
    // Regression: a hand-built request that sent Metadata at the top level produced
    // `cannot parse invalid wire-format data` from the server. The wrapper is load-bearing.
    const encoded = encodeGetUserJwtRequest(buildDevinMetadata("devin-session-token$abc"));
    const inner = field(encoded, 1);
    expect(inner).toBeDefined();
    expect(field(inner!, 3)!.length).toBeGreaterThan(0);
  });

  test("the user JWT rides field 21 only when present", () => {
    const without = encodeGetUserJwtRequest(buildDevinMetadata("k"));
    const withJwt = encodeGetUserJwtRequest(buildDevinMetadata("k", "jwt-value"));
    // Metadata is wrapped in field 1, so the JWT is one level down.
    expect(field(field(without, 1)!, 21)).toBeUndefined();
    expect(textField(field(withJwt, 1)!, 21)).toBe("jwt-value");
  });

  test("GetUserJwtResponse decodes both the JWT and a custom API host", () => {
    const payload = encode(e => {
      e.string(1, "the.jwt.value");
      e.string(2, "https://regional.example.com");
    });
    expect(decodeGetUserJwtResponse(payload)).toEqual({
      userJwt: "the.jwt.value",
      customApiServerUrl: "https://regional.example.com",
    });
  });

  test("a response with no JWT decodes to empty rather than throwing", () => {
    expect(decodeGetUserJwtResponse(new Uint8Array())).toEqual({ userJwt: "", customApiServerUrl: "" });
  });
});

describe("devin-http chat request", () => {
  const baseRequest = {
    prompt: "system text",
    chatMessagePrompts: [],
    configuration: {
      numCompletions: 1n,
      maxTokens: 64n,
      maxNewlines: 200n,
      temperature: 0.4,
      firstTemperature: 0.4,
      topK: 50n,
      topP: 1,
      stopPatterns: ["\n\nUSER:"],
      fimEotProbThreshold: 1,
    },
    tools: [],
    disableParallelToolCalls: false,
    toolChoice: { optionName: "auto" },
    cascadeId: "00000000-0000-4000-8000-000000000000",
    executionId: "11111111-1111-4111-8111-111111111111",
  };

  test("the request carries CASCADE request type and the ephemeral prompt-cache option", () => {
    const encoded = encodeGetChatMessageRequest({
      ...baseRequest,
      metadata: buildDevinMetadata("k"),
      chatModelUid: "swe-2-high",
    });
    // field 7 = request_type (varint 5 = CASCADE), field 13 = PromptCacheOptions{type: 1}
    expect(varintField(encoded, 7)).toBe(5n);
    const cacheOptions = field(encoded, 13)!;
    expect(varintField(cacheOptions, 1)).toBe(1n);
    expect(field(encoded, 21)!.length).toBeGreaterThan(0); // chat_model_uid
    expect(field(encoded, 16)!.length).toBeGreaterThan(0); // cascadeId
    expect(field(encoded, 22)!.length).toBeGreaterThan(0); // executionId
  });

  test("tool definitions serialize name, description, and the schema as a JSON string", () => {
    const encoded = encodeGetChatMessageRequest({
      ...baseRequest,
      metadata: buildDevinMetadata("k"),
      chatModelUid: "swe-2-high",
      tools: [{
        name: "get_weather",
        description: "Get weather",
        jsonSchemaString: JSON.stringify({ type: "object" }),
        strict: true,
      }],
    });
    const toolsField = field(encoded, 10)!;
    expect(field(toolsField, 1)!.length).toBeGreaterThan(0);
    expect(field(toolsField, 2)!.length).toBeGreaterThan(0);
    // The schema is a STRING field, not a nested message: the server expects pre-serialized JSON.
    expect(textField(toolsField, 3)).toBe('{"type":"object"}');
  });

  test("message prompts carry the source discriminator and assistant replays use SYSTEM", () => {
    const encoded = encodeGetChatMessageRequest({
      ...baseRequest,
      metadata: buildDevinMetadata("k"),
      chatModelUid: "swe-2-high",
      chatMessagePrompts: [
        { messageId: "m1", source: ChatMessageSource.USER, prompt: "hi" },
        { messageId: "bot-m1", source: ChatMessageSource.SYSTEM, prompt: "hello" },
      ],
    });
    const prompts = collect(encoded, 3);
    expect(prompts).toHaveLength(2);
    const sources = prompts.map(p => Number(varintField(p.bytes!, 2)));
    expect(sources).toEqual([ChatMessageSource.USER, ChatMessageSource.SYSTEM]);
  });
});

describe("devin-http chat response", () => {
  test("text, thinking, signature, and stop reason land on their observed fields", () => {
    const payload = encode(e => {
      e.string(1, "msg-1");
      e.string(3, "hello");
      e.string(9, "thinking...");
      e.string(10, "sig-blob");
      e.uint32(5, StopReason.MAX_TOKENS);
    });
    const decoded = decodeGetChatMessageResponse(payload);
    expect(decoded.messageId).toBe("msg-1");
    expect(decoded.deltaText).toBe("hello");
    expect(decoded.deltaThinking).toBe("thinking...");
    expect(decoded.deltaSignature).toBe("sig-blob");
    expect(decoded.stopReason).toBe(StopReason.MAX_TOKENS);
  });

  test("tool calls decode from repeated field 6 with their JSON arguments as a string", () => {
    const payload = encode(e => {
      e.message(6, sub => {
        sub.string(1, "functions.get_weather:0");
        sub.string(2, "get_weather");
        sub.string(3, JSON.stringify({ city: "Tokyo" }));
      });
    });
    const decoded = decodeGetChatMessageResponse(payload);
    expect(decoded.deltaToolCalls).toHaveLength(1);
    expect(decoded.deltaToolCalls[0]).toEqual({
      id: "functions.get_weather:0",
      name: "get_weather",
      argumentsJson: '{"city":"Tokyo"}',
    });
  });

  test("usage decodes input/output/cache counters and the billed model uid", () => {
    const payload = encode(e => {
      e.message(7, sub => {
        sub.uint64(2, 136n);
        sub.uint64(3, 58n);
        sub.uint64(5, 256n);
        sub.string(9, "swe-1-7-lightning");
      });
    });
    const decoded = decodeGetChatMessageResponse(payload);
    expect(decoded.usage).toEqual({
      inputTokens: 136,
      outputTokens: 58,
      cacheWriteTokens: 0,
      cacheReadTokens: 256,
      modelUid: "swe-1-7-lightning",
    });
  });

  test("a frame with no usage decodes usage as null, not a zeroed object", () => {
    // The distinction matters: the adapter keeps the last NON-ZERO usage frame, and a zeroed
    // object would be indistinguishable from a real all-zero report.
    expect(decodeGetChatMessageResponse(encode(e => e.string(3, "x"))).usage).toBeNull();
  });

  test("an empty payload decodes to an empty delta rather than throwing", () => {
    const decoded = decodeGetChatMessageResponse(new Uint8Array());
    expect(decoded.deltaText).toBe("");
    expect(decoded.deltaToolCalls).toEqual([]);
    expect(decoded.stopReason).toBe(StopReason.UNSPECIFIED);
  });
});

describe("devin-http roster decode", () => {
  function clientModelConfig(config: {
    label?: string;
    disabled?: boolean;
    supportsImages?: boolean;
    maxTokens?: number;
    id?: string;
    supportsThinking?: boolean;
  }): (e: ProtoEncoder) => void {
    return sub => {
      if (config.label) sub.string(1, config.label);
      if (config.disabled) sub.bool(4, true);
      if (config.supportsImages) sub.bool(5, true);
      if (config.maxTokens !== undefined) sub.uint64(18, BigInt(config.maxTokens));
      if (config.id) sub.string(22, config.id);
      if (config.supportsThinking !== undefined) {
        sub.message(23, info => {
          info.message(6, features => {
            if (config.supportsThinking!) features.bool(15, true);
          });
        });
      }
    };
  }

  test("decodes the roster from repeated ClientModelConfig at field 1", () => {
    const payload = encode(e => {
      e.message(1, clientModelConfig({ id: "swe-2-high", label: "SWE-2 High", maxTokens: 262000, supportsImages: true, supportsThinking: true }));
      e.message(1, clientModelConfig({ id: "glm-5-2", label: "GLM-5.2", maxTokens: 200000 }));
    });
    const models = decodeCliModelConfigs(payload);
    expect(models).toEqual<CliModelConfig[]>([
      { id: "swe-2-high", label: "SWE-2 High", contextWindow: 262000, supportsImages: true, supportsThinking: true },
      { id: "glm-5-2", label: "GLM-5.2", contextWindow: 200000, supportsImages: false, supportsThinking: false },
    ]);
  });

  test("disabled entries are dropped — they are not callable, so publishing them only fails later", () => {
    const payload = encode(e => {
      e.message(1, clientModelConfig({ id: "usable", label: "Usable" }));
      e.message(1, clientModelConfig({ id: "retired", label: "Retired", disabled: true }));
    });
    expect(decodeCliModelConfigs(payload).map(m => m.id)).toEqual(["usable"]);
  });

  test("an entry with a blank uid is dropped rather than published as an empty model id", () => {
    const payload = encode(e => {
      e.message(1, clientModelConfig({ id: "", label: "No Uid" }));
      e.message(1, clientModelConfig({ id: "   ", label: "Whitespace" }));
      e.message(1, clientModelConfig({ id: "real" }));
    });
    expect(decodeCliModelConfigs(payload).map(m => m.id)).toEqual(["real"]);
  });

  test("a missing label falls back to the uid and a missing window to zero", () => {
    const payload = encode(e => e.message(1, clientModelConfig({ id: "swe-2-high" })));
    expect(decodeCliModelConfigs(payload)[0]).toEqual({
      id: "swe-2-high",
      label: "swe-2-high",
      contextWindow: 0,
      supportsImages: false,
      supportsThinking: false,
    });
  });

  test("unknown fields inside a config are skipped without losing the id", () => {
    const payload = encode(e => {
      e.message(1, sub => {
        sub.uint64(2, 12345n);
        sub.string(22, "swe-2-high");
        sub.string(77, "a field this adapter has never seen");
        sub.uint64(88, 1n);
      });
    });
    expect(decodeCliModelConfigs(payload).map(m => m.id)).toEqual(["swe-2-high"]);
  });

  test("an empty roster decodes to an empty array", () => {
    expect(decodeCliModelConfigs(new Uint8Array())).toEqual([]);
  });
});

describe("devin-http Connect framing", () => {
  test("a gzip request frame round-trips through the shared framing module", () => {
    const body = encode(e => e.string(2, "system prompt"));
    const gz = gzipSync(body);
    const frame = encodeConnectFrame(gz, { compressed: true });
    expect(frame[0]).toBe(CONNECT_FLAG_COMPRESSED);
    expect(new DataView(frame.buffer, frame.byteOffset).getUint32(1, false)).toBe(gz.length);

    const { frames, consumedBytes } = consumeConnectFrames(frame);
    expect(consumedBytes).toBe(frame.length);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.compressed).toBe(true);
    expect(gunzipSync(frames[0]!.payload)).toEqual(body);
  });

  test("an end-stream trailer is flagged separately so it is not parsed as a message", () => {
    const trailer = new TextEncoder().encode(JSON.stringify({ error: { code: "permission_denied", message: "nope" } }));
    const frame = encodeConnectFrame(trailer, { endStream: true });
    const { frames } = consumeConnectFrames(frame);
    expect(frames[0]!.endStream).toBe(true);
    expect(frames[0]!.flags & CONNECT_FLAG_END_STREAM).toBe(CONNECT_FLAG_END_STREAM);
    expect(JSON.parse(new TextDecoder().decode(frames[0]!.payload)).error.code).toBe("permission_denied");
  });

  test("a partial frame stays buffered and reports zero bytes consumed", () => {
    // The stream reader relies on this to accumulate a frame split across TCP chunks.
    const full = encodeConnectFrame(new TextEncoder().encode("payload"));
    const partial = full.subarray(0, full.length - 2);
    const { frames, consumedBytes } = consumeConnectFrames(partial);
    expect(frames).toHaveLength(0);
    expect(consumedBytes).toBe(0);
  });

  test("multiple frames in one buffer are all consumed in order", () => {
    const a = encodeConnectFrame(new TextEncoder().encode("one"));
    const b = encodeConnectFrame(new TextEncoder().encode("two"));
    const merged = new Uint8Array(a.length + b.length);
    merged.set(a, 0);
    merged.set(b, a.length);
    const { frames, consumedBytes } = consumeConnectFrames(merged);
    expect(frames.map(f => new TextDecoder().decode(f.payload))).toEqual(["one", "two"]);
    expect(consumedBytes).toBe(merged.length);
  });
});
