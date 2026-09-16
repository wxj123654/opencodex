import type { AdapterEvent, OcxAssistantContentPart, OcxMessage, OcxParsedRequest, OcxProviderConfig, OcxTool } from "../../types";
import { isAllowedToolChoice, namespacedToolName, resolveToolChoiceWireName, toolChoiceToolPredicate } from "../../types";
import type { IncomingMeta } from "../base";
import { redactSecretString } from "../../lib/redact";
import { debugProviderDiagnostic } from "../../lib/debug";
import {
  DEVIN_CASCADE_BASE_URL,
  DevinHttpError,
  DEFAULT_STOP_PATTERNS,
  fetchUserJwt,
  streamDevinChat,
  type DevinHttpDeps,
} from "./client";
import { DevinMissingCredentialError, resolveDevinToken } from "./credentials";
import { DEVIN_HTTP_MODEL_DEFAULT_REASONING_EFFORTS, DEVIN_HTTP_MODEL_WIRE_UIDS } from "../../providers/devin-http-models";
import {
  ChatMessageSource,
  StopReason,
  type ChatMessagePrompt,
  type ChatToolCall,
  type ChatToolDefinition,
  type CompletionConfiguration,
  type ImageData,
} from "./proto";
import { resolveDevinSessionIdentity } from "./session-identity";
import { prepareDevinImages } from "./images";
import {
  DevinLoopGuard,
  LOOP_GUARD_MAX_CONTINUATIONS_PER_TURN,
  LOOP_GUARD_MAX_TOOL_CALLS_PER_TURN,
  type DevinLoopGuardDeps,
  type LoopGuardReason,
} from "./loop-fuse";
import { resolveDevinWireUid } from "./roster";

/**
 * One Devin/Cascade turn over plain HTTP.
 *
 * ## This is a MODEL contract, unlike the `devin` (ACP) provider
 *
 * The two Devin providers reach the same account from opposite directions. The ACP bridge spawns
 * the vendor's agent, which keeps its own tools and ignores the tools Codex declares. This adapter
 * calls the underlying chat RPC directly, so Codex's tool list is what the model sees and the
 * model's `tool_calls` come back for Codex to execute — verified on the live service, including
 * `finish_reason: "tool_calls"` and correct arguments. That difference is why this is a `runTurn`
 * adapter with real tool semantics rather than another text-only bridge.
 *
 * ## Stable session identity, stateless history
 *
 * Every turn still sends the whole conversation — the server's view of history remains a strict
 * function of the request bytes, and there is no second continuation axis that could disagree
 * with Responses `previous_response_id`. What is no longer fresh-per-turn is the IDENTITY of the
 * conversation: `cascadeId` (`#16`), `ModelConfig { id, turn }` (`#15`), and `executionId` (`#22`)
 * are derived per-conversation by `session-identity.ts`, matching the shape the observed real
 * client sends. Minting fresh uuids per request made the upstream velocity limiter read one agent
 * loop as N brand-new sessions — observed live as cache collapses and, at ~190 turns, as a
 * degenerate same-command loop ending in a silent upstream stream.
 *
 * ## Verified wire behavior this module depends on
 *
 * - **Tool calls arrive in one of TWO shapes, decided by the model.**
 *   - *Complete:* one frame carries id, name, and the whole arguments string at once
 *     (`swe-1-7-lightning`, observed as `functions.get_weather:0`).
 *   - *Fragmented:* a frame carrying id + name OPENS the call with empty or partial arguments, and
 *     every subsequent frame whose id and name are EMPTY appends another slice of the arguments
 *     (`swe-2-high`, observed: `""`, `"{"`, `'"city": "'`, `"Tok"`, `"yo"`, `'"'`, `"}"`).
 *   Both must be handled, and the distinguishing signal is the empty id/name pair — not a field
 *   that says "this is a fragment". Treating a fragmented stream as complete emits N bogus tool
 *   calls with empty names instead of one correct call.
 * - **Usage frames arrive mostly zeroed.** Nearly every frame carries a usage message and all but
 *   the last are `0`; taking the last NON-ZERO frame is the only correct read, and taking the
 *   last frame would report zero tokens for most turns.
 * - **Bare base ids are not callable.** `claude-opus-5` and `swe-2` fail with
 *   `permission_denied` while `claude-opus-5-medium` and `swe-2-high` succeed, so an absent effort
 *   resolves through the seed's rung map rather than sending the bare id.
 * - **`temperature: 0` must not be sent.** proto3 omits zero-valued scalars, so a literal 0
 *   serializes as an absent field and the upstream answers `invalid_argument`. Clamped below.
 * - **Some roster models are Local-only and always fail over HTTP.** Measured by sweeping all 74
 *   exposed models (2026-09-12, Free plan): 66 succeed, and 8 answer `permission_denied: This model
 *   is only in Devin Local` — every rung of `gpt-5-6-sol`, `gpt-5-6-luna`, `gpt-5-6-terra`, and
 *   `gpt-6-astra`, plus their `-priority` tiers. The CLI CAN call them, which is the giveaway: it
 *   is a local process with the Cascade local runtime available, and a cloud HTTP call has no path
 *   to a locally-served model. The roster carries NO discriminator for this (verified field by
 *   field: every scalar and nested field of the blocked entries also appears on callable models,
 *   including the `f10 == 2` serving-pool marker, which `gpt-5-4`/`gpt-5-5` share while remaining
 *   callable). The adapter therefore does NOT filter them: the flag is a deployment property that
 *   can differ per plan and per CLI version, and silently dropping models a paid account could call
 *   is worse than surfacing the server's own explicit message, which it passes through verbatim.
 */

/** Wall-clock ceiling for one turn. Cascade turns are long; the idle guard is the real liveness check. */
const TURN_TIMEOUT_MS = 300_000;

/**
 * Substituted for a requested temperature of exactly 0.
 *
 * proto3 drops zero-valued scalars, so `temperature: 0` reaches the server as "unset" and is
 * rejected with `invalid_argument` for some models. This value is small enough to be
 * indistinguishable from greedy decoding while remaining a present field.
 */
const MIN_PRESENT_TEMPERATURE = 0.01;

const DEFAULT_TEMPERATURE = 0.4;
const DEFAULT_TOP_P = 1;
const DEFAULT_TOP_K = 50n;
/** Cascade's own line guard, independent of the token budget. */
const DEFAULT_MAX_NEWLINES = 200n;
const DEFAULT_MAX_TOKENS = 64_000;

export interface DevinHttpTurnDeps extends DevinHttpDeps {
  /** Test seam: thresholds for the loop guard. Production leaves this unset. */
  loopGuardDeps?: DevinLoopGuardDeps;
  /** Named tool calls allowed per generation attempt before the stream is aborted. */
  maxToolCallsPerTurn?: number;
  /** Automatic continue-requests allowed per turn after mid-stream stalls. */
  maxContinuationsPerTurn?: number;
  /** Test seam: resolve the credential without touching disk or the provider config. */
  token?: string;
  timeoutMs?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The `Metadata.apiKey` credential for this turn, in the documented precedence order. */
function resolveToken(provider: OcxProviderConfig, deps: DevinHttpTurnDeps): string {
  if (deps.token) return deps.token;
  const resolved = resolveDevinToken(provider);
  // Routing diagnostic: shape only, never credential material. Worth keeping because the two
  // resolution sources behave differently under multi-account setups and this disambiguates
  // a 401 without logging any secret.
  debugProviderDiagnostic("devin-http", "token-resolution", {
    length: resolved.length,
    hasSessionPrefix: resolved.startsWith("devin-session-token$"),
    startsWithJwt: resolved.startsWith("eyJ"),
    fromApiKey: Boolean(provider.apiKey?.trim()),
  });
  return resolved;
}

// ─── Request projection ─────────────────────────────────────────────────────

function messageText(message: OcxMessage): string {
  if (message.role === "user") {
    return typeof message.content === "string"
      ? message.content
      : message.content.map(part => (part.type === "text" ? part.text : "")).join("");
  }
  if (message.role === "toolResult") {
    return typeof message.content === "string"
      ? message.content
      : message.content.map(part => (part.type === "text" ? part.text : "")).join("");
  }
  if (message.role === "developer") {
    return typeof message.content === "string"
      ? message.content
      : message.content.map(part => (part.type === "text" ? part.text : "")).join("");
  }
  // The assistant fallback deliberately SKIPS thinking parts: replayed thinking rides its own
  // `#11` field (see `projectDevinPrompts`), and folding it into the `#3` prompt text as well
  // would send the same reasoning twice on one message.
  return message.content
    .map(part => {
      if (part.type === "text") return part.text;
      return "";
    })
    .join("");
}

function messageImages(message: OcxMessage): ImageData[] {
  if (message.role !== "user" && message.role !== "toolResult") return [];
  if (typeof message.content === "string") return [];
  const images: ImageData[] = [];
  for (const part of message.content) {
    if (part.type !== "image") continue;
    // Only inline data URLs carry bytes; a remote URL would need a fetch the adapter must not do
    // implicitly, so it is dropped rather than inlined as text.
    const match = part.imageUrl.match(/^data:([^;]+);base64,(.+)$/s);
    if (match) images.push({ mimeType: match[1]!, base64Data: match[2]! });
  }
  return images;
}

/**
 * The Responses parser synthesizes a JSON signature from the whole reasoning item when the
 * client did not supply one (`JSON.stringify(reasoning)`). That blob is not a Devin thinking
 * signature — forwarding it as `#12` would be a lie. Real Devin signatures are opaque non-JSON
 * blobs issued by the upstream.
 */
function firstReplayableThinkingSignature(
  parts: Array<Extract<OcxAssistantContentPart, { type: "thinking" }>>,
): string | undefined {
  for (const part of parts) {
    const signature = part.signature?.trim();
    if (!signature) continue;
    if (signature.startsWith("{") || signature.startsWith("[")) {
      try {
        JSON.parse(signature);
        continue;
      } catch {
        /* not JSON — a real Devin blob may happen to start with `{` */
      }
    }
    return signature;
  }
  return undefined;
}

function assistantToolCalls(message: OcxMessage): ChatToolCall[] | undefined {
  if (message.role !== "assistant") return undefined;
  const calls = message.content.filter((part): part is Extract<OcxAssistantContentPart, { type: "toolCall" }> => part.type === "toolCall");
  if (calls.length === 0) return undefined;
  return calls.map(call => ({
    id: call.id,
    // The wire name is the namespaced one, matching what the model was offered. A bare name here
    // would replay a call the model never made and break the continuation's tool identity.
    name: namespacedToolName(call.namespace, call.name),
    argumentsJson: JSON.stringify(call.arguments ?? {}),
  }));
}

/**
 * Project the conversation into `ChatMessagePrompt` rows.
 *
 * `messageId` is derived deterministically from (cascadeId, index, role). The upstream accepts any
 * stable opaque id — it is used for correlation, not validation — and deriving it means a retried
 * turn that produces an identical conversation also produces identical ids, which is what keeps the
 * prompt cache warm across a retry.
 *
 * Assistant turns replay as `ASSISTANT` (wire value 2) — the observed client's source for the
 * model's own prior output. Empty assistant turns (no text, no tool calls, no thinking) are
 * dropped: sending them verbatim measurably provokes repeated empty completions.
 */
export function projectDevinPrompts(messages: OcxMessage[], cascadeId: string): ChatMessagePrompt[] {
  const prompts: ChatMessagePrompt[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === "user") {
      const images = messageImages(message);
      prompts.push({
        messageId: deterministicMessageId(`${cascadeId}\0${index}\0user`),
        source: ChatMessageSource.USER,
        prompt: messageText(message),
        ...(images.length > 0 ? { images } : {}),
      });
      continue;
    }

    if (message.role === "assistant") {
      const toolCalls = assistantToolCalls(message);
      const thinkingParts = message.content.filter(
        (part): part is Extract<OcxAssistantContentPart, { type: "thinking" }> => part.type === "thinking",
      );
      const thinking = thinkingParts.map(part => part.thinking).join("");
      const prompt = messageText(message);
      if (!prompt.trim() && !toolCalls && !thinking) continue;
      const signature = firstReplayableThinkingSignature(thinkingParts);
      prompts.push({
        messageId: `bot-${deterministicMessageId(`${cascadeId}\0${index}\0assistant`)}`,
        source: ChatMessageSource.ASSISTANT,
        prompt,
        ...(thinking ? { thinking } : {}),
        ...(signature ? { signature } : {}),
        ...(toolCalls ? { toolCalls } : {}),
      });
      continue;
    }

    if (message.role === "toolResult") {
      const images = messageImages(message);
      prompts.push({
        messageId: deterministicMessageId(`${cascadeId}\0${index}\0tool\0${message.toolCallId}`),
        source: ChatMessageSource.TOOL,
        toolCallId: message.toolCallId,
        toolResultIsError: message.isError,
        prompt: messageText(message),
        ...(images.length > 0 ? { images } : {}),
      });
    }
    // Developer messages are folded into the system prompt by `collectSystemPrompt`.
  }
  return prompts;
}

/**
 * FNV-1a over the seed, padded into a UUID shape.
 *
 * The upstream treats the id as opaque, and a real UUID would be 16 random bytes of work per
 * message for no benefit. Stability is the only property that matters.
 */
function deterministicMessageId(seed: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  return `${hex}-0000-4000-8000-000000000000`;
}

/** System prompt plus any `developer` messages, in order. */
export function collectSystemPrompt(parsed: OcxParsedRequest): string {
  const parts: string[] = [];
  for (const line of parsed.context.systemPrompt ?? []) {
    if (line?.trim()) parts.push(line);
  }
  for (const message of parsed.context.messages) {
    if (message.role === "developer") {
      const text = messageText(message);
      if (text.trim()) parts.push(text);
    }
  }
  return parts.join("\n\n");
}

export function toDevinToolDefinitions(
  tools: OcxTool[] | undefined,
  toolChoice?: OcxParsedRequest["options"]["toolChoice"],
): ChatToolDefinition[] {
  if (!tools || tools.length === 0) return [];
  // `tool_choice: "none"` must remove the callable surface, not merely discourage it: the guard in
  // src/server/responses/terminal-guard.ts reads an empty tool list as "this turn cannot call", and a
  // model offered a tool it was told not to use still sometimes calls it.
  const allowed = toolChoiceToolPredicate(toolChoice, tools);
  return tools
    .filter(tool => allowed(tool))
    .map(tool => ({
      name: namespacedToolName(tool.namespace, tool.name),
      description: tool.description ?? "",
      jsonSchemaString: JSON.stringify(tool.parameters ?? { type: "object" }),
      strict: tool.strict === true,
    }));
}

/**
 * The wire `tool_choice` for a request.
 *
 * Exported because the registry-wide tool-conformance harness needs to observe the selector the
 * adapter actually emits; it is not part of the adapter's public request surface.
 */
export { toDevinToolChoice as toDevinToolChoiceForConformance };

function toDevinToolChoice(
  choice: OcxParsedRequest["options"]["toolChoice"],
  tools: OcxTool[] | undefined,
): { optionName?: string; toolName?: string } {
  if (!choice || choice === "auto") return { optionName: "auto" };
  if (choice === "none") return { optionName: "none" };
  if (choice === "required") return { optionName: "required" };
  if (isAllowedToolChoice(choice)) {
    // Cascade has no allowlist selector. `auto` matches the caller's intent of "the model picks
    // from this set" and the filter in `toDevinToolDefinitions` already narrowed the offered set,
    // so the allowlist is enforced by what was advertised rather than by the choice field.
    return { optionName: "auto" };
  }
  // A named tool must be pinned by its WIRE name, so a namespaced selector resolves through the
  // same catalog the definitions were built from.
  return { optionName: "required", toolName: resolveToolChoiceWireName(tools, choice.name) };
}

export function toCompletionConfiguration(parsed: OcxParsedRequest): CompletionConfiguration {
  const requestedTemperature = parsed.options.temperature;
  // See MIN_PRESENT_TEMPERATURE: a literal 0 is dropped by proto3 and rejected upstream.
  const temperature = requestedTemperature === 0
    ? MIN_PRESENT_TEMPERATURE
    : (requestedTemperature ?? DEFAULT_TEMPERATURE);
  const maxTokens = parsed.options.maxOutputTokens && parsed.options.maxOutputTokens > 0
    ? BigInt(Math.floor(parsed.options.maxOutputTokens))
    : BigInt(DEFAULT_MAX_TOKENS);
  const topP = parsed.options.topP ?? DEFAULT_TOP_P;
  // The server rejects out-of-range sampling values outright, so clamp rather than forward.
  const safeTopP = topP > 0 && topP <= 1 ? topP : DEFAULT_TOP_P;
  return {
    numCompletions: 1n,
    maxTokens,
    maxNewlines: DEFAULT_MAX_NEWLINES,
    temperature,
    firstTemperature: temperature,
    topK: DEFAULT_TOP_K,
    topP: safeTopP,
    stopPatterns: [...DEFAULT_STOP_PATTERNS, ...(parsed.options.stopSequences ?? [])],
    fimEotProbThreshold: 1,
  };
}

/**
 * Resolve the exact roster uid for the routed model at the routed effort.
 *
 * Preference order is the live-seed map, then the routed id verbatim. The verbatim fallback
 * matters for an id the user typed that the seed does not know: forwarding it lets the server
 * answer with its own error instead of this adapter inventing a "not found" for a model that the
 * account may well have (the seed is a snapshot, and entitlements change).
 */
export function resolveWireUid(modelId: string, effort?: string): string {
  const rungs = DEVIN_HTTP_MODEL_WIRE_UIDS[modelId];
  if (rungs) {
    // The default rung is part of the seed and MUST be threaded through: without it a selection of
    // `swe-2` with no explicit effort would send the bare `swe-2` uid, which the server answers with
    // permission_denied (verified live — the family ships no bare uid at all).
    const resolved = resolveDevinWireUid({
      wireUids: rungs,
      defaultEffort: DEVIN_HTTP_MODEL_DEFAULT_REASONING_EFFORTS[modelId],
    }, effort);
    if (resolved) return resolved;
  }
  if (effort) return `${modelId}-${effort}`;
  return modelId;
}

// ─── Response mapping ───────────────────────────────────────────────────────

export function stopReasonToDevinStopReason(stopReason: number, hasToolCalls: boolean): string {
  if (hasToolCalls || stopReason === StopReason.FUNCTION_CALL) return "tool_calls";
  if (stopReason === StopReason.MAX_TOKENS) return "length";
  return "stop";
}

// ─── The turn ───────────────────────────────────────────────────────────────

export async function runDevinHttpTurn(
  provider: OcxProviderConfig,
  parsed: OcxParsedRequest,
  incoming: IncomingMeta,
  emit: (event: AdapterEvent) => void,
  deps: DevinHttpTurnDeps = {},
): Promise<void> {
  const timeoutMs = deps.timeoutMs ?? TURN_TIMEOUT_MS;

  if (incoming.abortSignal?.aborted) {
    emit({ type: "error", message: "Devin turn was aborted before start.", retryable: false });
    return;
  }

  let token: string;
  try {
    token = resolveToken(provider, deps);
  } catch (error) {
    if (error instanceof DevinMissingCredentialError) {
      emit({
        type: "error",
        message: error.message,
        status: 401,
        errorType: "invalid_request_error",
        code: "missing_credential",
        retryable: false,
      });
      return;
    }
    throw error;
  }

  const modelUid = resolveWireUid(parsed.modelId, typeof parsed.options.reasoning === "string" ? parsed.options.reasoning : undefined);
  // Conversation identity is stable per conversation (see the module comment): a fresh uuid per
  // turn reads as N brand-new sessions upstream. History replay below stays unchanged — only the
  // identity fields differ between turns.
  const session = resolveDevinSessionIdentity(parsed.context.messages, {
    randomId: deps.randomId,
    now: deps.now,
  });

  // Loop guard: the conversation-scoped step budget (see loop-fuse.ts). Steering appends a
  // user prompt to THIS request — auto-continue, never written back to the client's history.
  // A fail action is the budget-exhausted hard stop: a non-retryable error so a retrying client
  // cannot spin the same turn forever.
  const loopGuard = new DevinLoopGuard(session.cascadeId, deps.loopGuardDeps);
  const guardAction = loopGuard.evaluate(parsed.context.messages);
  if (guardAction.kind === "fail") {
    debugProviderDiagnostic("devin-http", "loop-guard", { action: "fail", reason: guardAction.reason });
    emit({
      type: "error",
      message: guardAction.message,
      status: 400,
      errorType: "invalid_request_error",
      code: "loop_guard",
      retryable: false,
    });
    return;
  }
  const replayMessages = guardAction.kind === "steer"
    ? [
      ...parsed.context.messages,
      { role: "user" as const, content: guardAction.message, timestamp: Date.now() },
    ]
    : parsed.context.messages;
  if (guardAction.kind === "steer") {
    debugProviderDiagnostic("devin-http", "loop-guard", { action: "steer", reason: guardAction.reason });
  }

  // Image prep (images.ts): the upstream nginx caps the whole protobuf body at ~14 MB
  // and every turn replays all history, so one oversized screenshot would 413 every
  // subsequent request. Normalize BEFORE projection; fail-open — a broken pipeline
  // must degrade to the old behavior, never fail the turn.
  let preparedMessages = replayMessages;
  try {
    preparedMessages = await prepareDevinImages(replayMessages);
  } catch (error) {
    debugProviderDiagnostic("devin-http", "image-prepare-failed", { error: errorMessage(error) });
  }

  // Terminal-event discipline: exactly one terminal frame per turn, whichever path reaches it
  // first. The upstream can deliver an end-stream error after content, and the wall clock can fire
  // while the stream is still open; both must not produce a second terminal.
  let terminalEmitted = false;
  const emitOnce = (event: AdapterEvent): void => {
    if (event.type === "done" || event.type === "error" || event.type === "incomplete") {
      if (terminalEmitted) return;
      terminalEmitted = true;
    }
    emit(event);
  };

  const timeoutTimer = setTimeout(() => {
    emitOnce({
      type: "error",
      message: "Devin turn timed out.",
      status: 504,
      errorType: "upstream_error",
      code: "timeout",
      retryable: true,
    });
  }, timeoutMs);
  const onAbort = (): void => {
    emitOnce({ type: "error", message: "Devin turn was aborted.", retryable: false });
  };
  incoming.abortSignal?.addEventListener("abort", onAbort, { once: true });

  let usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | undefined;
  let stopReason: number = StopReason.UNSPECIFIED;
  let emittedToolCall = false;
  // Intra-turn flood cap: named calls only (argument fragments carry no identity). Observed
  // runaway: 12k+ frames in a single turn.
  let namedToolCallsThisTurn = 0;
  const maxToolCallsPerTurn = deps.maxToolCallsPerTurn ?? LOOP_GUARD_MAX_TOOL_CALLS_PER_TURN;
  // Flips on the first text or tool-call delta. Trailing thinking AFTER TEXT is swallowed (it
  // would open a reasoning item on top of a message). Trailing thinking after a tool-call-only
  // turn is buffered and flushed at end-of-turn, once every call is closed.
  let answerStarted = false;
  let textEmitted = false;
  let trailingThinking = "";
  let trailingSignature = "";

  /**
   * Tool-call assembly state.
   *
   * The server may deliver a call whole or in fragments (see the module comment), and the two shapes
   * are distinguished only by whether a frame carries an id. `openToolCalls` therefore tracks the
   * calls already announced so a fragment lands on the right one, and a new id closes whatever was
   * open before it.
   */
  const openToolCalls = new Map<string, { emittedEnd: boolean; name: string; args: string }>();
  let currentToolCallId: string | undefined;

  const openToolCall = (id: string, name: string, initialArguments: string): void => {
    // A frame with an id always starts a NEW call: the server assigns a fresh id per call, so
    // seeing an id again would be a duplicate rather than a continuation.
    emittedToolCall = true;
    emit({ type: "tool_call_start", id, name });
    openToolCalls.set(id, { emittedEnd: false, name, args: initialArguments });
    currentToolCallId = id;
    if (initialArguments) emit({ type: "tool_call_delta", arguments: initialArguments });
  };

  const closeToolCall = (id: string): void => {
    const entry = openToolCalls.get(id);
    if (!entry || entry.emittedEnd) return;
    entry.emittedEnd = true;
    emit({ type: "tool_call_end" });
    if (currentToolCallId === id) currentToolCallId = undefined;
  };

  const closeAllToolCalls = (): void => {
    for (const id of openToolCalls.keys()) closeToolCall(id);
  };

  const flushTrailingThinking = (): void => {
    if (textEmitted || (!trailingThinking && !trailingSignature)) {
      trailingThinking = "";
      trailingSignature = "";
      return;
    }
    if (trailingThinking) emit({ type: "thinking_delta", thinking: trailingThinking });
    if (trailingSignature) emit({ type: "thinking_signature", signature: trailingSignature });
    trailingThinking = "";
    trailingSignature = "";
  };

  // Only a non-zero usage frame carries real numbers; every earlier frame is zeroed. Keeping the
  // last NON-ZERO frame is the difference between reporting real tokens and reporting zero.
  const recordUsage = (frame: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): void => {
    if (frame.inputTokens === 0 && frame.outputTokens === 0 && frame.cacheReadTokens === 0 && frame.cacheWriteTokens === 0) return;
    usage = frame;
  };

  try {
    const auth = await fetchUserJwt(token, deps, provider.baseUrl || DEVIN_CASCADE_BASE_URL, incoming.abortSignal);

    // Attempt loop: a mid-stream stall aborts the generation and issues a continuation request
    // carrying the partial output plus a continue prompt — the automated form of the client's
    // Continue button. Bounded by the per-turn continuation cap and the conversation's stall
    // budget inside the guard.
    let attemptMessages = preparedMessages;
    let continuations = 0;
    const maxContinuations = deps.maxContinuationsPerTurn ?? LOOP_GUARD_MAX_CONTINUATIONS_PER_TURN;
    // Partial output of the current attempt, replayed on a continuation so the model resumes
    // where it stopped instead of restarting the turn.
    let attemptText = "";

    attemptLoop: for (;;) {
      // Per-attempt state: each generation gets a fresh flood budget and a clean repetition
      // window. Turn-level flags (answerStarted, textEmitted, emittedToolCall) persist.
      namedToolCallsThisTurn = 0;
      trailingThinking = "";
      trailingSignature = "";
      openToolCalls.clear();
      currentToolCallId = undefined;
      attemptText = "";
      loopGuard.resetStreamState();
      let stalledReason: LoopGuardReason | null = null;
      let stalledMessage = "";

      const events = streamDevinChat({
        apiKey: token,
        userJwt: auth.userJwt,
        baseUrl: auth.baseUrl,
        modelUid,
        systemPrompt: collectSystemPrompt(parsed),
        request: {
          chatMessagePrompts: projectDevinPrompts(attemptMessages, session.cascadeId),
          configuration: toCompletionConfiguration(parsed),
          tools: toDevinToolDefinitions(parsed.context.tools, parsed.options.toolChoice),
          disableParallelToolCalls: parsed.options.parallelToolCalls === false,
          toolChoice: toDevinToolChoice(parsed.options.toolChoice, parsed.context.tools),
          cascadeId: session.cascadeId,
          executionId: session.executionId,
          modelConfig: { id: session.modelConfigId, turn: session.turn },
          // Explicit cache-affinity key (#27), mirroring the real client's language server: the
          // stable conversation id pins the prompt cache so a large tool result does not silently
          // evict the prefix mid-session.
          promptCacheKey: session.cascadeId,
        },
        ...(incoming.abortSignal ? { signal: incoming.abortSignal } : {}),
      }, deps);

      streamLoop: for await (const event of events) {
      switch (event.type) {
        case "delta": {
          // Repetition fuse on the live stream: a model restating one paragraph verbatim is a
          // loop the request-time checks cannot see. Abort and continue on a fresh request.
          const repetition = loopGuard.noteStreamText("thinking", event.thinking)
            ?? loopGuard.noteStreamText("text", event.text);
          if (repetition) {
            stalledReason = repetition;
            break streamLoop;
          }
          // Cascade can deliver thinking AFTER the answer (observed on swe-2: forward-planning
          // scratch, not a preamble). After TEXT that would open a reasoning item on top of a
          // message and the chat-completions translator rejects the stream — swallow it. After a
          // tool-call-only turn there is no message item, so the scratch is buffered and flushed
          // once every call is closed (see flushTrailingThinking).
          if (!answerStarted) {
            if (event.thinking) emit({ type: "thinking_delta", thinking: event.thinking });
            if (event.thinkingSignature) emit({ type: "thinking_signature", signature: event.thinkingSignature });
          } else if (!textEmitted) {
            if (event.thinking) trailingThinking += event.thinking;
            if (event.thinkingSignature) trailingSignature = event.thinkingSignature;
          }
          if (event.text) {
            answerStarted = true;
            textEmitted = true;
            trailingThinking = "";
            trailingSignature = "";
            attemptText += event.text;
            emit({ type: "text_delta", text: event.text });
          }
          break;
        }
        case "toolcalls": {
          answerStarted = true;
          // Two delivery shapes: a frame WITH an id opens a call; a frame with an EMPTY id carries
          // another slice of the open call's arguments. Emitting one call per frame (the naive
          // reading) produces N bogus empty-named calls for every fragmented stream.
          for (const call of event.calls) {
            const hasIdentity = Boolean(call.id || call.name);
            if (hasIdentity) {
              namedToolCallsThisTurn++;
              if (namedToolCallsThisTurn > maxToolCallsPerTurn) {
                stalledReason = "tool-call-flood";
                break streamLoop;
              }
              // A new call implicitly terminates the previous one, because the server never
              // interleaves two calls' fragments: each call's arguments complete before the next id.
              if (currentToolCallId) closeToolCall(currentToolCallId);
              openToolCall(
                call.id || `call_${openToolCalls.size}`,
                call.name,
                call.argumentsJson,
              );
            } else if (call.argumentsJson) {
              // Fragment: append to whatever call is open. With nothing open the frame is
              // unparseable, so it is dropped rather than attached to the wrong call.
              if (currentToolCallId) {
                const open = openToolCalls.get(currentToolCallId);
                if (open) open.args += call.argumentsJson;
                emit({ type: "tool_call_delta", arguments: call.argumentsJson });
              }
            }
          }
          if (event.calls.length > 0) {
            debugProviderDiagnostic("devin-http", "toolcalls", {
              frames: event.calls.length,
              named: event.calls.filter(call => call.id || call.name).map(call => call.name),
            });
          }
          break;
        }
        case "usage":
          recordUsage(event);
          break;
        case "stop":
          stopReason = event.stopReason;
          // Every call must be closed before the terminal, or the Responses bridge leaves an
          // unterminated item and the turn is rejected downstream.
          closeAllToolCalls();
          break;
        case "endStreamError": {
          // A terminal failure from the model side. Report it as such rather than as a clean end,
          // but keep any usage already observed so a failed turn still bills correctly.
          closeAllToolCalls();
          emitOnce({
            type: "error",
            message: `Devin stream error ${event.code}${event.message ? `: ${event.message}` : ""}`,
            status: event.code === "resource_exhausted" ? 429 : 502,
            errorType: event.code === "resource_exhausted" ? "rate_limit_error" : "upstream_error",
            code: event.code,
            retryable: event.code !== "invalid_argument" && event.code !== "permission_denied",
            ...(usage ? { usage: toOcxUsage(usage) } : {}),
          });
          return;
        }
        case "protocolError": {
          // Upstream silence is a stall, not a verdict: continue on a fresh request carrying
          // whatever was already produced. A stream that never produced anything retries the
          // identical request. The continuation/stall budgets bound it; exhaustion surfaces the
          // original timeout error below.
          stalledReason = "upstream-silent";
          stalledMessage = event.message;
          break streamLoop;
        }
        case "done":
          break;
      }
      }

      if (stalledReason) {
        closeAllToolCalls();
        const decision = loopGuard.noteStreamStall(stalledReason);
        debugProviderDiagnostic("devin-http", "loop-guard", {
          action: decision.kind,
          reason: stalledReason,
          continuation: continuations,
        });
        if (decision.kind === "fail" || continuations >= maxContinuations) {
          // A silent upstream keeps its own error shape — the stall was transport, not looping.
          emitOnce(stalledReason === "upstream-silent"
            ? {
              type: "error",
              message: stalledMessage || "Devin stream went silent.",
              status: 504,
              errorType: "upstream_error",
              code: "timeout",
              retryable: true,
              ...(usage ? { usage: toOcxUsage(usage) } : {}),
            }
            : {
              type: "error",
              message: decision.kind === "fail"
                ? decision.message
                : `Devin loop guard: generation stalled ${continuations + 1} times in one turn (${stalledReason}); the continuation budget is exhausted.`,
              status: 400,
              errorType: "invalid_request_error",
              code: "loop_guard",
              retryable: false,
            });
          return;
        }
        continuations++;
        // Replay the aborted generation as a partial assistant turn — text and the calls already
        // announced, no thinking — then the continue prompt. The model resumes mid-turn instead
        // of the client seeing an error.
        const partial: OcxMessage[] = [];
        const partialCalls = [...openToolCalls.entries()].map(([id, call]) => ({
          type: "toolCall" as const,
          id,
          name: call.name,
          arguments: parseToolArguments(call.args),
        }));
        if (attemptText || partialCalls.length > 0) {
          partial.push({
            role: "assistant",
            content: [
              ...(attemptText ? [{ type: "text" as const, text: attemptText }] : []),
              ...partialCalls,
            ],
            timestamp: Date.now(),
          });
        }
        // A silent stream that produced nothing retries the identical request — there is no
        // partial turn to resume and "you were cut off" would be a lie.
        const silentRetry = stalledReason === "upstream-silent" && partial.length === 0;
        attemptMessages = silentRetry
          ? attemptMessages
          : [
            ...attemptMessages,
            ...partial,
            { role: "user", content: decision.message, timestamp: Date.now() },
          ];
        continue attemptLoop;
      }
      break attemptLoop;
    }

    // A stream that ends without an explicit stop frame still needs its calls closed.
    closeAllToolCalls();
    flushTrailingThinking();
    // Only a cleanly completed turn feeds the empty-streak budget; upstream errors and client
    // aborts are not the model looping.
    loopGuard.recordOutcome(textEmitted || emittedToolCall);
    emitOnce({
      type: "done",
      stopReason: stopReasonToDevinStopReason(stopReason, emittedToolCall),
      ...(usage ? { usage: toOcxUsage(usage) } : {}),
    });
  } catch (error) {
    if (terminalEmitted) return;

    if (incoming.abortSignal?.aborted) {
      emitOnce({ type: "error", message: "Devin turn was aborted.", retryable: false });
      return;
    }

    const raw = errorMessage(error);
    const message = redactSecretString(raw);

    if (error instanceof DevinHttpError) {
      const unauthorized = error.status === 401 || error.status === 403;
      emitOnce({
        type: "error",
        message,
        status: error.status,
        errorType: error.status === 429 ? "rate_limit_error" : unauthorized ? "invalid_request_error" : "upstream_error",
        code: unauthorized ? "invalid_credential" : "upstream_error",
        // A credential problem is not retryable by repeating the identical request; a 5xx is.
        retryable: !unauthorized && error.status >= 500,
        ...(usage ? { usage: toOcxUsage(usage) } : {}),
      });
      return;
    }

    emitOnce({
      type: "error",
      message,
      status: 502,
      errorType: "upstream_error",
      code: "upstream_error",
      retryable: true,
      ...(usage ? { usage: toOcxUsage(usage) } : {}),
    });
  } finally {
    clearTimeout(timeoutTimer);
    incoming.abortSignal?.removeEventListener("abort", onAbort);
  }
}

/** Arguments arrive as a JSON string on the wire; a truncated fragment may not parse. */
function parseToolArguments(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* truncated or malformed — replay as empty arguments rather than dropping the call */
  }
  return {};
}

function toOcxUsage(usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) {
  // Devin reports inputTokens EXCLUSIVE of cache read/write, the same convention Anthropic
  // uses. Normalize to the canonical inclusive convention (types.ts OcxUsage / devlog 070):
  // downstream accounting and the Logs page both read inputTokens as the full prompt size.
  const inputTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const total = inputTokens + usage.outputTokens;
  return {
    inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: total,
    // Both spellings are set because different accounting paths read different ones, matching the
    // command-code and coding-agent adapters.
    ...(usage.cacheReadTokens > 0
      ? { cachedInputTokens: usage.cacheReadTokens, cacheReadInputTokens: usage.cacheReadTokens }
      : {}),
    ...(usage.cacheWriteTokens > 0 ? { cacheCreationInputTokens: usage.cacheWriteTokens } : {}),
  };
}
