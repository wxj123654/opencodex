import { beforeEach, describe, expect, test } from "bun:test";
import { gunzipSync, gzipSync } from "node:zlib";
import type { AdapterEvent, OcxAssistantContentPart, OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { resetDevinSessionTracking, resolveDevinSessionIdentity } from "../../src/adapters/devin-http/session-identity";
import { runDevinHttpTurn } from "../../src/adapters/devin-http/turn";
import { decodeConnectFrame } from "../../src/adapters/connect-framing";
import { ProtoDecoder, ProtoEncoder } from "../../src/adapters/devin-http/proto";
import { encodeConnectFrame } from "../../src/adapters/connect-framing";

/**
 * Coverage for the devin-http conversation identity: stable `#16 cascadeId`, `#15 ModelConfig
 * { id, turn }`, and the `#22 executionId` exchange lifecycle, all calibrated against the
 * observed real client (see the module comment in `session-identity.ts`).
 *
 * The injected `randomId` returns sequential tags, so generated identities are assertable
 * ("id-1", "id-2", …) and a test that accidentally consumes one it did not expect fails loudly.
 */

const NOW = 1_700_000_000_000;

let seq = 0;
const nextId = (): string => `id-${++seq}`;
const deps = { randomId: nextId, now: () => NOW };

beforeEach(() => {
  resetDevinSessionTracking();
  seq = 0;
});

// ─── message builders ───────────────────────────────────────────────────────

function user(text: string): OcxMessage {
  return { role: "user", content: text, timestamp: 0 };
}

function assistantText(text: string, thinking?: string): OcxMessage {
  const content: OcxAssistantContentPart[] = [];
  if (thinking) content.push({ type: "thinking", thinking });
  content.push({ type: "text", text });
  return { role: "assistant", content, timestamp: 0 };
}

function assistantCall(id: string, name: string, args: Record<string, unknown> = {}): OcxMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    timestamp: 0,
  };
}

function toolResult(toolCallId: string, text: string): OcxMessage {
  return { role: "toolResult", toolCallId, toolName: "shell", content: text, isError: false, timestamp: 0 };
}

// ─── unit: identity lifecycle ───────────────────────────────────────────────

describe("devin-http session identity", () => {
  test("a conversation's first turn mints stable ids and carries no exchange id", () => {
    const identity = resolveDevinSessionIdentity([user("hello")], deps);
    // The observed client sends no #22 on turn 1; the empty string encodes to an absent field.
    expect(identity).toEqual({ cascadeId: "id-1", modelConfigId: "id-2", executionId: "", turn: 1 });
  });

  test("a tool-loop continuation reuses the conversation and rotates in an exchange id", () => {
    resolveDevinSessionIdentity([user("hello")], deps);
    const identity = resolveDevinSessionIdentity(
      [user("hello"), assistantCall("c1", "shell", { command: "ls" }), toolResult("c1", "file")],
      deps,
    );
    expect(identity).toEqual({ cascadeId: "id-1", modelConfigId: "id-2", executionId: "id-3", turn: 2 });
  });

  test("the next user message rotates the exchange id; its tool loop keeps it", () => {
    const opening = [user("hello")];
    resolveDevinSessionIdentity(opening, deps);
    const loop = [user("hello"), assistantCall("c1", "shell"), toolResult("c1", "out")];
    resolveDevinSessionIdentity(loop, deps);
    const nextQuestion = [...loop, assistantText("done"), user("and now?")];
    const exchange2 = resolveDevinSessionIdentity(nextQuestion, deps);
    expect(exchange2).toEqual({ cascadeId: "id-1", modelConfigId: "id-2", executionId: "id-4", turn: 3 });
    const loop2 = [...nextQuestion, assistantCall("c2", "shell"), toolResult("c2", "out2")];
    const exchange2Cont = resolveDevinSessionIdentity(loop2, deps);
    expect(exchange2Cont).toEqual({ cascadeId: "id-1", modelConfigId: "id-2", executionId: "id-4", turn: 4 });
  });

  test("an identical replay is idempotent: same ids, same turn, no random consumed", () => {
    const messages = [user("hello"), assistantCall("c1", "shell"), toolResult("c1", "out")];
    resolveDevinSessionIdentity([user("hello")], deps);
    const first = resolveDevinSessionIdentity(messages, deps);
    const retry = resolveDevinSessionIdentity(messages, deps);
    expect(retry).toEqual(first);
    // The retry must not have minted anything: the next conversation's first ids are still the
    // immediate successors of the ones already handed out.
    expect(resolveDevinSessionIdentity([user("other")], deps).cascadeId).toBe("id-4");
  });

  test("a fork under the same opening gets its own identity, and the original survives it", () => {
    const forkA = [user("shared opening"), assistantText("went A")];
    const forkB = [user("shared opening"), assistantText("went B")];
    const a1 = resolveDevinSessionIdentity(forkA, deps);
    const b1 = resolveDevinSessionIdentity(forkB, deps);
    expect(b1.cascadeId).not.toBe(a1.cascadeId);
    expect(b1).toMatchObject({ executionId: "", turn: 1 });
    // Fork A continues afterwards and must still find its own chain, not B's.
    const a2 = resolveDevinSessionIdentity([...forkA, user("continue A")], deps);
    expect(a2.cascadeId).toBe(a1.cascadeId);
    expect(a2.turn).toBe(2);
  });

  test("a truncated (shortened) history starts a new conversation", () => {
    const long = [user("hello"), assistantText("hi"), user("again"), assistantText("there")];
    const first = resolveDevinSessionIdentity(long, deps);
    // Context compaction: the client drops the middle and replays a shorter prefix.
    const truncated = [user("hello"), assistantText("hi"), user("again")];
    const second = resolveDevinSessionIdentity(truncated, deps);
    expect(second.cascadeId).not.toBe(first.cascadeId);
    expect(second.turn).toBe(1);
  });

  test("sessions expire after the TTL and re-anchor as fresh conversations", () => {
    let clock = NOW;
    const tickDeps = { randomId: nextId, now: () => clock };
    resolveDevinSessionIdentity([user("hello")], tickDeps);
    clock = NOW + 29 * 60 * 1000;
    const warm = resolveDevinSessionIdentity(
      [user("hello"), assistantCall("c1", "shell"), toolResult("c1", "out")],
      tickDeps,
    );
    expect(warm.turn).toBe(2);
    // 29min access refreshed lastSeen, so expiry is measured from THERE: 31 more minutes idle.
    clock = NOW + 60 * 60 * 1000;
    const expired = resolveDevinSessionIdentity(
      [user("hello"), assistantCall("c1", "shell"), toolResult("c1", "out"), user("later")],
      tickDeps,
    );
    expect(expired.turn).toBe(1);
    expect(expired.cascadeId).not.toBe(warm.cascadeId);
  });

  test("thinking content does not fork the chain when a client strips it on replay", () => {
    const withThinking = [user("hello"), assistantText("answer", "private scratch")];
    resolveDevinSessionIdentity(withThinking, deps);
    // The same conversation replayed with thinking stripped must still extend the session.
    const stripped = [user("hello"), assistantText("answer"), user("next")];
    const identity = resolveDevinSessionIdentity(stripped, deps);
    expect(identity.turn).toBe(2);
    expect(identity.cascadeId).toBe("id-1");
  });

  test("a request with no projectable content gets a one-shot identity", () => {
    const identity = resolveDevinSessionIdentity(
      [{ role: "developer", content: "developer-only", timestamp: 0 }],
      deps,
    );
    expect(identity).toEqual({ cascadeId: "id-1", modelConfigId: "id-2", executionId: "", turn: 1 });
  });
});

// ─── integration: the identity reaches the wire ─────────────────────────────

describe("devin-http session identity on the wire", () => {
  test("consecutive turns of one conversation reuse #16, advance #15, and gate #22 on the exchange", async () => {
    resetDevinSessionTracking();
    const chatBodies: Uint8Array[] = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("GetUserJwt")) {
        const e = new ProtoEncoder();
        e.string(1, "jwt");
        return new Response(e.finish(), { status: 200 });
      }
      if (url.includes("GetChatMessage")) {
        chatBodies.push(new Uint8Array((init?.body as Uint8Array).buffer ?? init?.body as ArrayBuffer));
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encodeConnectFrame(gzipSync(new Uint8Array(0)), { compressed: true, endStream: true }));
              controller.close();
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof globalThis.fetch;

    const prov = { adapter: "devin-http", apiKey: "k" } as OcxProviderConfig;
    const run = async (messages: OcxMessage[]): Promise<void> => {
      const parsed = { modelId: "swe-2", stream: true, options: {}, context: { messages } } as OcxParsedRequest;
      const events: AdapterEvent[] = [];
      await runDevinHttpTurn(prov, parsed, { headers: new Headers() } as never, e => events.push(e), { fetch: impl });
      expect(events.at(-1)?.type).toBe("done");
    };

    await run([user("hello")]);
    await run([user("hello"), assistantCall("c1", "shell", { command: "ls" }), toolResult("c1", "out")]);

    expect(chatBodies).toHaveLength(2);
    const [turn1, turn2] = chatBodies.map(decodeChatRequest);

    expect(turn1.cascadeId).toBeTruthy();
    expect(turn1.cascadeId).toBe(turn2.cascadeId);
    // #15 present on both, with the monotonic turn counter advancing 1 → 2 and a stable id.
    expect(turn1.modelConfig).toEqual({ id: turn2.modelConfig?.id, turn: 1 });
    expect(turn2.modelConfig?.turn).toBe(2);
    // #22 is absent on the conversation's first turn and present from the first tool loop on.
    expect(turn1.executionId).toBeUndefined();
    expect(turn2.executionId).toBeTruthy();
    // #27 prompt_cache_key rides the stable conversation id, mirroring the real client's LS.
    expect(turn1.promptCacheKey).toBe(turn1.cascadeId);
    expect(turn2.promptCacheKey).toBe(turn1.cascadeId);
  });
});

// ─── helpers ────────────────────────────────────────────────────────────────

interface DecodedChatRequest {
  cascadeId?: string;
  executionId?: string;
  promptCacheKey?: string;
  modelConfig?: { id?: string; turn?: number };
}

function decodeChatRequest(body: Uint8Array): DecodedChatRequest {
  const { frame } = decodeConnectFrame(body);
  const raw = frame.compressed ? gunzipSync(frame.payload) : frame.payload;
  const d = new ProtoDecoder(raw);
  const out: DecodedChatRequest = {};
  while (!d.done) {
    const { field, wire } = d.readTag();
    if (field === 15 && wire === 2) {
      out.modelConfig = d.readMessage(inner => {
        const cfg: { id?: string; turn?: number } = {};
        while (!inner.done) {
          const { field: f, wire: w } = inner.readTag();
          if (f === 1 && w === 2) cfg.id = new TextDecoder().decode(inner.readBytes());
          else if (f === 2 && w === 0) cfg.turn = Number(inner.readVarint());
          else if (w === 0) inner.readVarint();
          else inner.skip(w);
        }
        return cfg;
      });
    } else if (field === 16 && wire === 2) {
      out.cascadeId = new TextDecoder().decode(d.readBytes());
    } else if (field === 22 && wire === 2) {
      out.executionId = new TextDecoder().decode(d.readBytes());
    } else if (field === 27 && wire === 2) {
      out.promptCacheKey = new TextDecoder().decode(d.readBytes());
    } else if (wire === 0) {
      d.readVarint();
    } else if (wire === 2) {
      d.readBytes();
    } else {
      d.skip(wire);
    }
  }
  return out;
}
