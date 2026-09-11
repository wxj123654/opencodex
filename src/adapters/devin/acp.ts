import type { AdapterEvent, OcxParsedRequest } from "../../types";
import { buildConversationInput } from "../coding-agent/protocol";

/**
 * Agent Client Protocol (ACP) wire surface for the Devin CLI bridge.
 *
 * `devin acp` speaks JSON-RPC 2.0 over stdio as newline-delimited JSON (the official
 * `@zed-industries/agent-client-protocol` SDK's `ndJsonStream` is the reference framing).
 * The client drives: initialize → session/new → (session/set_model) → session/prompt, while
 * the agent streams `session/update` notifications and MAY call back into the client with
 * `session/request_permission`, `fs/*`, and `terminal/*` requests.
 *
 * Only the subset the bridge needs is typed here. Everything is fail-closed: the client never
 * advertises fs/terminal capabilities, and every agent-to-client request that asks this process
 * to act on the workspace is refused. This module is pure: no process spawn, no I/O, so it is
 * unit-testable against captured fixtures.
 */

/** ACP v1 (the version `cursor-agent acp` and `devin acp` advertise; see 260910_cursor_acp_bridge/070). */
export const ACP_PROTOCOL_VERSION = 1;

/** Hard ceiling on one buffered NDJSON line, mirroring the coding-agent stream guard. */
export const MAX_ACP_LINE_BYTES = 8 * 1024 * 1024;

export class AcpProtocolError extends Error {
  readonly code = "protocol_error";
  readonly status = 502;
  constructor(message: string) {
    super(message);
    this.name = "AcpProtocolError";
  }
}

/** JSON-RPC 2.0 messages as they cross the NDJSON boundary. */
export type JsonRpcMessage =
  | { jsonrpc: "2.0"; id: number; method: string; params?: Record<string, unknown> }
  | { jsonrpc: "2.0"; id: number; result?: unknown; error?: { code: number; message: string; data?: unknown } }
  | { jsonrpc: "2.0"; method: string; params?: Record<string, unknown> };

export function isJsonRpcRequest(message: JsonRpcMessage): message is Extract<JsonRpcMessage, { method: string; id: number }> {
  return "id" in message && "method" in message;
}

export function isJsonRpcNotification(message: JsonRpcMessage): message is Extract<JsonRpcMessage, { method: string }> {
  return !("id" in message) && "method" in message;
}

export function isJsonRpcResponse(message: JsonRpcMessage): message is Extract<JsonRpcMessage, { result?: unknown; error?: unknown }> {
  return "id" in message && !("method" in message);
}

/** Text content block. The bridge only ever SENDS text (v1) but parses image blocks for accounting. */
export interface AcpContentBlock {
  type: "text" | "image" | "audio" | "resource_link" | "resource";
  text?: string;
  [key: string]: unknown;
}

export interface AcpModelInfo {
  modelId: string;
  name?: string;
  description?: string;
}

export interface AcpSessionModelState {
  currentModelId?: string;
  availableModels?: AcpModelInfo[];
}

// ---------------------------------------------------------------------------
// Client → Agent requests
// ---------------------------------------------------------------------------

export function buildInitializeRequest(id: number): Extract<JsonRpcMessage, { method: string; id: number }> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: ACP_PROTOCOL_VERSION,
      // fs and terminal capabilities are DELIBERATELY absent: the bridge never offers to act
      // on the workspace for the agent. See 260911_devin_acp_bridge/000_plan.md.
      clientCapabilities: {
        // No fs, no terminal — their absence is the structural refusal.
      },
    },
  };
}

export function buildNewSessionRequest(id: number, cwd: string): Extract<JsonRpcMessage, { method: string; id: number }> {
  return {
    jsonrpc: "2.0",
    id,
    method: "session/new",
    params: {
      cwd,
      // No MCP servers: the vendor agent must not gain tool surface from this bridge.
      mcpServers: [],
    },
  };
}

export function buildSetModelRequest(id: number, sessionId: string, modelId: string): Extract<JsonRpcMessage, { method: string; id: number }> {
  return {
    jsonrpc: "2.0",
    id,
    method: "session/set_model",
    params: { sessionId, modelId },
  };
}

export function buildPromptRequest(id: number, sessionId: string, promptText: string): Extract<JsonRpcMessage, { method: string; id: number }> {
  return {
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: {
      sessionId,
      prompt: [{ type: "text", text: promptText } satisfies AcpContentBlock],
    },
  };
}

export function buildCancelNotification(sessionId: string): Extract<JsonRpcMessage, { method: string }> {
  return {
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId },
  };
}

export function buildErrorResponse(id: number, code: number, message: string): { jsonrpc: "2.0"; id: number; error: { code: number; message: string } } {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

/** Standard JSON-RPC error codes used by the fail-closed handlers. */
export const ACP_ERROR_METHOD_NOT_SUPPORTED = -32601;
export const ACP_ERROR_REFUSED = -32000;

// ---------------------------------------------------------------------------
// Agent → Client notifications: session/update mapping
// ---------------------------------------------------------------------------

/** The subset of `session/update` payloads the bridge understands. */
export type AcpSessionUpdate =
  | { sessionUpdate: "user_message_chunk"; content?: AcpContentBlock }
  | { sessionUpdate: "agent_message_chunk"; content?: AcpContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content?: AcpContentBlock }
  | {
      sessionUpdate: "tool_call" | "tool_call_update";
      toolCallId?: string;
      title?: string;
      kind?: string;
      status?: string;
      [key: string]: unknown;
    }
  | { sessionUpdate: "plan" ; [key: string]: unknown }
  | { sessionUpdate: string; [key: string]: unknown };

export interface AcpUpdateParseResult {
  /** Events to forward to Codex. */
  events: AdapterEvent[];
  /** True when the update carried visible assistant text. */
  sawText: boolean;
  /** True when the update carried visible thinking text. */
  sawThinking: boolean;
}

/**
 * Map one `session/update` notification to AdapterEvents.
 *
 * `agent_message_chunk` becomes text deltas; `agent_thought_chunk` becomes thinking deltas.
 * Tool-call updates are intentionally NOT forwarded as tool_call events: ACP's tool_call means
 * "the AGENT is running this" while Codex's tool_call_start means "YOU run this" — inverted
 * ownership (260910_cursor_acp_bridge/040). Emitting them would fabricate tool calls Codex never
 * made. The update is dropped; the text the agent produces remains the turn's output.
 */
export function mapSessionUpdate(params: Record<string, unknown>): AcpUpdateParseResult {
  const update = params.update as AcpSessionUpdate | undefined;
  if (!update || typeof update.sessionUpdate !== "string") {
    return { events: [], sawText: false, sawThinking: false };
  }
  const events: AdapterEvent[] = [];
  let sawText = false;
  let sawThinking = false;
  const content = (update as { content?: AcpContentBlock }).content;
  const text = content?.type === "text" && typeof content.text === "string" ? content.text : undefined;
  if (text !== undefined && text.length > 0) {
    if (update.sessionUpdate === "agent_message_chunk") {
      events.push({ type: "text_delta", text });
      sawText = true;
    } else if (update.sessionUpdate === "agent_thought_chunk") {
      events.push({ type: "thinking_delta", thinking: text });
      sawThinking = true;
    }
    // user_message_chunk is an echo of what we sent; never forwarded.
  }
  return { events, sawText, sawThinking };
}

/** Terminal stopReason values documented by ACP v1. */
export type AcpStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export function stopReasonToEvent(
  stopReason: string,
  context: { sawText: boolean; sawThinking: boolean },
): AdapterEvent {
  switch (stopReason) {
    case "end_turn":
      return { type: "done", endTurn: true, stopReason: "end_turn" };
    case "max_tokens":
      return { type: "incomplete", reason: "max_tokens", retryable: false };
    case "refusal":
      return {
        type: "error",
        message: "Devin refused the turn.",
        status: 422,
        errorType: "upstream_error",
        code: "turn_refused",
        retryable: false,
      };
    case "cancelled":
      return { type: "incomplete", reason: "cancelled", retryable: false };
    default:
      // Unknown stop reason: accept it as an end when something was produced, else fail closed.
      return context.sawText || context.sawThinking
        ? { type: "done", endTurn: true, stopReason }
        : { type: "error", message: `Devin ended the turn with an unrecognized stop reason: ${stopReason}`, status: 502, errorType: "upstream_error", code: "protocol_error", retryable: false };
  }
}

/**
 * Project the replayed conversation into the single text block the ACP prompt carries.
 *
 * Delegates to the shared coding-agent projection (Strategy C: legal user-message projection) by
 * parsing the stream-json frame it emits and lifting the text content out. This keeps ONE owner of
 * the truncation/history rules (`coding-agent/protocol.ts`) instead of a fork that silently drifts.
 * Returns undefined when the projection produced no text at all.
 */
export function projectConversationToPromptText(parsed: OcxParsedRequest): string | undefined {
  const lines = buildConversationInput(parsed);
  const parts: string[] = [];
  for (const line of lines) {
    try {
      const frame = JSON.parse(line) as { message?: { content?: Array<{ type: string; text?: string }> } };
      for (const part of frame.message?.content ?? []) {
        if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
          parts.push(part.text);
        }
      }
    } catch {
      throw new AcpProtocolError("Internal error: conversation projection produced a malformed frame");
    }
  }
  const joined = parts.join("\n\n");
  return joined.length > 0 ? joined : undefined;
}
