import { tmpdir } from "node:os";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../types";
import type { IncomingMeta } from "../base";
import { baseScopedEnv, redactSecrets } from "../coding-agent/turn";
import { resolveCodingAgentBinary, type CodingAgentProviderProfile, type WhichFn } from "../coding-agent/profile";
import {
  ACP_ERROR_METHOD_NOT_SUPPORTED,
  ACP_PROTOCOL_VERSION,
  buildInitializeRequest,
  buildNewSessionRequest,
  buildPromptRequest,
  buildSetModelRequest,
  mapSessionUpdate,
  projectConversationToPromptText,
  stopReasonToEvent,
  type AcpModelInfo,
  type AcpSessionModelState,
} from "./acp";
import { AcpConnection, type SpawnFn } from "./transport";

/**
 * One headless Devin turn over ACP (260911_devin_acp_bridge/000_plan.md).
 *
 * Stateless single-turn: every turn spawns `devin acp`, initializes WITHOUT fs/terminal
 * capabilities, opens one session on a scratch cwd with no MCP servers, sets the advertised model
 * when one matches, sends the projected conversation as one text prompt, streams
 * agent_message/agent_thought chunks to Codex, and maps the terminal stopReason. The child is
 * always reaped.
 *
 * Tool ownership stays with Codex by refusal: permission requests are answered
 * `cancelled`, fs/terminal callbacks get method-not-supported errors, and ACP tool_call updates
 * are never forwarded as Codex tool calls ("I am running this" ≠ "YOU run this"). See the devlog
 * unit for the trust boundary this does and does not establish.
 */

/** Profile-shaped constants so the turn reuses the shared binary resolver. */
export const DEVIN_PROFILE: CodingAgentProviderProfile = {
  providerId: "devin",
  // The family discriminator exists for the arg/env builders the shared turn runner selects;
  // devin brings its own turn, so the family value is identity only.
  family: "devin",
  region: "global",
  label: "Devin CLI",
  // Nominal identity, never dialed: the CLI performs the real transport. Unlike qoder/codebuddy
  // there is no HTTP destination to fail closed on, and no credential is ever bound to a region.
  canonicalBaseUrl: "https://cli.devin.ai",
  binaryCandidates: ["devin"],
  tokenEnv: "DEVIN_API_KEY",
  installHint: "curl -fsSL https://cli.devin.ai/install.sh | bash (or `brew install --cask devin-cli`)",
  documentationUrl: "https://docs.devin.ai/cli/acp/zed",
};

const REQUEST_TIMEOUT_MS = 60_000;

export interface DevinTurnDeps {
  spawn?: SpawnFn;
  which?: WhichFn;
  /** Wall-clock ceiling for one turn (ms). */
  timeoutMs?: number;
  killGraceMs?: number;
  platform?: NodeJS.Platform;
  /** Test seam: override the scratch cwd handed to session/new. */
  cwd?: string;
}

/** Build the scoped child env. `apiKey` (DEVIN_API_KEY-compatible) is optional: an absent key
 * relies on the local `devin auth login` credential cache, which is the documented setup path. */
export function buildDevinChildEnv(apiKey: string | undefined): Record<string, string> {
  const env = baseScopedEnv();
  if (apiKey) env.DEVIN_API_KEY = apiKey;
  return env;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runDevinAcpTurn(
  provider: OcxProviderConfig,
  parsed: OcxParsedRequest,
  incoming: IncomingMeta,
  emit: (event: AdapterEvent) => void,
  deps: DevinTurnDeps = {},
): Promise<void> {
  const timeoutMs = deps.timeoutMs ?? 300_000;
  const killGraceMs = deps.killGraceMs ?? 2_000;

  if (incoming.abortSignal?.aborted) {
    emit({ type: "error", message: "Devin turn was aborted before start." });
    return;
  }

  const binary = resolveCodingAgentBinary(DEVIN_PROFILE, deps.which);
  if (!binary) {
    emit({
      type: "error",
      message: `Devin CLI not found on PATH. Install it with: ${DEVIN_PROFILE.installHint}`,
      status: 500,
      errorType: "upstream_error",
      code: "cli_not_found",
      retryable: false,
    });
    return;
  }

  const promptText = projectConversationToPromptText(parsed);
  if (promptText === undefined) {
    emit({ type: "error", message: "Devin turn carried no projectable conversation content.", status: 400, errorType: "invalid_request_error", retryable: false });
    return;
  }

  let terminalEmitted = false;
  const emitOnce = (event: AdapterEvent): void => {
    if (event.type === "done" || event.type === "error" || event.type === "incomplete") {
      if (terminalEmitted) return;
      terminalEmitted = true;
    }
    emit(event);
  };

  let connection: AcpConnection;
  // Whether the agent produced visible output before the terminal frame. An unknown stopReason
  // with streamed text is still an end; without any output it is a protocol failure.
  let sawOutput = false;
  try {
    connection = AcpConnection.spawn(
      { binary, env: buildDevinChildEnv(provider.apiKey) },
      // Notification handler: session/update → AdapterEvents, with output tracking.
      (_method, params) => {
        const parsed = mapSessionUpdate(params);
        if (parsed.sawText || parsed.sawThinking) sawOutput = true;
        for (const event of parsed.events) emitOnce(event);
      },
      // Agent-to-client handler: EVERY request is refused, fail-closed.
      refusalHandler,
      { spawn: deps.spawn, killGraceMs, platform: deps.platform },
    );
  } catch (err) {
    emit({
      type: "error",
      message: `Devin CLI failed to start: ${redactSecrets(errorMessage(err), "DEVIN_API_KEY", provider.apiKey)}`,
      status: 500,
      errorType: "upstream_error",
      code: "cli_spawn_failed",
      retryable: false,
    });
    return;
  }

  const timeoutTimer = setTimeout(() => {
    emitOnce({ type: "error", message: "Devin turn timed out.", status: 504, errorType: "upstream_error", code: "timeout", retryable: true });
    connection.destroy(killGraceMs);
  }, timeoutMs);
  const onAbort = (): void => connection.destroy(killGraceMs);
  incoming.abortSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    // 1. Handshake. A client that cannot agree on the protocol version must disconnect.
    const init = buildInitializeRequest(2);
    const initResult = await connection.request(init.method, (init.params ?? {}) as Record<string, unknown>, REQUEST_TIMEOUT_MS);
    const advertised = (initResult as { protocolVersion?: number } | null)?.protocolVersion;
    if (advertised !== undefined && advertised !== ACP_PROTOCOL_VERSION) {
      emitOnce({
        type: "error",
        message: `Devin CLI advertises ACP protocol version ${advertised}; this bridge speaks version ${ACP_PROTOCOL_VERSION}. Upgrade opencodex or pin a compatible Devin CLI version.`,
        status: 502,
        errorType: "upstream_error",
        code: "protocol_error",
        retryable: false,
      });
      return;
    }

    // 2. Session on a scratch cwd with no MCP surface. The cwd is nominal: the bridge never
    // mediates workspace access for the agent (see the refusal handler above).
    const newSession = await connection.request("session/new", (buildNewSessionRequest(2, deps.cwd ?? tmpdir()).params ?? {}) as Record<string, unknown>, REQUEST_TIMEOUT_MS) as { sessionId?: string; models?: AcpSessionModelState | null } | null;
    const sessionId = newSession?.sessionId;
    if (!sessionId || typeof sessionId !== "string") {
      emitOnce({ type: "error", message: "devin acp did not return a sessionId from session/new.", status: 502, errorType: "upstream_error", code: "protocol_error", retryable: false });
      return;
    }

    // 3. Model selection ONLY among agent-advertised ids: a routed id the agent did not advertise
    // fails closed rather than being sent on the wire as an invented value.
    const availableModels: AcpModelInfo[] = newSession?.models?.availableModels ?? [];
    if (availableModels.length > 0) {
      const wanted = parsed.modelId;
      const match = availableModels.some(model => model.modelId === wanted);
      if (!match) {
        emitOnce({
          type: "error",
          message: `Model "${wanted}" is not advertised by this Devin account over ACP. Run \`devin models list\` for the roster and pick an exact modelId.`,
          status: 400,
          errorType: "invalid_request_error",
          code: "model_not_advertised",
          retryable: false,
        });
        return;
      }
      await connection.request("session/set_model", (buildSetModelRequest(3, sessionId, wanted).params ?? {}) as Record<string, unknown>, REQUEST_TIMEOUT_MS);
    }

    // 4. Prompt. Turn-scoped timeout is enforced by the outer wall clock; the request-level
    // timeout guards a silent agent that never streams and never answers.
    const promptPromise = connection.request("session/prompt", (buildPromptRequest(4, sessionId, promptText).params ?? {}) as Record<string, unknown>, Math.max(timeoutMs - 5_000, REQUEST_TIMEOUT_MS));
    const promptResult = await promptPromise as { stopReason?: string } | null;
    const stopReason = typeof promptResult?.stopReason === "string" ? promptResult.stopReason : undefined;
    if (stopReason === undefined) {
      emitOnce({ type: "error", message: "devin acp returned no stopReason for the prompt.", status: 502, errorType: "upstream_error", code: "protocol_error", retryable: false });
      return;
    }
    // Whether anything streamed decides how an unusual stopReason is classified.
    emitOnce(stopReasonToEvent(stopReason, { sawText: sawOutput, sawThinking: false }));
  } catch (err) {
    if (terminalEmitted) {
      // The wall clock already terminalized the turn; nothing else to report.
      return;
    }
    if (incoming.abortSignal?.aborted) {
      emitOnce({ type: "error", message: "Devin turn was aborted.", retryable: false });
      return;
    }
    const message = redactSecrets(errorMessage(err), "DEVIN_API_KEY", provider.apiKey);
    const stderr = connection.stderrText ? ` Devin CLI stderr: ${connection.stderrText.slice(-1024)}` : "";
    const notLoggedIn = /auth|login|credential|unauthorized/i.test(message) || /auth|login|credential/i.test(stderr);
    emitOnce({
      type: "error",
      message: notLoggedIn
        ? "Devin CLI is not authenticated. Run `devin auth login` (works on the Free plan) or set a DEVIN_API_KEY-compatible provider key."
        : `${message}${stderr}`,
      status: 502,
      errorType: "upstream_error",
      code: notLoggedIn ? "cli_not_authenticated" : "protocol_error",
      retryable: !notLoggedIn,
    });
  } finally {
    clearTimeout(timeoutTimer);
    incoming.abortSignal?.removeEventListener("abort", onAbort);
    connection.destroy(killGraceMs);
    await connection.whenExited();
  }
}

/** The fail-closed answer to every agent-to-client request: permissions are declined, everything
 * else is method-not-supported. Exported for tests to assert the exact wire shapes. */
export function refusalHandler(method: string): { result: unknown } | { error: { code: number; message: string } } {
  if (method === "session/request_permission") {
    // The documented decline outcome. The agent should skip the action.
    return { result: { outcome: { outcome: "cancelled" } } };
  }
  return { error: { code: ACP_ERROR_METHOD_NOT_SUPPORTED, message: `OpenCodex does not implement "${method}" for the Devin bridge.` } };
}
