import { beforeEach, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import type { AdapterEvent, OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import {
  detectRepeatedTail,
  detectThinkingRepetition,
  detectToolCallStreak,
  DevinLoopGuard,
  LOOP_FUSE_STREAK,
  LOOP_GUARD_EMPTY_FAIL,
  LOOP_GUARD_EMPTY_STEER,
  LOOP_GUARD_FUSE_TRIPS_FAIL,
  loopFuseSteeringMessage,
  resetDevinLoopGuard,
} from "../../src/adapters/devin-http/loop-fuse";
import { projectDevinPrompts, runDevinHttpTurn } from "../../src/adapters/devin-http/turn";
import { ChatMessageSource, ProtoDecoder, ProtoEncoder } from "../../src/adapters/devin-http/proto";
import { decodeConnectFrame, encodeConnectFrame } from "../../src/adapters/connect-framing";
import { resetDevinSessionTracking } from "../../src/adapters/devin-http/session-identity";

function user(text: string): OcxMessage {
  return { role: "user", content: text, timestamp: 0 };
}

function assistantCall(id: string, command: string): OcxMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
    timestamp: 0,
  };
}

function assistantText(text: string): OcxMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: 0 };
}

function toolResult(id: string, text: string): OcxMessage {
  return { role: "toolResult", toolCallId: id, toolName: "bash", content: text, isError: false, timestamp: 0 };
}

function nowrapLoop(n: number): OcxMessage[] {
  const messages: OcxMessage[] = [user("fix wrapping")];
  const variants = [
    `cd D:/document/j-agent && grep -rn "whiteSpace" packages/app/src`,
    `cd D:/document/j-agent && grep -rn "nowrap" packages/app/src/plane`,
    `cd D:/document/j-agent/.refs/gpuix && grep -rn "whitespace_nowrap" packages/native/src`,
    `cd D:/document/j-agent && grep -n "white_space" packages/app/src/plane/WorkspaceList.tsx`,
    `cd D:/document/j-agent/.refs/gpuix && sed -n '5120,5160p' packages/native/src/style.rs`,
    `cd D:/document/j-agent && grep -rn "whiteSpace" .refs/gpuix/packages/react/src`,
  ];
  for (let i = 0; i < n; i++) {
    const id = `c${i}`;
    messages.push(assistantCall(id, variants[i % variants.length]!));
    messages.push(toolResult(id, "no matches"));
  }
  return messages;
}

describe("devin-http loop fuse", () => {
  test("a short run of similar greps does not trip", () => {
    expect(detectToolCallStreak(nowrapLoop(LOOP_FUSE_STREAK - 1))).toBeNull();
  });

  test("six similar nowrap/whiteSpace greps trip, even when the command wording drifts", () => {
    const trip = detectToolCallStreak(nowrapLoop(LOOP_FUSE_STREAK));
    expect(trip).not.toBeNull();
    expect(trip!.streak).toBe(LOOP_FUSE_STREAK);
    expect(trip!.family).toContain("bash");
  });

  test("a new user message resets the streak", () => {
    const messages = [...nowrapLoop(LOOP_FUSE_STREAK), user("try something else")];
    expect(detectToolCallStreak(messages)).toBeNull();
  });

  test("a text-only assistant turn resets the streak", () => {
    const messages = [...nowrapLoop(LOOP_FUSE_STREAK), assistantText("I will change the code now.")];
    expect(detectToolCallStreak(messages)).toBeNull();
  });

  test("unrelated tools in a row do not trip", () => {
    const messages: OcxMessage[] = [user("mix")];
    for (let i = 0; i < LOOP_FUSE_STREAK; i++) {
      const id = `c${i}`;
      messages.push({
        role: "assistant",
        content: [{ type: "toolCall", id, name: "bash", arguments: { command: i % 2 === 0 ? "git status" : "bun test tests/foo.test.ts" } }],
        timestamp: 0,
      });
      messages.push(toolResult(id, "ok"));
    }
    expect(detectToolCallStreak(messages)).toBeNull();
  });

  test("similar calls with different results are progress, not a loop", () => {
    // The observed false positive: an agent working in one directory alternates vitest, cat,
    // and grep — same path tokens, different operations, different output each time.
    const messages: OcxMessage[] = [user("check the plugin")];
    const steps: Array<[string, string]> = [
      [`cd apps/claw-plugin && npx vitest run tests/unit/domain/workflow/`, "Tests 345 passed"],
      [`cd apps/claw-plugin && npx vitest run`, "Tests 206 failed | 806 passed"],
      [`cd apps/claw-plugin && npx vitest run tests/unit/runtime/createClawRuntime.test.ts`, "ReferenceError: history is not defined"],
      [`cd apps/claw-plugin && grep -E '"test"' package.json`, '"test": "vitest run --root ../.."'],
      [`cd apps/claw-plugin && cat vitest.config.ts`, "export default defineConfig({"],
      [`cd apps/claw-plugin && npx vitest run --root ../.. --config vitest.config.ts apps/claw-plugin/tests`, "Tests 1136 passed"],
    ];
    for (const [command, output] of steps) {
      const id = `p${messages.length}`;
      messages.push(assistantCall(id, command));
      messages.push(toolResult(id, output));
    }
    expect(detectToolCallStreak(messages)).toBeNull();
  });

  test("the same search returning the same empty result still trips", () => {
    const messages: OcxMessage[] = [user("find it")];
    for (let i = 0; i < LOOP_FUSE_STREAK; i++) {
      const id = `s${i}`;
      messages.push(assistantCall(id, `grep -rn "needle" src/dir${i % 2}`));
      messages.push(toolResult(id, "no matches"));
    }
    expect(detectToolCallStreak(messages)).not.toBeNull();
  });

  test("the steering prompt names the family and forbids repeating it", () => {
    const text = loopFuseSteeringMessage({ family: "bash:nowrap,whitespace", streak: 8 });
    expect(text).toContain("[opencodex loop fuse]");
    expect(text).toContain("8 similar");
    expect(text).toContain("Do not repeat");
  });
});

describe("DevinLoopGuard state machine", () => {
  beforeEach(() => resetDevinLoopGuard());

  test("consecutive empty turns steer, then hard-fail at the budget", () => {
    const history = [user("hi")];
    // Turns below the steering threshold pass through untouched.
    for (let i = 0; i < LOOP_GUARD_EMPTY_STEER; i++) {
      const guard = new DevinLoopGuard("c1");
      expect(guard.evaluate(history).kind).toBe("none");
      guard.recordOutcome(false);
    }

    for (let streak = LOOP_GUARD_EMPTY_STEER; streak < LOOP_GUARD_EMPTY_FAIL; streak++) {
      const guard = new DevinLoopGuard("c1");
      const action = guard.evaluate(history);
      expect(action.kind).toBe("steer");
      if (action.kind === "steer") {
        expect(action.reason).toBe("empty-completion");
        expect(action.message).toContain("[opencodex loop guard]");
      }
      guard.recordOutcome(false);
    }

    const exhausted = new DevinLoopGuard("c1");
    const action = exhausted.evaluate(history);
    expect(action.kind).toBe("fail");
    if (action.kind === "fail") expect(action.reason).toBe("empty-completion");
  });

  test("a turn with output resets the empty streak", () => {
    const history = [user("hi")];
    const t1 = new DevinLoopGuard("c2");
    t1.evaluate(history);
    t1.recordOutcome(false);
    const t2 = new DevinLoopGuard("c2");
    t2.evaluate(history);
    t2.recordOutcome(true);
    const t3 = new DevinLoopGuard("c2");
    expect(t3.evaluate(history).kind).toBe("none");
  });

  test("repeated fuse trips escalate from steering to a hard fail", () => {
    const history = nowrapLoop(LOOP_FUSE_STREAK);
    for (let trip = 1; trip < LOOP_GUARD_FUSE_TRIPS_FAIL; trip++) {
      const guard = new DevinLoopGuard("c3");
      const action = guard.evaluate(history);
      expect(action.kind).toBe("steer");
      if (action.kind === "steer") expect(action.reason).toBe("tool-call-streak");
      // The model ignored the steering and produced more of the same loop.
      guard.recordOutcome(true);
    }
    const guard = new DevinLoopGuard("c3");
    const action = guard.evaluate(history);
    expect(action.kind).toBe("fail");
    if (action.kind === "fail") expect(action.reason).toBe("tool-call-streak");
  });

  test("a clean turn after a trip resets the escalation counter", () => {
    const loop = nowrapLoop(LOOP_FUSE_STREAK);
    const t1 = new DevinLoopGuard("c4");
    expect(t1.evaluate(loop).kind).toBe("steer");
    t1.recordOutcome(true);
    // Next turn does not trip (history moved on) and produced output: counter resets.
    const t2 = new DevinLoopGuard("c4");
    expect(t2.evaluate([user("ok")]).kind).toBe("none");
    t2.recordOutcome(true);
    // A later loop starts the escalation from zero again.
    const t3 = new DevinLoopGuard("c4");
    expect(t3.evaluate(loop).kind).toBe("steer");
  });

  test("guard state is scoped per conversation", () => {
    const a = new DevinLoopGuard("ca");
    a.evaluate([user("x")]);
    a.recordOutcome(false);
    a.recordOutcome(false);
    const b = new DevinLoopGuard("cb");
    expect(b.evaluate([user("x")]).kind).toBe("none");
  });

  test("a history ending in repeated thinking steers, then escalates", () => {
    const paragraph = "I'm realizing the city cluster is off-center because the bounding box includes a western lake area. Simply adjusting padding might not be ideal.";
    const thinking = Array.from({ length: 6 }, () => paragraph).join("\n\n");
    const history: OcxMessage[] = [
      user("center the map"),
      { role: "assistant", content: [{ type: "thinking", thinking }], timestamp: 0 },
    ];
    const guard = new DevinLoopGuard("c5");
    const action = guard.evaluate(history);
    expect(action.kind).toBe("steer");
    if (action.kind === "steer") expect(action.reason).toBe("thinking-repetition");
  });
});

describe("repetition detection", () => {
  const paragraph = "I'm realizing the city cluster is off-center because the bounding box includes a western lake area. Simply adjusting padding might not be ideal.";

  test("a paragraph repeated verbatim trips", () => {
    expect(detectRepeatedTail(Array.from({ length: 4 }, () => paragraph).join("\n\n"))).toBe(true);
  });

  test("repetition without paragraph breaks trips on the fixed chunk", () => {
    const block = "same sentence repeated without any paragraph breaks in the middle of it all. ";
    expect(detectRepeatedTail(block.repeat(5))).toBe(true);
  });

  test("varied prose does not trip", () => {
    expect(detectRepeatedTail([paragraph, "A different thought follows here.", "And a third distinct one."].join("\n\n"))).toBe(false);
  });

  test("short text does not trip", () => {
    expect(detectRepeatedTail("loop loop loop")).toBe(false);
  });

  test("detectThinkingRepetition reads the last assistant message", () => {
    const thinking = Array.from({ length: 4 }, () => paragraph).join("\n\n");
    const history: OcxMessage[] = [
      user("x"),
      { role: "assistant", content: [{ type: "thinking", thinking }], timestamp: 0 },
      { role: "toolResult", toolCallId: "t", toolName: "bash", content: "ok", isError: false, timestamp: 0 },
    ];
    expect(detectThinkingRepetition(history)).toBe(true);
    expect(detectThinkingRepetition([user("x"), assistantText("a normal answer")])).toBe(false);
  });
});

describe("devin-http loop fuse on the wire", () => {
  beforeEach(() => {
    resetDevinSessionTracking();
    resetDevinLoopGuard();
  });

  test("a tripped streak appends the steering user prompt to this request then continues", async () => {
    const bodies: Uint8Array[] = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("GetUserJwt")) {
        const e = new ProtoEncoder();
        e.string(1, "jwt");
        return new Response(e.finish(), { status: 200 });
      }
      if (url.includes("GetChatMessage")) {
        bodies.push(new Uint8Array(init?.body as Uint8Array));
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

    const parsed = {
      modelId: "swe-2",
      stream: true,
      options: {},
      context: { messages: nowrapLoop(LOOP_FUSE_STREAK) },
    } as OcxParsedRequest;
    const events: AdapterEvent[] = [];
    await runDevinHttpTurn(
      { adapter: "devin-http", apiKey: "k" } as OcxProviderConfig,
      parsed,
      { headers: new Headers() } as never,
      e => events.push(e),
      { fetch: impl },
    );
    expect(events.at(-1)?.type).toBe("done");
    expect(bodies).toHaveLength(1);

    const { frame } = decodeConnectFrame(bodies[0]!);
    const { gunzipSync } = await import("node:zlib");
    const raw = frame.compressed ? gunzipSync(frame.payload) : frame.payload;
    const d = new ProtoDecoder(raw);
    const prompts: Array<{ source: number; text: string }> = [];
    while (!d.done) {
      const { field, wire } = d.readTag();
      if (field === 3 && wire === 2) {
        const inner = new ProtoDecoder(d.readBytes());
        let source = 0;
        let text = "";
        while (!inner.done) {
          const tag = inner.readTag();
          if (tag.field === 2 && tag.wire === 0) source = Number(inner.readVarint());
          else if (tag.field === 3 && tag.wire === 2) text = new TextDecoder().decode(inner.readBytes());
          else if (tag.wire === 0) inner.readVarint();
          else if (tag.wire === 2) inner.readBytes();
          else inner.skip(tag.wire);
        }
        prompts.push({ source, text });
      } else if (wire === 0) d.readVarint();
      else if (wire === 2) d.readBytes();
      else d.skip(wire);
    }
    const last = prompts.at(-1);
    expect(last?.source).toBe(ChatMessageSource.USER);
    expect(last?.text).toContain("[opencodex loop fuse]");
    expect(last?.text).toContain("similar tool calls");
    // Client-visible history is untouched — injection is request-local.
    expect(parsed.context.messages.at(-1)?.role).not.toBe("user");
    expect(projectDevinPrompts(parsed.context.messages, "x").at(-1)?.prompt).not.toContain("loop fuse");
  });

  test("consecutive empty completions steer, then hard-fail without calling upstream", async () => {
    const bodies: Uint8Array[] = [];
    const impl = mockDevinFetch(bodies, emptyStreamResponse);
    const parsed = {
      modelId: "swe-2",
      stream: true,
      options: {},
      context: { messages: [user("fix it")] },
    } as OcxParsedRequest;

    const run = async () => {
      const events: AdapterEvent[] = [];
      await runDevinHttpTurn(
        { adapter: "devin-http", apiKey: "k" } as OcxProviderConfig,
        parsed,
        { headers: new Headers() } as never,
        e => events.push(e),
        { fetch: impl },
      );
      return events;
    };

    // Turns 1–2: empty completions pass through untouched.
    for (let i = 0; i < LOOP_GUARD_EMPTY_STEER; i++) {
      expect((await run()).at(-1)?.type).toBe("done");
    }
    // Turns 3–4: the guard injects a steering user prompt but still sends the turn.
    for (let i = LOOP_GUARD_EMPTY_STEER; i < LOOP_GUARD_EMPTY_FAIL; i++) {
      expect((await run()).at(-1)?.type).toBe("done");
    }
    const steered = await lastPromptText(bodies.at(-1)!);
    expect(steered.source).toBe(ChatMessageSource.USER);
    expect(steered.text).toContain("[opencodex loop guard]");
    expect(steered.text).toContain("empty");

    // Turn 5: budget exhausted — hard fail, no upstream call.
    const before = bodies.length;
    const events = await run();
    const terminal = events.at(-1);
    expect(terminal?.type).toBe("error");
    if (terminal?.type === "error") {
      expect(terminal.code).toBe("loop_guard");
      expect(terminal.retryable).toBe(false);
    }
    expect(bodies.length).toBe(before);
  });

  test("ignored tool-call steering escalates to a hard fail", async () => {
    const bodies: Uint8Array[] = [];
    const impl = mockDevinFetch(bodies, emptyStreamResponse);
    const parsed = {
      modelId: "swe-2",
      stream: true,
      options: {},
      context: { messages: nowrapLoop(LOOP_FUSE_STREAK) },
    } as OcxParsedRequest;

    for (let i = 1; i < LOOP_GUARD_FUSE_TRIPS_FAIL; i++) {
      const events: AdapterEvent[] = [];
      await runDevinHttpTurn(
        { adapter: "devin-http", apiKey: "k" } as OcxProviderConfig,
        parsed,
        { headers: new Headers() } as never,
        e => events.push(e),
        { fetch: impl },
      );
      expect(events.at(-1)?.type).toBe("done");
    }

    const before = bodies.length;
    const events: AdapterEvent[] = [];
    await runDevinHttpTurn(
      { adapter: "devin-http", apiKey: "k" } as OcxProviderConfig,
      parsed,
      { headers: new Headers() } as never,
      e => events.push(e),
      { fetch: impl },
    );
    const terminal = events.at(-1);
    expect(terminal?.type).toBe("error");
    if (terminal?.type === "error") expect(terminal.code).toBe("loop_guard");
    expect(bodies.length).toBe(before);
  });

  test("a flooding turn is interrupted and auto-continued, failing only when the budget is spent", async () => {
    const bodies: Uint8Array[] = [];
    const impl = mockDevinFetch(bodies, () => toolCallFloodResponse(10));
    const parsed = {
      modelId: "swe-2",
      stream: true,
      options: {},
      context: { messages: [user("go")] },
    } as OcxParsedRequest;
    const events: AdapterEvent[] = [];
    await runDevinHttpTurn(
      { adapter: "devin-http", apiKey: "k" } as OcxProviderConfig,
      parsed,
      { headers: new Headers() } as never,
      e => events.push(e),
      { fetch: impl, maxToolCallsPerTurn: 3, maxContinuationsPerTurn: 1 },
    );
    const terminal = events.at(-1);
    expect(terminal?.type).toBe("error");
    if (terminal?.type === "error") {
      expect(terminal.code).toBe("loop_guard");
      expect(terminal.retryable).toBe(false);
    }
    // Attempt 1 stalled at the 4th call, one continuation was sent and stalled again.
    expect(bodies).toHaveLength(2);
    // The continuation request replays the partial calls and appends the continue prompt.
    const last = await lastPromptText(bodies.at(-1)!);
    expect(last.source).toBe(ChatMessageSource.USER);
    expect(last.text).toContain("[opencodex loop guard]");
    expect(last.text).toContain("Continue from where you stopped");
  });

  test("a stalled turn that recovers on continuation completes normally", async () => {
    const bodies: Uint8Array[] = [];
    let calls = 0;
    const impl = mockDevinFetch(bodies, () => {
      calls++;
      return calls === 1 ? toolCallFloodResponse(10) : emptyStreamResponse();
    });
    const parsed = {
      modelId: "swe-2",
      stream: true,
      options: {},
      context: { messages: [user("go")] },
    } as OcxParsedRequest;
    const events: AdapterEvent[] = [];
    await runDevinHttpTurn(
      { adapter: "devin-http", apiKey: "k" } as OcxProviderConfig,
      parsed,
      { headers: new Headers() } as never,
      e => events.push(e),
      { fetch: impl, maxToolCallsPerTurn: 3 },
    );
    expect(events.at(-1)?.type).toBe("done");
    expect(bodies).toHaveLength(2);
  });

  test("a stream restating one thinking paragraph is interrupted and continued, then fails at the budget", async () => {
    const bodies: Uint8Array[] = [];
    const paragraph = "I'm realizing the city cluster is off-center because the bounding box includes a western lake area. Simply adjusting padding might not be ideal. ";
    const impl = mockDevinFetch(bodies, () => thinkingFloodResponse(paragraph, 8));
    const parsed = {
      modelId: "swe-2",
      stream: true,
      options: {},
      context: { messages: [user("center the map")] },
    } as OcxParsedRequest;
    const events: AdapterEvent[] = [];
    await runDevinHttpTurn(
      { adapter: "devin-http", apiKey: "k" } as OcxProviderConfig,
      parsed,
      { headers: new Headers() } as never,
      e => events.push(e),
      { fetch: impl, maxContinuationsPerTurn: 1 },
    );
    const terminal = events.at(-1);
    expect(terminal?.type).toBe("error");
    if (terminal?.type === "error") {
      expect(terminal.code).toBe("loop_guard");
      expect(terminal.retryable).toBe(false);
    }
    // First generation stalled on repetition; one continuation was sent and stalled again.
    expect(bodies).toHaveLength(2);
  });

  test("a silent stream with no output retries the identical request", async () => {
    const bodies: Uint8Array[] = [];
    let calls = 0;
    const impl = mockDevinFetch(bodies, () => {
      calls++;
      // First attempt: a stream that never produces a frame, tripping the idle abort.
      return calls === 1 ? silentStreamResponse() : emptyStreamResponse();
    });
    const parsed = {
      modelId: "swe-2",
      stream: true,
      options: {},
      context: { messages: [user("go")] },
    } as OcxParsedRequest;
    const events: AdapterEvent[] = [];
    await runDevinHttpTurn(
      { adapter: "devin-http", apiKey: "k" } as OcxProviderConfig,
      parsed,
      { headers: new Headers() } as never,
      e => events.push(e),
      { fetch: impl, upstreamIdleMs: 50 },
    );
    expect(events.at(-1)?.type).toBe("done");
    expect(bodies).toHaveLength(2);
    // Nothing was produced, so the retry carries no continue prompt.
    const last = await lastPromptText(bodies.at(-1)!);
    expect(last.text).not.toContain("loop guard");
  });

  test("a stream that goes silent mid-answer continues with the partial output", async () => {
    const bodies: Uint8Array[] = [];
    let calls = 0;
    const impl = mockDevinFetch(bodies, () => {
      calls++;
      return calls === 1 ? textThenSilentResponse("half an answer") : emptyStreamResponse();
    });
    const parsed = {
      modelId: "swe-2",
      stream: true,
      options: {},
      context: { messages: [user("go")] },
    } as OcxParsedRequest;
    const events: AdapterEvent[] = [];
    await runDevinHttpTurn(
      { adapter: "devin-http", apiKey: "k" } as OcxProviderConfig,
      parsed,
      { headers: new Headers() } as never,
      e => events.push(e),
      { fetch: impl, upstreamIdleMs: 50 },
    );
    expect(events.at(-1)?.type).toBe("done");
    expect(bodies).toHaveLength(2);
    const last = await lastPromptText(bodies.at(-1)!);
    expect(last.source).toBe(ChatMessageSource.USER);
    expect(last.text).toContain("Continue from where you stopped");
  });

  test("persistent silence exhausts the continuation budget and reports the timeout", async () => {
    const bodies: Uint8Array[] = [];
    const impl = mockDevinFetch(bodies, silentStreamResponse);
    const parsed = {
      modelId: "swe-2",
      stream: true,
      options: {},
      context: { messages: [user("go")] },
    } as OcxParsedRequest;
    const events: AdapterEvent[] = [];
    await runDevinHttpTurn(
      { adapter: "devin-http", apiKey: "k" } as OcxProviderConfig,
      parsed,
      { headers: new Headers() } as never,
      e => events.push(e),
      { fetch: impl, upstreamIdleMs: 50, maxContinuationsPerTurn: 1 },
    );
    const terminal = events.at(-1);
    expect(terminal?.type).toBe("error");
    if (terminal?.type === "error") {
      // Transport silence keeps its own error shape — retryable, not a loop_guard verdict.
      expect(terminal.code).toBe("timeout");
      expect(terminal.retryable).toBe(true);
    }
    expect(bodies).toHaveLength(2);
  });
});

// ─── Wire helpers ───────────────────────────────────────────────────────────

function emptyStreamResponse(): Response {
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

/** A stream carrying `n` complete named tool calls, then a clean end. */
function toolCallFloodResponse(n: number): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < n; i++) {
          const e = new ProtoEncoder();
          e.message(6, tc => {
            tc.string(1, `flood-${i}`);
            tc.string(2, "bash");
            tc.string(3, `{"command":"grep x ${i}"}`);
          });
          controller.enqueue(encodeConnectFrame(gzipSync(e.finish()), { compressed: true }));
        }
        controller.enqueue(encodeConnectFrame(gzipSync(new Uint8Array(0)), { compressed: true, endStream: true }));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

/** A stream of `n` thinking deltas, each carrying the same paragraph, then a clean end. */
function thinkingFloodResponse(paragraph: string, n: number): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < n; i++) {
          const e = new ProtoEncoder();
          e.string(9, `${paragraph}\n\n`);
          controller.enqueue(encodeConnectFrame(gzipSync(e.finish()), { compressed: true }));
        }
        controller.enqueue(encodeConnectFrame(gzipSync(new Uint8Array(0)), { compressed: true, endStream: true }));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

/** A stream that never produces a frame; the adapter's idle abort is what ends it. */
function silentStreamResponse(): Response {
  return new Response(new ReadableStream({ start() { /* never enqueues */ } }), { status: 200 });
}

/** One text frame, then silence — a mid-answer stall. */
function textThenSilentResponse(text: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        const e = new ProtoEncoder();
        e.string(3, text);
        controller.enqueue(encodeConnectFrame(gzipSync(e.finish()), { compressed: true }));
        // Never closes: the idle abort ends the read.
      },
    }),
    { status: 200 },
  );
}

function mockDevinFetch(bodies: Uint8Array[], chat: () => Response): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("GetUserJwt")) {
      const e = new ProtoEncoder();
      e.string(1, "jwt");
      return new Response(e.finish(), { status: 200 });
    }
    if (url.includes("GetChatMessage")) {
      bodies.push(new Uint8Array(init?.body as Uint8Array));
      return chat();
    }
    throw new Error(`unexpected url ${url}`);
  }) as unknown as typeof globalThis.fetch;
}

async function lastPromptText(body: Uint8Array): Promise<{ source: number; text: string }> {
  const { frame } = decodeConnectFrame(body);
  const { gunzipSync } = await import("node:zlib");
  const raw = frame.compressed ? gunzipSync(frame.payload) : frame.payload;
  const d = new ProtoDecoder(raw);
  const prompts: Array<{ source: number; text: string }> = [];
  while (!d.done) {
    const { field, wire } = d.readTag();
    if (field === 3 && wire === 2) {
      const inner = new ProtoDecoder(d.readBytes());
      let source = 0;
      let text = "";
      while (!inner.done) {
        const tag = inner.readTag();
        if (tag.field === 2 && tag.wire === 0) source = Number(inner.readVarint());
        else if (tag.field === 3 && tag.wire === 2) text = new TextDecoder().decode(inner.readBytes());
        else if (tag.wire === 0) inner.readVarint();
        else if (tag.wire === 2) inner.readBytes();
        else inner.skip(tag.wire);
      }
      prompts.push({ source, text });
    } else if (wire === 0) d.readVarint();
    else if (wire === 2) d.readBytes();
    else d.skip(wire);
  }
  return prompts.at(-1) ?? { source: -1, text: "" };
}
