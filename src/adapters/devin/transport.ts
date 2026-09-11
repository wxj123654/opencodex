import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { buildErrorResponse, isJsonRpcNotification, isJsonRpcRequest, isJsonRpcResponse, MAX_ACP_LINE_BYTES, AcpProtocolError, type JsonRpcMessage } from "./acp";

/**
 * Bidirectional NDJSON JSON-RPC transport for one `devin acp` child process.
 *
 * Unlike the single-shot stream-json CLIs (`coding-agent/turn.ts` writes stdin then closes it),
 * ACP is conversational in BOTH directions: the agent streams notifications while a prompt is in
 * flight AND may call back into the client (`session/request_permission`, `fs/*`, `terminal/*`).
 * stdin therefore stays open for the whole turn's lifetime, and agent-to-client requests must be
 * ANSWERED promptly or the turn deadlocks.
 *
 * Every agent-to-client request is refused, deliberately:
 * - `session/request_permission` → `{outcome: {outcome: "cancelled"}}` (the documented decline)
 * - `fs/*`, `terminal/*`, and anything unknown → JSON-RPC method-not-supported error
 *
 * The client never advertises fs/terminal capabilities at `initialize`, so a compliant agent
 * should not send these at all; answering with an error is the belt to those suspenders.
 */

/** Injectable spawn for tests; production uses node:child_process. Mirrors CodingAgentDeps. */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** Resolution for one agent-to-client request. */
export type AgentRequestHandler = (method: string, params: Record<string, unknown>) => { result: unknown } | { error: { code: number; message: string } };

export interface AcpTransportOptions {
  spawn?: SpawnFn;
  /** Wall-clock ceiling for the whole connection lifetime (ms). */
  timeoutMs?: number;
  /** Grace between SIGTERM and SIGKILL when the child lingers (ms). */
  killGraceMs?: number;
  platform?: NodeJS.Platform;
  /** Extra argv after `acp` (reserved for future vendor flags). */
  extraArgs?: readonly string[];
}

export interface AcpSpawnSpec {
  /** Resolved devin binary path. */
  binary: string;
  /** Scoped child env (baseScopedEnv + optional credential). */
  env: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_PLATFORM: NodeJS.Platform = process.platform;

/**
 * One live ACP connection. Created per turn; never shared across turns (stateless single-turn
 * design, 260911_devin_acp_bridge/000_plan.md).
 */
export class AcpConnection {
  readonly child: ChildProcess;
  private nextId = 2; // id 1 is the initialize request.
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
  private readonly updateHandler: (method: string, params: Record<string, unknown>) => void;
  private readonly agentRequestHandler: AgentRequestHandler;
  private readonly buffer: { text: string; bytes: number } = { text: "", bytes: 0 };
  private stderrTail = "";
  private closed = false;
  private processError: Error | undefined;
  private exitCode: number | null = null;
  private readonly exited: Promise<void>;

  private constructor(
    child: ChildProcess,
    updateHandler: (method: string, params: Record<string, unknown>) => void,
    agentRequestHandler: AgentRequestHandler,
  ) {
    this.child = child;
    this.updateHandler = updateHandler;
    this.agentRequestHandler = agentRequestHandler;
    this.exited = new Promise<void>(resolve => {
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once("error", err => {
        this.processError = err;
        if (child.pid === undefined) settle();
      });
      child.once("close", (code: number | null) => {
        this.exitCode = code;
        settle();
      });
      if (child.exitCode !== null) settle();
    });
    this.attachStdout();
    this.attachStderr();
    this.attachStdinErrorHandler();
  }

  /** Spawn the agent and wire the transport. Throws synchronously on spawn failure. */
  static spawn(
    spec: AcpSpawnSpec,
    updateHandler: (method: string, params: Record<string, unknown>) => void,
    agentRequestHandler: AgentRequestHandler,
    options: AcpTransportOptions = {},
  ): AcpConnection {
    const spawnFn = options.spawn ?? nodeSpawn;
    const args = ["acp", ...(options.extraArgs ?? [])];
    // The official installers ship a native binary (install.sh / setup.ps1), so no Windows
    // .cmd-shell wrapping is attempted: a shim-mediated spawn would silently change quoting
    // semantics for NDJSON-bearing argv, and there is no documented shim surface to support.
    const child = spawnFn(spec.binary, args, {
      env: spec.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    return new AcpConnection(child, updateHandler, agentRequestHandler);
  }

  private attachStdout(): void {
    const stdout = this.child.stdout;
    if (!stdout) throw new AcpProtocolError("devin acp produced no stdout stream");
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      this.buffer.text += chunk;
      this.buffer.bytes += Buffer.byteLength(chunk);
      if (this.buffer.bytes > MAX_ACP_LINE_BYTES) {
        this.buffer.text = this.buffer.text.slice(-1024);
        this.buffer.bytes = Buffer.byteLength(this.buffer.text);
        // A single line this large is a protocol violation; drop history so memory stays bounded.
      }
      let newlineIndex: number;
      while ((newlineIndex = this.buffer.text.indexOf("\n")) >= 0) {
        const line = this.buffer.text.slice(0, newlineIndex);
        this.buffer.text = this.buffer.text.slice(newlineIndex + 1);
        this.handleLine(line);
      }
    });
    stdout.on("end", () => {
      // Fail any request still in flight when the agent closes its stdout.
      this.failAllPending(new AcpProtocolError("devin acp closed its output stream before the turn completed"));
    });
  }

  private attachStderr(): void {
    const stderr = this.child.stderr;
    if (!stderr) return;
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      // Bounded tail for diagnostics — never protocol data, never surfaced verbatim when large.
      this.stderrTail = (this.stderrTail + chunk).slice(-4096);
    });
  }

  private attachStdinErrorHandler(): void {
    // EPIPE when the agent exits before we finish writing; surfaced via close/pending rejection.
    this.child.stdin?.on("error", () => { /* handled via lifecycle */ });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: JsonRpcMessage;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      message = parsed as JsonRpcMessage;
    } catch {
      // A malformed frame is a protocol violation. Log-and-continue keeps unrelated agent
      // notifications flowing; the prompt in-flight will surface real failures via stopReason.
      return;
    }
    if (isJsonRpcResponse(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new AcpProtocolError(`devin acp request failed: ${message.error.message ?? "unknown error"}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (isJsonRpcRequest(message)) {
      this.handleAgentRequest(message.id, message.method, (message.params ?? {}) as Record<string, unknown>);
      return;
    }
    if (isJsonRpcNotification(message)) {
      const params = (message.params ?? {}) as Record<string, unknown>;
      this.updateHandler(message.method, params);
    }
  }

  private handleAgentRequest(id: number, method: string, params: Record<string, unknown>): void {
    const outcome = this.agentRequestHandler(method, params);
    const response: JsonRpcMessage = "result" in outcome
      ? { jsonrpc: "2.0", id, result: outcome.result }
      : { jsonrpc: "2.0", id, error: outcome.error };
    this.send(response);
  }

  /** Send any message verbatim. Returns false when stdin is gone. */
  send(message: JsonRpcMessage): boolean {
    if (this.closed || !this.child.stdin?.writable) return false;
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  /** Send a client request and await its response. Rejects on error response, EOF, or close. */
  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new AcpProtocolError("devin acp connection is already closed"));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AcpProtocolError(`devin acp request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: err => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
      // If the process is already dead, fail immediately instead of waiting for the timeout.
      void this.exited.then(() => {
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(timer);
          this.pending.delete(id);
          pending.reject(this.processError ?? new AcpProtocolError(`devin acp exited before answering "${method}"`));
        }
      });
    });
  }

  get stderrText(): string {
    return this.stderrTail.trim();
  }

  get failedToStart(): Error | undefined {
    return this.child.pid === undefined ? this.processError : undefined;
  }

  get exitStatus(): { exitCode: number | null; processError?: Error } {
    return { exitCode: this.exitCode, processError: this.processError };
  }

  /** Abort the in-flight prompt (session/cancel) without tearing down the pipe yet. */
  cancelPrompt(sessionId: string): void {
    this.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  }

  /** Terminate the child: SIGTERM, then SIGKILL after the grace window. */
  destroy(killGraceMs = 2_000): void {
    this.closed = true;
    this.failAllPending(new AcpProtocolError("devin acp connection was destroyed"));
    try { this.child.stdin?.destroy(); } catch { /* already gone */ }
    try { this.child.kill("SIGTERM"); } catch { /* already gone */ }
    setTimeout(() => {
      try { this.child.kill("SIGKILL"); } catch { /* already gone */ }
    }, killGraceMs).unref?.();
  }

  private failAllPending(err: Error): void {
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }

  /** Resolves when the child process exits. */
  whenExited(): Promise<void> {
    return this.exited;
  }
}
