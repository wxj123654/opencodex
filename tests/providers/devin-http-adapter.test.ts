import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { createDevinHttpAdapter } from "../../src/adapters/devin-http";
import {
  collectSystemPrompt,
  projectDevinPrompts,
  resolveWireUid,
  runDevinHttpTurn,
  stopReasonToDevinStopReason,
  toCompletionConfiguration,
  toDevinToolDefinitions,
} from "../../src/adapters/devin-http/turn";
import { resolveDevinToken, normalizeDevinToken, readDevinCredentialFile, devinCredentialFileCandidates, DevinMissingCredentialError } from "../../src/adapters/devin-http/credentials";
import { buildDevinMetadata, streamDevinChat } from "../../src/adapters/devin-http/client";
import { encodeConnectFrame } from "../../src/adapters/connect-framing";
import { ProtoDecoder, ProtoEncoder, StopReason } from "../../src/adapters/devin-http/proto";

/** Decode a length-delimited field as UTF-8; throws when the field is missing. */
function textField(bytes: Uint8Array, target: number): string {
  const d = new ProtoDecoder(bytes);
  while (!d.done) {
    const { field: f, wire } = d.readTag();
    if (f === target && wire === 2) return new TextDecoder().decode(d.readBytes());
    if (wire === 0) d.readVarint();
    else if (wire === 2) d.readBytes();
    else d.skip(wire);
  }
  throw new Error(`field ${target} is absent`);
}

/**
 * Behavior coverage for the devin-http turn.
 *
 * The transport is driven through an injected `fetch`, so these tests exercise the real request
 * encoding and the real response decoding — only the socket is fake. That is deliberate: the bugs
 * worth catching here live in the mapping decisions (which usage frame wins, whether a tool call is
 * emitted once or accumulated, whether an effort-less selection sends a callable uid), not in the
 * plumbing.
 */

function chatResponseFrame(body: (e: ProtoEncoder) => void): Uint8Array {
  const message = new ProtoEncoder();
  body(message);
  return encodeConnectFrame(gzipSync(message.finish()), { compressed: true });
}

function endStreamFrame(payload: unknown = {}): Uint8Array {
  return encodeConnectFrame(gzipSync(new TextEncoder().encode(JSON.stringify(payload))), { compressed: true, endStream: true });
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** A fetch stub that answers GetUserJwt and then serves the supplied chat frames. */
function stubFetch(chatFrames: Uint8Array[], onChat?: (init: RequestInit & { url: string }) => void) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url.includes("GetUserJwt")) {
      const e = new ProtoEncoder();
      e.string(1, "test-user-jwt");
      return new Response(e.finish(), { status: 200, headers: { "content-type": "application/proto" } });
    }
    if (url.includes("GetChatMessage")) {
      onChat?.({ ...(init ?? {}), url });
      return new Response(streamOf(...chatFrames), { status: 200, headers: { "content-type": "application/connect+proto" } });
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof globalThis.fetch;
  return { impl, calls };
}

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "devin-http",
    baseUrl: "https://server.codeium.com",
    apiKey: "devin-session-token$test-key",
    defaultMaxOutputTokens: 4096,
    ...overrides,
  } as OcxProviderConfig;
}

function request(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return {
    modelId: "swe-2",
    stream: true,
    options: {},
    context: {
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
    },
    ...overrides,
  } as OcxParsedRequest;
}

async function runTurn(
  parsed: OcxParsedRequest,
  chatFrames: Uint8Array[],
  deps: Parameters<typeof runDevinHttpTurn>[4] = {},
  prov: OcxProviderConfig = provider(),
): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  // The caller supplies the frames; the default deps carry a stub fetch that serves exactly those.
  await runDevinHttpTurn(
    prov,
    parsed,
    { headers: new Headers() } as never,
    event => events.push(event),
    { fetch: stubFetch(chatFrames).impl, ...deps },
  );
  return events;
}

describe("devin-http credential resolution", () => {
  test("an explicitly configured key wins over the stored credential", () => {
    expect(resolveDevinToken(provider({ apiKey: "configured-key" }))).toBe("devin-session-token$configured-key");
  });

  test("the caller's Authorization header never participates in resolution", () => {
    // The proxy's auth layer rewrites that header to the caller's proxy identity before the
    // adapter sees it (observed live: a loopback bearer arrived as a 1761-char eyJ JWT), so
    // forwarding it upstream 401s confusingly. Resolution reads config and disk only; the
    // turn-level wire test below pins it against actual request bytes.
    expect(resolveDevinToken(provider({ apiKey: "configured-key" }))).toBe("devin-session-token$configured-key");
  });

  test("the session-token prefix is added when missing and never doubled", () => {
    expect(normalizeDevinToken("raw")).toBe("devin-session-token$raw");
    expect(normalizeDevinToken("devin-session-token$raw")).toBe("devin-session-token$raw");
    expect(normalizeDevinToken("  devin-session-token$raw  ")).toBe("devin-session-token$raw");
  });

  test("a missing credential is a configuration error even with an Authorization header present", () => {
    // No configured key, nothing on disk: the header must not become a credential, so this throws
    // (mapped to a 401 missing_credential by the turn) instead of forwarding junk upstream.
    expect(() => resolveDevinToken(provider({ apiKey: undefined }))).toThrow(DevinMissingCredentialError);
  });

  test("the turn sends the DISK credential even when the request carries an Authorization header", async () => {
    // Regression for the live-observed 401: with an Authorization header present, the wire request
    // must carry the credentials.toml value, never anything derived from the header.
    const originalHome = process.env.HOME;
    const tmp = mkdtempSync(join(tmpdir(), "devin-wire-cred-"));
    const credDir = join(tmp, ".local", "share", "devin");
    mkdirSync(credDir, { recursive: true });
    writeFileSync(join(credDir, "credentials.toml"), 'windsurf_api_key = "devin-session-token$wire-cred"\n');
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      const e = new ProtoEncoder();
      e.string(1, "test-user-jwt");
      return new Response(e.finish(), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    try {
      process.env.HOME = tmp;
      delete process.env.XDG_DATA_HOME;
      delete process.env.DEVIN_CONFIG_DIR;
      await runTurn(
        request(),
        [chatResponseFrame(e => e.string(3, "ok"))],
        { fetch: impl },
        provider({ apiKey: undefined }),
      );
      const auth = calls.find(c => c.url.includes("GetUserJwt"))!;
      // Decode Metadata (field 1) straight from the request bytes, then its api_key (field 3).
      const bytes = new Uint8Array(auth.init.body as ArrayBuffer);
      const wrapper = new ProtoDecoder(bytes);
      let inner: Uint8Array | undefined;
      while (!wrapper.done) {
        const { field: f, wire } = wrapper.readTag();
        if (f === 1 && wire === 2) inner = wrapper.readBytes();
        else wrapper.skip(wire);
      }
      expect(textField(inner!, 3)).toBe("devin-session-token$wire-cred");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("the credential file parser reads only the windsurf key and tolerates surrounding text", () => {
    const text = [
      "# a comment",
      "api_server_url = \"https://server.codeium.com\"",
      "windsurf_api_key = \"devin-session-token$abc\"",
      "other = \"ignored\"",
    ].join("\n");
    expect(readDevinCredentialFile(writeTemp(text))).toBe("devin-session-token$abc");
  });

  test("an unreadable credential file resolves to empty rather than throwing", () => {
    expect(readDevinCredentialFile("/nonexistent/path/credentials.toml")).toBe("");
  });

  test("credential file candidates honour the CLI's own config-dir override first", () => {
    const candidates = devinCredentialFileCandidates({ DEVIN_CONFIG_DIR: "/custom/devin" } as NodeJS.ProcessEnv);
    expect(candidates[0]).toBe("/custom/devin/credentials.toml");
  });
});

describe("devin-http request projection", () => {
  test("the system prompt plus developer messages become the prompt in order", () => {
    const parsed = request({
      context: {
        systemPrompt: ["line one", "line two"],
        messages: [
          { role: "developer", content: "dev note", timestamp: 0 },
          { role: "user", content: "hi", timestamp: 0 },
        ],
      },
    } as Partial<OcxParsedRequest>);
    expect(collectSystemPrompt(parsed)).toBe("line one\n\nline two\n\ndev note");
  });

  test("developer messages are not replayed as separate prompts", () => {
    const parsed = request({
      context: {
        systemPrompt: ["sys"],
        messages: [
          { role: "developer", content: "dev", timestamp: 0 },
          { role: "user", content: "hi", timestamp: 0 },
        ],
      },
    } as Partial<OcxParsedRequest>);
    const prompts = projectDevinPrompts(parsed.context.messages, "cascade-1");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.source).toBe(1); // USER
  });

  test("assistant turns replay as SYSTEM, which is the API's only option for model output", () => {
    const prompts = projectDevinPrompts([
      { role: "user", content: "q", timestamp: 0 },
      { role: "assistant", content: [{ type: "text", text: "a" }], timestamp: 0 },
    ], "cascade-1");
    expect(prompts[1]!.source).toBe(2); // SYSTEM
    expect(prompts[1]!.messageId.startsWith("bot-")).toBe(true);
    expect(prompts[1]!.prompt).toBe("a");
  });

  test("assistant tool calls replay with their arguments as a JSON string", () => {
    const prompts = projectDevinPrompts([
      { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "get_weather", arguments: { city: "Tokyo" } }], timestamp: 0 },
    ], "cascade-1");
    expect(prompts[0]!.toolCalls).toEqual([{ id: "c1", name: "get_weather", argumentsJson: '{"city":"Tokyo"}' }]);
  });

  test("tool results carry their call id and error flag", () => {
    const prompts = projectDevinPrompts([
      { role: "toolResult", toolCallId: "c1", toolName: "get_weather", content: "sunny", isError: true, timestamp: 0 },
    ], "cascade-1");
    expect(prompts[0]!.source).toBe(4); // TOOL
    expect(prompts[0]!.toolCallId).toBe("c1");
    expect(prompts[0]!.toolResultIsError).toBe(true);
  });

  test("message ids are deterministic for the same conversation so a retry keeps the cache warm", () => {
    const messages = [{ role: "user" as const, content: "q", timestamp: 0 }];
    const first = projectDevinPrompts(messages, "cascade-1");
    const second = projectDevinPrompts(messages, "cascade-1");
    expect(first[0]!.messageId).toBe(second[0]!.messageId);
    // A different conversation must not collide.
    expect(projectDevinPrompts(messages, "cascade-2")[0]!.messageId).not.toBe(first[0]!.messageId);
  });

  test("an inline data URL becomes an image part; a remote URL is dropped, never inlined as text", () => {
    const prompts = projectDevinPrompts([{
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", imageUrl: "data:image/png;base64,AAAA" },
        { type: "image", imageUrl: "https://example.com/a.png" },
      ],
      timestamp: 0,
    }], "cascade-1");
    expect(prompts[0]!.images).toEqual([{ mimeType: "image/png", base64Data: "AAAA" }]);
  });

  test("tools serialize with a pre-stringified schema, since the wire field is a string", () => {
    const tools = toDevinToolDefinitions([{
      name: "get_weather",
      description: "Get weather",
      parameters: { type: "object", properties: { city: { type: "string" } } },
      strict: true,
    }]);
    expect(tools).toEqual([{
      name: "get_weather",
      description: "Get weather",
      jsonSchemaString: JSON.stringify({ type: "object", properties: { city: { type: "string" } } }),
      strict: true,
    }]);
  });

  test("an absent tool list yields no tool definitions", () => {
    expect(toDevinToolDefinitions(undefined)).toEqual([]);
    expect(toDevinToolDefinitions([])).toEqual([]);
  });
});

describe("devin-http completion configuration", () => {
  test("a requested temperature of 0 is clamped, because proto3 would drop it and the server rejects the omission", () => {
    const config = toCompletionConfiguration(request({ options: { temperature: 0 } } as Partial<OcxParsedRequest>));
    expect(config.temperature).toBeGreaterThan(0);
    expect(config.firstTemperature).toBe(config.temperature);
  });

  test("an absent temperature uses the provider default rather than zero", () => {
    expect(toCompletionConfiguration(request()).temperature).toBeGreaterThan(0);
  });

  test("an explicit temperature is forwarded unchanged", () => {
    expect(toCompletionConfiguration(request({ options: { temperature: 0.9 } } as Partial<OcxParsedRequest>)).temperature).toBe(0.9);
  });

  test("an out-of-range top_p falls back to the default instead of being forwarded", () => {
    expect(toCompletionConfiguration(request({ options: { topP: 5 } } as Partial<OcxParsedRequest>)).topP).toBe(1);
    expect(toCompletionConfiguration(request({ options: { topP: 0 } } as Partial<OcxParsedRequest>)).topP).toBe(1);
  });

  test("stop sequences are appended to the turn sentinels, not substituted for them", () => {
    const config = toCompletionConfiguration(request({ options: { stopSequences: ["STOP"] } } as Partial<OcxParsedRequest>));
    expect(config.stopPatterns).toContain("STOP");
    // Without the USER/ASSISTANT sentinels the model continues the transcript for the caller.
    expect(config.stopPatterns.some(p => p.includes("USER:"))).toBe(true);
    expect(config.stopPatterns.some(p => p.includes("ASSISTANT:"))).toBe(true);
  });

  test("the token budget follows the request and falls back when unset", () => {
    expect(toCompletionConfiguration(request({ options: { maxOutputTokens: 123 } } as Partial<OcxParsedRequest>)).maxTokens).toBe(123n);
    expect(toCompletionConfiguration(request()).maxTokens).toBeGreaterThan(0n);
  });
});

describe("devin-http model selection", () => {
  test("an effort selects the exact advertised uid", () => {
    expect(resolveWireUid("swe-2", "high")).toBe("swe-2-high");
    expect(resolveWireUid("claude-opus-5", "max")).toBe("claude-opus-5-max");
  });

  test("no effort uses the seed's default rung instead of the bare id, which the server rejects", () => {
    // Verified live: `swe-2` and `claude-opus-5` fail with permission_denied, while their rungs
    // succeed. Sending the bare id would 4xx on every turn.
    expect(resolveWireUid("swe-2")).toBe("swe-2-high");
    expect(resolveWireUid("claude-opus-5")).toBe("claude-opus-5-medium");
  });

  test("a model with a bare uid sends the bare uid", () => {
    expect(resolveWireUid("claude-opus-4-6")).toBe("claude-opus-4-6");
  });

  test("an unknown model is forwarded verbatim so the server reports its own error", () => {
    // The seed is a snapshot; a user's account may have a model this build has never seen, and
    // inventing a local \"not found\" would be wrong.
    expect(resolveWireUid("brand-new-model", "high")).toBe("brand-new-model-high");
    expect(resolveWireUid("brand-new-model")).toBe("brand-new-model");
  });

  test("an axis model resolves through its own ladder", () => {
    expect(resolveWireUid("claude-opus-5-fast", "high")).toBe("claude-opus-5-high-fast");
    expect(resolveWireUid("swe-1-7-lightning", "medium")).toBe("swe-1-7-lightning-medium");
  });
});

describe("devin-http stop reason mapping", () => {
  test("the tool terminal maps to tool_calls", () => {
    expect(stopReasonToDevinStopReason(StopReason.FUNCTION_CALL, false)).toBe("tool_calls");
    expect(stopReasonToDevinStopReason(StopReason.UNSPECIFIED, true)).toBe("tool_calls");
  });

  test("MAX_TOKENS maps to length and everything else to stop", () => {
    expect(stopReasonToDevinStopReason(StopReason.MAX_TOKENS, false)).toBe("length");
    expect(stopReasonToDevinStopReason(2, false)).toBe("stop");
    expect(stopReasonToDevinStopReason(StopReason.UNSPECIFIED, false)).toBe("stop");
  });
});

describe("devin-http turn event mapping", () => {
  test("text and thinking deltas stream through as separate events", async () => {
    const events = await runTurn(request(), [
      chatResponseFrame(e => e.string(9, "think")),
      chatResponseFrame(e => e.string(3, "hello")),
    ]);
    expect(events.filter(e => e.type === "thinking_delta")).toEqual([{ type: "thinking_delta", thinking: "think" }]);
    expect(events.filter(e => e.type === "text_delta")).toEqual([{ type: "text_delta", text: "hello" }]);
    expect(events.at(-1)!.type).toBe("done");
  });

  test("thinking is emitted before text so the reasoning part precedes the message", async () => {
    // The Responses envelope is order-sensitive: a thinking block opened after text would produce
    // an invalid item sequence.
    const events = await runTurn(request(), [
      chatResponseFrame(e => { e.string(9, "t"); e.string(3, "x"); }),
    ]);
    const order = events.map(e => e.type).filter(t => t === "thinking_delta" || t === "text_delta");
    expect(order).toEqual(["thinking_delta", "text_delta"]);
  });

  test("trailing thinking after text is swallowed — it breaks the Responses item order", async () => {
    // Observed live on swe-2: the thinking block (with signature) arrives AFTER the answer text —
    // it is forward-planning scratch. Emitting it opened a reasoning item at the message's output
    // index and the chat-completions translator rejected the whole stream (invalid_refusal).
    const events = await runTurn(request(), [
      chatResponseFrame(e => e.string(3, "pong")),
      chatResponseFrame(e => { e.string(9, "plan next turn"); e.string(10, "sig-blob"); }),
    ]);
    expect(events.filter(e => e.type === "thinking_delta")).toHaveLength(0);
    expect(events.filter(e => e.type === "thinking_signature")).toHaveLength(0);
    expect(events.filter(e => e.type === "text_delta")).toEqual([{ type: "text_delta", text: "pong" }]);
    expect(events.at(-1)!.type).toBe("done");
  });

  test("leading thinking before any text still streams through", async () => {
    const events = await runTurn(request(), [
      chatResponseFrame(e => e.string(9, "preamble")),
      chatResponseFrame(e => e.string(10, "sig")),
      chatResponseFrame(e => e.string(3, "answer")),
    ]);
    expect(events.filter(e => e.type === "thinking_delta")).toEqual([{ type: "thinking_delta", thinking: "preamble" }]);
    expect(events.filter(e => e.type === "thinking_signature")).toEqual([{ type: "thinking_signature", signature: "sig" }]);
    expect(events.filter(e => e.type === "text_delta")).toEqual([{ type: "text_delta", text: "answer" }]);
  });

  test("a thinking signature rides its own event", async () => {
    const events = await runTurn(request(), [
      chatResponseFrame(e => { e.string(9, "t"); e.string(10, "sig"); }),
    ]);
    expect(events).toContainEqual({ type: "thinking_signature", signature: "sig" });
  });

  test("a COMPLETE tool call emits start, delta, and end exactly once", async () => {
    // One shape the server uses: everything in a single frame (observed on swe-1-7-lightning).
    const events = await runTurn(request(), [
      chatResponseFrame(e => e.message(6, sub => {
        sub.string(1, "functions.get_weather:0");
        sub.string(2, "get_weather");
        sub.string(3, '{"city":"Tokyo"}');
      })),
      chatResponseFrame(e => e.uint32(5, StopReason.FUNCTION_CALL)),
    ]);
    expect(events.filter(e => e.type === "tool_call_start")).toEqual([
      { type: "tool_call_start", id: "functions.get_weather:0", name: "get_weather" },
    ]);
    expect(events.filter(e => e.type === "tool_call_delta")).toEqual([
      { type: "tool_call_delta", arguments: '{"city":"Tokyo"}' },
    ]);
    expect(events.filter(e => e.type === "tool_call_end")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_calls" });
  });

  test("a FRAGMENTED tool call assembles into one call with concatenated arguments", async () => {
    // The other shape (observed on swe-2-high): a frame with an id opens the call, then frames
    // with EMPTY id/name each append a slice. Reading each frame as its own call would emit six
    // empty-named calls instead of one correct call.
    const events = await runTurn(request(), [
      // Open the call with no arguments yet.
      chatResponseFrame(e => e.message(6, sub => { sub.string(1, "get_weather_0"); sub.string(2, "get_weather"); })),
      // Include the exact fragmentation the live service produced.
      ...["{", '"city": "', "Tok", "yo", '"', "}"].map(fragment =>
        chatResponseFrame(e => e.message(6, sub => sub.string(3, fragment)))),
      chatResponseFrame(e => e.uint32(5, StopReason.FUNCTION_CALL)),
    ]);

    expect(events.filter(e => e.type === "tool_call_start")).toEqual([
      { type: "tool_call_start", id: "get_weather_0", name: "get_weather" },
    ]);
    const assembled = events.filter(e => e.type === "tool_call_delta")
      .map(e => (e as { arguments: string }).arguments).join("");
    expect(assembled).toBe('{"city": "Tokyo"}');
    expect(JSON.parse(assembled)).toEqual({ city: "Tokyo" });
    // Exactly one end, not one per fragment.
    expect(events.filter(e => e.type === "tool_call_end")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_calls" });
  });

  test("a second call's id closes the first, so parallel calls each get one end", async () => {
    const events = await runTurn(request(), [
      chatResponseFrame(e => e.message(6, sub => { sub.string(1, "call_a"); sub.string(2, "tool_a"); sub.string(3, '{"x":'); })),
      chatResponseFrame(e => e.message(6, sub => sub.string(3, "1}"))),
      chatResponseFrame(e => e.message(6, sub => { sub.string(1, "call_b"); sub.string(2, "tool_b"); sub.string(3, '{"y":2}'); })),
      chatResponseFrame(e => e.uint32(5, StopReason.FUNCTION_CALL)),
    ]);
    expect(events.filter(e => e.type === "tool_call_start").map(e => (e as { id: string }).id)).toEqual(["call_a", "call_b"]);
    expect(events.filter(e => e.type === "tool_call_end")).toHaveLength(2);
    // The fragment after the open landed on call_a, not on call_b.
    const argsForA = events.filter(e => e.type === "tool_call_delta").slice(0, 2).map(e => (e as { arguments: string }).arguments).join("");
    expect(argsForA).toBe('{"x":1}');
  });

  test("a fragment with no open call is dropped rather than attached to the wrong one", async () => {
    const events = await runTurn(request(), [
      chatResponseFrame(e => e.message(6, sub => sub.string(3, "orphan"))),
      chatResponseFrame(e => e.uint32(5, StopReason.FUNCTION_CALL)),
    ]);
    expect(events.filter(e => e.type === "tool_call_delta")).toHaveLength(0);
    expect(events.filter(e => e.type === "tool_call_start")).toHaveLength(0);
  });

  test("an open call is closed even when the stream ends without a stop frame", async () => {
    // An unterminated tool-call item is rejected by the Responses bridge, so the terminal must
    // always close what was opened.
    const events = await runTurn(request(), [
      chatResponseFrame(e => e.message(6, sub => { sub.string(1, "call_a"); sub.string(2, "tool_a"); sub.string(3, "{}"); })),
    ]);
    expect(events.filter(e => e.type === "tool_call_end")).toHaveLength(1);
    expect(events.at(-1)!.type).toBe("done");
  });

  test("two complete calls in one frame each get their own triple, in order", async () => {
    const events = await runTurn(request(), [
      chatResponseFrame(e => {
        for (const [i, city] of ["Tokyo", "Paris"].entries()) {
          e.message(6, sub => {
            sub.string(1, `functions.get_weather:${i}`);
            sub.string(2, "get_weather");
            sub.string(3, JSON.stringify({ city }));
          });
        }
      }),
      chatResponseFrame(e => e.uint32(5, StopReason.FUNCTION_CALL)),
    ]);
    expect(events.filter(e => e.type === "tool_call_start").map(e => (e as { id: string }).id))
      .toEqual(["functions.get_weather:0", "functions.get_weather:1"]);
    expect(events.filter(e => e.type === "tool_call_end")).toHaveLength(2);
  });

  test("only the last non-zero usage frame is reported", async () => {
    // Nearly every frame carries a zeroed usage message; taking the last frame would report zero.
    const events = await runTurn(request(), [
      chatResponseFrame(e => e.message(7, sub => sub.uint64(2, 0n))),
      chatResponseFrame(e => e.message(7, sub => { sub.uint64(2, 136n); sub.uint64(3, 58n); sub.uint64(5, 256n); })),
    ]);
    const done = events.at(-1) as Extract<AdapterEvent, { type: "done" }>;
    expect(done.usage).toMatchObject({
      inputTokens: 136,
      outputTokens: 58,
      cachedInputTokens: 256,
      cacheReadInputTokens: 256,
    });
  });

  test("a zero-only usage stream reports no usage rather than a fabricated zero", async () => {
    const events = await runTurn(request(), [
      chatResponseFrame(e => e.message(7, sub => sub.uint64(2, 0n))),
    ]);
    expect((events.at(-1) as Extract<AdapterEvent, { type: "done" }>).usage).toBeUndefined();
  });

  test("cache write tokens surface as cache creation input tokens", async () => {
    const events = await runTurn(request(), [
      chatResponseFrame(e => e.message(7, sub => { sub.uint64(2, 10n); sub.uint64(4, 99n); })),
    ]);
    expect((events.at(-1) as Extract<AdapterEvent, { type: "done" }>).usage).toMatchObject({
      cacheCreationInputTokens: 99,
    });
  });

  test("MAX_TOKENS becomes stopReason length", async () => {
    const events = await runTurn(request(), [
      chatResponseFrame(e => e.uint32(5, StopReason.MAX_TOKENS)),
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "length" });
  });

  test("an end-stream error is terminal, reports its code, and is not retryable for a bad argument", async () => {
    const events = await runTurn(request(), [
      chatResponseFrame(e => e.string(3, "partial")),
      endStreamFrame({ error: { code: "invalid_argument", message: "bad request" } }),
    ]);
    const errors = events.filter(e => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ type: "error", status: 502, code: "invalid_argument", retryable: false });
    // The partial content before the failure is still delivered.
    expect(events.some(e => e.type === "text_delta")).toBe(true);
    expect(events.filter(e => e.type === "done")).toHaveLength(0);
  });

  test("a resource_exhausted end-stream error maps to a retryable 429", async () => {
    const events = await runTurn(request(), [
      endStreamFrame({ error: { code: "resource_exhausted", message: "quota" } }),
    ]);
    expect(events[0]).toMatchObject({ type: "error", status: 429, errorType: "rate_limit_error", retryable: true });
  });

  test("a clean end-stream trailer is not an error", async () => {
    const events = await runTurn(request(), [
      chatResponseFrame(e => e.string(3, "ok")),
      endStreamFrame({}),
    ]);
    expect(events.filter(e => e.type === "error")).toHaveLength(0);
    expect(events.filter(e => e.type === "done")).toHaveLength(1);
  });

  test("exactly one terminal event is emitted even when the stream errors after content", async () => {
    const events = await runTurn(request(), [
      chatResponseFrame(e => e.string(3, "x")),
      endStreamFrame({ error: { code: "permission_denied", message: "no" } }),
    ]);
    const terminals = events.filter(e => e.type === "done" || e.type === "error" || e.type === "incomplete");
    expect(terminals).toHaveLength(1);
  });

  test("frames split across chunks are reassembled", async () => {
    // A real stream splits frames at arbitrary boundaries; the reader must buffer partials.
    const frame = chatResponseFrame(e => e.string(3, "reassembled"));
    const events = await runTurn(request(), [
      frame.subarray(0, 3),
      frame.subarray(3),
    ]);
    expect(events.filter(e => e.type === "text_delta")).toEqual([{ type: "text_delta", text: "reassembled" }]);
  });

  test("an abort before start is terminal and retryable-free", async () => {
    const controller = new AbortController();
    controller.abort();
    const events: AdapterEvent[] = [];
    await runDevinHttpTurn(provider(), request(), { headers: new Headers(), abortSignal: controller.signal } as never, e => events.push(e), {});
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", retryable: false });
  });

  test("the room's end-stream trailer is treated as success not as a message", async () => {
    // An end-stream frame carries JSON, not protobuf; decoding it as a message would corrupt state.
    const events = await runTurn(request(), [endStreamFrame({})]);
    expect(events.at(-1)!.type).toBe("done");
  });
});

describe("devin-http client request shapes", () => {
  test("the JWT handshake sends the metadata envelope with a proto content type", async () => {
    const { impl, calls } = stubFetch([]);
    await streamDevinChat({
      apiKey: "devin-session-token$k",
      userJwt: "jwt",
      modelUid: "swe-2-high",
      systemPrompt: "",
      request: {
        chatMessagePrompts: [],
        configuration: { numCompletions: 1n, maxTokens: 8n, maxNewlines: 8n, temperature: 0.4, firstTemperature: 0.4, topK: 1n, topP: 1, stopPatterns: [], fimEotProbThreshold: 1 },
        tools: [],
        disableParallelToolCalls: false,
        toolChoice: { optionName: "auto" },
        cascadeId: "c",
        executionId: "e",
      },
    }, { fetch: impl }).next();
    const chat = calls.find(c => c.url.includes("GetChatMessage"))!;
    expect(chat.init.headers).toMatchObject({
      "content-type": "application/connect+proto",
      "connect-protocol-version": "1",
      "connect-content-encoding": "gzip",
    });
    expect(chat.url).toBe("https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage");
  });

  test("the metadata carries the Windsurf identity the server expects", () => {
    const metadata = buildDevinMetadata("devin-session-token$k", "jwt-value");
    expect(metadata.ideName).toBe("windsurf");
    expect(metadata.extensionName).toBe("windsurf");
    expect(metadata.apiKey).toBe("devin-session-token$k");
    expect(metadata.userJwt).toBe("jwt-value");
  });

  test("a non-JSON error body is surfaced as text rather than lost", async () => {
    const impl = (async () => new Response("server exploded", { status: 500 })) as unknown as typeof globalThis.fetch;
    const events = await runTurn(request(), [], { fetch: impl });
    expect(events[0]).toMatchObject({ type: "error", status: 500 });
    expect((events[0] as { message: string }).message).toContain("server exploded");
  });

  test("an authentication failure is not retryable, because repeating it changes nothing", async () => {
    const impl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("GetUserJwt")) return new Response("nope", { status: 401 });
      throw new Error("should not reach chat");
    }) as unknown as typeof globalThis.fetch;
    const events = await runTurn(request(), [], { fetch: impl });
    expect(events[0]).toMatchObject({ type: "error", retryable: false });
  });
});

describe("devin-http adapter surface", () => {
  test("the adapter disables the fetch/parseStream path and owns the turn", () => {
    const adapter = createDevinHttpAdapter(provider());
    expect(adapter.name).toBe("devin-http");
    expect(typeof adapter.runTurn).toBe("function");
    // A JSON buildRequest body would be a lie for a gzipped protobuf frame transport.
    const built = adapter.buildRequest(request(), {} as never) as { body: string };
    expect(built.body).toBe("");
  });

  test("the adapter streams an error rather than silently succeeding on the disabled path", async () => {
    const adapter = createDevinHttpAdapter(provider());
    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(new Response(), { consume: (n: number) => n } as never)) events.push(event);
    expect(events[0]).toMatchObject({ type: "error" });
  });
});

// ─── helpers ────────────────────────────────────────────────────────────────

function writeTemp(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "devin-cred-"));
  const file = join(dir, "credentials.toml");
  writeFileSync(file, contents);
  return file;
}
