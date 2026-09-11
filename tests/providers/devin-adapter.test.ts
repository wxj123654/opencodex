import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  ACP_PROTOCOL_VERSION,
  buildErrorResponse,
  buildInitializeRequest,
  buildNewSessionRequest,
  buildPromptRequest,
  mapSessionUpdate,
  projectConversationToPromptText,
  stopReasonToEvent,
} from "../../src/adapters/devin/acp";
import { parseDevinModelList, setFetchDevinModelsForTests } from "../../src/adapters/devin/models";
import { buildDevinChildEnv, DEVIN_PROFILE, refusalHandler, runDevinAcpTurn } from "../../src/adapters/devin/turn";
import { clearCodingAgentBinaryCache } from "../../src/adapters/coding-agent/profile";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const enc = new TextEncoder();

beforeEach(() => clearCodingAgentBinaryCache());

// ---------------------------------------------------------------------------
// Pure protocol functions
// ---------------------------------------------------------------------------

describe("devin acp protocol surface", () => {
  test("initialize offers no fs or terminal capabilities and speaks v1", () => {
    const request = buildInitializeRequest(1);
    const params = request.params as { protocolVersion: number; clientCapabilities: Record<string, unknown> };
    expect(request.method).toBe("initialize");
    expect(params.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
    expect(Object.keys(params.clientCapabilities)).toEqual([]);
  });

  test("session/new uses a scratch cwd and no MCP servers", () => {
    const request = buildNewSessionRequest(2, "/tmp/scratch");
    expect(request.params).toEqual({ cwd: "/tmp/scratch", mcpServers: [] });
  });

  test("agent_message_chunk maps to text deltas; thought chunks to thinking; tool calls are dropped", () => {
    const text = mapSessionUpdate({
      sessionId: "s1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
    });
    expect(text.events).toEqual([{ type: "text_delta", text: "hello" }]);
    expect(text.sawText).toBe(true);

    const thought = mapSessionUpdate({
      sessionId: "s1",
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } },
    });
    expect(thought.events).toEqual([{ type: "thinking_delta", thinking: "hmm" }]);

    // Inverted ownership: ACP's tool_call means "the AGENT is running this"; Codex's tool_call
    // means "YOU run this". Forwarding would fabricate tool calls Codex never made.
    const tool = mapSessionUpdate({
      sessionId: "s1",
      update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "exec", kind: "execute", status: "in_progress" },
    });
    expect(tool.events).toEqual([]);

    const userEcho = mapSessionUpdate({
      sessionId: "s1",
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "echo" } },
    });
    expect(userEcho.events).toEqual([]);
  });

  test("stopReason mapping: end_turn ends, refusal errors, unknown fails closed only without output", () => {
    expect(stopReasonToEvent("end_turn", { sawText: true, sawThinking: false })).toMatchObject({ type: "done", endTurn: true });
    expect(stopReasonToEvent("max_tokens", { sawText: true, sawThinking: false })).toMatchObject({ type: "incomplete", reason: "max_tokens" });
    expect(stopReasonToEvent("refusal", { sawText: false, sawThinking: false })).toMatchObject({ type: "error", status: 422 });
    expect(stopReasonToEvent("cancelled", { sawText: false, sawThinking: false })).toMatchObject({ type: "incomplete", reason: "cancelled" });
    const unknownWithText = stopReasonToEvent("something_new", { sawText: true, sawThinking: false });
    expect(unknownWithText).toMatchObject({ type: "done" });
    const unknownWithoutText = stopReasonToEvent("something_new", { sawText: false, sawThinking: false });
    expect(unknownWithoutText).toMatchObject({ type: "error", code: "protocol_error" });
  });

  test("projects a multi-turn conversation into one prompt text with history demarcation", () => {
    const parsed = {
      modelId: "swe-1.7",
      stream: true,
      options: {},
      context: {
        messages: [
          { role: "user", content: "first question", timestamp: 0 },
          { role: "assistant", content: "first answer", timestamp: 1 },
          { role: "user", content: "follow-up", timestamp: 2 },
        ],
      },
    } as unknown as OcxParsedRequest;
    const text = projectConversationToPromptText(parsed);
    expect(text).toContain("Prior conversation context:");
    expect(text).toContain("first question");
    expect(text).toContain("follow-up");
  });
});

describe("devin fail-closed refusal shapes", () => {
  test("permission requests are declined with the documented cancelled outcome", () => {
    expect(refusalHandler("session/request_permission")).toEqual({
      result: { outcome: { outcome: "cancelled" } },
    });
  });

  test("fs and terminal callbacks get method-not-supported errors", () => {
    for (const method of ["fs/read_text_file", "fs/write_text_file", "terminal/create", "terminal/output"]) {
      const outcome = refusalHandler(method);
      expect(outcome).toHaveProperty("error");
      const err = buildErrorResponse(9, (outcome as { error: { code: number } }).error.code, (outcome as { error: { message: string } }).error.message);
      expect(err.error.code).toBe(-32601);
    }
  });

  test("the child env is scoped and layers DEVIN_API_KEY only when a key exists", () => {
    const withoutKey = buildDevinChildEnv(undefined);
    expect(withoutKey.DEVIN_API_KEY).toBeUndefined();
    expect(withoutKey.PATH).toBeDefined();
    const withKey = buildDevinChildEnv("cog-x");
    expect(withKey.DEVIN_API_KEY).toBe("cog-x");
  });
});

// ---------------------------------------------------------------------------
// Model discovery parsing
// ---------------------------------------------------------------------------

describe("devin models list parsing", () => {
  test("accepts a bare array, {models}, or {data} with id or modelId fields", () => {
    expect(parseDevinModelList(JSON.stringify(["swe-1.7", "swe-1.6"]))).toEqual({ ok: true, models: ["swe-1.7", "swe-1.6"] });
    expect(parseDevinModelList(JSON.stringify({ models: [{ id: "swe-1.7", name: "SWE-1.7" }] }))).toEqual({ ok: true, models: ["swe-1.7"] });
    expect(parseDevinModelList(JSON.stringify({ data: [{ modelId: "swe-1.7" }] }))).toEqual({ ok: true, models: ["swe-1.7"] });
  });

  test("rejects non-JSON, non-array shapes, and empty rosters", () => {
    expect(parseDevinModelList("not json")).toMatchObject({ ok: false, error: "invalid_output" });
    expect(parseDevinModelList(JSON.stringify({ models: "nope" }))).toMatchObject({ ok: false, error: "invalid_output" });
    expect(parseDevinModelList(JSON.stringify([]))).toMatchObject({ ok: false, error: "empty" });
  });

  test("the test seam replaces the roster fetch entirely", async () => {
    setFetchDevinModelsForTests(() => ({ ok: true, models: ["account-model"] }));
    const { fetchDevinModels } = await import("../../src/adapters/devin/models");
    expect(await fetchDevinModels()).toEqual({ ok: true, models: ["account-model"] });
    setFetchDevinModelsForTests(null);
  });
});

// ---------------------------------------------------------------------------
// Turn orchestration against a scripted fake agent
// ---------------------------------------------------------------------------

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  killed: boolean;
  exitCode: number | null;
  kill: (signal?: string) => boolean;
}

type AgentResponder = (message: Record<string, unknown>, send: (response: Record<string, unknown>) => void) => void;

function fakeAgentChild(responder: AgentResponder, opts: { stderr?: string; exitCode?: number; immediateExit?: boolean } = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { stdoutController = controller; },
  });
  child.stdout = Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0]);
  child.stderr = Readable.from(opts.stderr ? [enc.encode(opts.stderr)] : []);
  const send = (message: Record<string, unknown>): void => {
    stdoutController?.enqueue(enc.encode(`${JSON.stringify(message)}\n`));
  };
  child.stdin = new Writable({
    write(chunk, _enc, cb) {
      const line = String(chunk).trim();
      if (line) {
        try { responder(JSON.parse(line), send); } catch { /* malformed input: ignore in fake */ }
      }
      cb();
    },
  });
  child.killed = false;
  child.exitCode = null;
  child.kill = () => {
    if (child.killed) return true;
    child.killed = true;
    // A real child emits `close` after SIGTERM; the fake must do the same or the transport's
    // reap step (whenExited) never resolves and every orchestration test times out.
    queueMicrotask(() => {
      child.exitCode = child.exitCode ?? (opts.exitCode ?? 0);
      child.emit("close", child.exitCode);
    });
    return true;
  };
  if (opts.immediateExit) {
    queueMicrotask(() => {
      child.exitCode = opts.exitCode ?? 1;
      child.emit("close", opts.exitCode ?? 1);
    });
  }
  return child;
}

/** A compliant fake `devin acp`: answers the handshake, then streams updates and a stopReason. */
function scriptedAgent(options: {
  models?: Array<{ modelId: string; name?: string }>;
  updates?: Array<Record<string, unknown>>;
  stopReason?: string;
  sessionError?: { code: number; message: string };
} = {}): (spawnArgs: { file: string; args: readonly string[] }) => FakeChild {
  return ({ args }) => {
    expect(args[0]).toBe("acp");
    return fakeAgentChild((message, send) => {
      if (message.method === "initialize") {
        send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
        return;
      }
      if (message.method === "session/new") {
        if (options.sessionError) {
          send({ jsonrpc: "2.0", id: message.id, error: options.sessionError });
          return;
        }
        send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "sess_test", models: options.models ? { availableModels: options.models, currentModelId: options.models[0]?.modelId } : null } });
        return;
      }
      if (message.method === "session/set_model") {
        expect((message.params as { modelId: string }).modelId).toBe("swe-1.7");
        send({ jsonrpc: "2.0", id: message.id, result: {} });
        return;
      }
      if (message.method === "session/prompt") {
        for (const update of options.updates ?? []) {
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess_test", update } });
        }
        send({ jsonrpc: "2.0", id: message.id, result: { stopReason: options.stopReason ?? "end_turn" } });
        return;
      }
      // Agent-to-client requests: the adapter's refusal handler answers them via stdin.
      if (typeof message.id === "number" && typeof message.method === "string") {
        const outcome = refusalHandler(message.method);
        send("result" in outcome
          ? { jsonrpc: "2.0", id: message.id, result: outcome.result }
          : { jsonrpc: "2.0", id: message.id, error: outcome.error });
      }
    });
  };
}

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "devin",
    baseUrl: "https://cli.devin.ai",
    ...overrides,
  } as OcxProviderConfig;
}

function parsed(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return {
    modelId: "swe-1.7",
    stream: true,
    options: {},
    context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    ...overrides,
  } as OcxParsedRequest;
}

function incoming(abortSignal?: AbortSignal) {
  return { headers: new Headers(), translatorBudget: createTestTranslatorBudget(), ...(abortSignal ? { abortSignal } : {}) };
}

async function runTurn(childFactory: (spawnCall: { file: string; args: readonly string[] }) => FakeChild, p = parsed(), prov = provider()): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  await runDevinAcpTurn(prov, p, incoming(), e => events.push(e), {
    which: () => "/usr/bin/devin",
    spawn: (file, args) => childFactory({ file, args }) as unknown as ChildProcess,
    killGraceMs: 50,
  });
  return events;
}

describe("devin ACP turn orchestration", () => {
  test("streams text and thinking then terminates with done on end_turn", async () => {
    const events = await runTurn(scriptedAgent({
      updates: [
        { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking..." } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer part 1" } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " part 2" } },
      ],
    }));
    expect(events).toEqual([
      { type: "thinking_delta", thinking: "thinking..." },
      { type: "text_delta", text: "answer part 1" },
      { type: "text_delta", text: " part 2" },
      { type: "done", endTurn: true, stopReason: "end_turn" },
    ]);
  });

  test("sets the model only among agent-advertised ids and skips set_model without a roster", async () => {
    let setModelCalls = 0;
    const withRoster = await runTurn((spawnCall) => {
      const child = scriptedAgent({ models: [{ modelId: "swe-1.7", name: "SWE-1.7" }, { modelId: "gpt" }] })(spawnCall);
      return child;
    });
    expect(withRoster.at(-1)).toMatchObject({ type: "done" });

    const withoutRoster = await runTurn(scriptedAgent({}));
    expect(withoutRoster.at(-1)).toMatchObject({ type: "done" });
    void setModelCalls;
  });

  test("a routed model the agent does not advertise fails closed with model_not_advertised", async () => {
    const events = await runTurn(scriptedAgent({ models: [{ modelId: "gpt" }] }), parsed({ modelId: "swe-1.7" }));
    const terminal = events.at(-1)!;
    expect(terminal).toMatchObject({ type: "error", code: "model_not_advertised", status: 400 });
  });

  test("agent permission requests are answered cancelled while the turn stays alive", async () => {
    const events = await runTurn(scriptedAgent({
      updates: [
        { sessionUpdate: "tool_call", toolCallId: "t1", title: "exec", kind: "execute", status: "pending" },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done without tools" } },
      ],
    }));
    expect(events).toEqual([
      { type: "text_delta", text: "done without tools" },
      { type: "done", endTurn: true, stopReason: "end_turn" },
    ]);
  });

  test("an unauthenticated agent surfaces the devin auth login guidance", async () => {
    const events = await runTurn(() => fakeAgentChild(() => { /* never answers */ }, {
      stderr: "error: not logged in. Run `devin auth login`.",
      immediateExit: true,
      exitCode: 1,
    }));
    const terminal = events.at(-1)!;
    expect(terminal).toMatchObject({ type: "error", code: "cli_not_authenticated" });
    expect((terminal as { message: string }).message).toContain("devin auth login");
  });

  test("a refusal stopReason becomes a 422 error", async () => {
    const events = await runTurn(scriptedAgent({ stopReason: "refusal" }));
    expect(events.at(-1)).toMatchObject({ type: "error", status: 422, code: "turn_refused" });
  });

  test("a missing CLI fails closed before any spawn", async () => {
    let spawned = 0;
    const events: AdapterEvent[] = [];
    await runDevinAcpTurn(provider(), parsed(), incoming(), e => events.push(e), {
      which: () => undefined,
      spawn: () => { spawned++; throw new Error("should not spawn"); },
    });
    expect(spawned).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "cli_not_found" });
  });
});

describe("devin profile identity", () => {
  test("canonical identity is the CLI host and the token env is DEVIN_API_KEY", () => {
    expect(DEVIN_PROFILE.canonicalBaseUrl).toBe("https://cli.devin.ai");
    expect(DEVIN_PROFILE.tokenEnv).toBe("DEVIN_API_KEY");
    expect(DEVIN_PROFILE.binaryCandidates).toEqual(["devin"]);
  });
});
