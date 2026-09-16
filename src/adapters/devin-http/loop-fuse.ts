import type { OcxAssistantContentPart, OcxMessage } from "../../types";
import { namespacedToolName } from "../../types";

/**
 * Loop protection for the devin-http adapter, modeled on the language server's own mechanism.
 *
 * Devin Desktop's Continue button is a *step budget* inside the local language server
 * (`max_generator_invocations`, confirmed in the shipped binary alongside
 * `num_generator_invocations` and the deprecated `auto_continue_on_max_generator_invocations`).
 * When the budget is spent the server stops generating and waits for the user to press Continue —
 * a hard stop, not a suggestion. This adapter is not that agent: the client runs the tools and
 * each HTTP request is one GetChatMessage, so the equivalent budget lives here as
 * `DevinLoopGuard`, keyed by the conversation's cascadeId.
 *
 * Three loop shapes are covered, because each was observed live:
 *
 * 1. **Similar tool-call streak** (the nowrap loop: 50+ greps of the same family). A streak
 *    requires the calls to be similar AND their results to be similar — same search, same
 *    answer, no progress. Calls that return different output are an investigation moving
 *    forward, not a loop, and break the streak. The first trips append a steering user prompt
 *    to THIS request — auto-continue, no button. If the model ignores the steering and trips
 *    again, the guard escalates to a hard non-retryable error, matching the language server's
 *    budget exhaustion.
 * 2. **Empty-completion retry loop**: the upstream returns no text and no tool call, and a
 *    retrying client resends the identical turn forever. Consecutive empties are counted per
 *    conversation; a steering prompt is injected first, then the turn hard-fails.
 * 3. **Intra-turn tool-call flood**: a single turn emitting an unbounded run of calls (observed:
 *    12k+ frames in one stream). The adapter caps the count and aborts the stream.
 * 4. **Thinking/text repetition**: the model restates one paragraph verbatim dozens of times,
 *    inside a single stream or replayed across turns. `detectRepeatedTail` finds a repeated
 *    trailing block; `noteStreamText` watches the live stream.
 *
 * Mid-stream stalls follow the real client's Continue button: the aborted generation is
 * replayed as a partial assistant turn plus a continue prompt on a NEW request, so the model
 * resumes where it stopped instead of the client seeing an error. The shared stall budget
 * (`stallTrips`) and a per-turn continuation cap bound it — exhaustion is the hard stop.
 *
 * All injections are request-local — nothing is written back into the client's history.
 */

/** Consecutive similar calls required to trip. Above ordinary 2–3 greps, below the live 50+. */
export const LOOP_FUSE_STREAK = 6;

/** Consecutive empty turns before a steering prompt is injected. */
export const LOOP_GUARD_EMPTY_STEER = 2;
/** Consecutive empty turns at which the turn hard-fails instead of steering. */
export const LOOP_GUARD_EMPTY_FAIL = 4;
/** Fuse trips per conversation before the turn hard-fails instead of steering. */
export const LOOP_GUARD_FUSE_TRIPS_FAIL = 4;
/** Named tool calls allowed per generation attempt before the stream is aborted. */
export const LOOP_GUARD_MAX_TOOL_CALLS_PER_TURN = 50;
/** Automatic continue-requests allowed per turn after mid-stream stalls. */
export const LOOP_GUARD_MAX_CONTINUATIONS_PER_TURN = 2;
/** Consecutive repeats of the same trailing block that count as a repetition loop. */
export const LOOP_GUARD_THINKING_REPEAT = 3;

/** Guard entries idle longer than this are dropped; conversations do not span days. */
const GUARD_TTL_MS = 6 * 60 * 60 * 1000;
/** Hard ceiling on tracked conversations; oldest-seen entries are evicted first. */
const GUARD_MAX_ENTRIES = 256;

const GENERIC_TOKENS = new Set([
  "cd", "ls", "cat", "sed", "awk", "head", "tail", "find", "grep", "echo", "true", "false",
  "null", "type", "from", "import", "export", "const", "function", "return", "document",
  "packages", "package", "src", "app", "node", "modules", "windows", "users", "local",
  "temp", "bin", "usr", "dev", "and", "the", "for", "with", "this", "that", "test", "tests",
  "include", "exclude", "path", "file", "line", "head", "tail", "echo", "bash", "shell",
  "command", "run", "true", "false", "null", "undefined", "string", "number",
]);

export interface LoopFuseTrip {
  family: string;
  streak: number;
}

export interface LoopFuseDeps {
  streak?: number;
}

export function detectToolCallStreak(messages: OcxMessage[], deps: LoopFuseDeps = {}): LoopFuseTrip | null {
  const threshold = deps.streak ?? LOOP_FUSE_STREAK;
  const calls = trailingToolCalls(messages);
  if (calls.length < threshold) return null;

  const last = calls[calls.length - 1]!;
  let streak = 1;
  for (let i = calls.length - 2; i >= 0; i--) {
    // Require similarity to the *last* call so a topic change in the middle still breaks, and
    // require the RESULTS to be similar too — a loop is the same question getting the same
    // answer. Different output means the investigation is making progress.
    if (!similarToolCalls(calls[i]!.call, last.call)) break;
    if (!similarResults(calls[i]!.result, last.result)) break;
    streak++;
  }
  if (streak < threshold) return null;
  return { family: describeFamily(last.call), streak };
}

export function loopFuseSteeringMessage(trip: LoopFuseTrip): string {
  return [
    "[opencodex loop fuse]",
    `You have issued ${trip.streak} similar tool calls in a row (family: ${trip.family}).`,
    "Stop searching the same pattern. Use the conclusion you already stated in this conversation (if any) and make the code change, or report that you cannot proceed.",
    "Do not repeat the same grep/sed/read family again.",
  ].join(" ");
}

interface TrailingCall {
  call: Extract<OcxAssistantContentPart, { type: "toolCall" }>;
  /** The tool result paired with this call, if the history carries one. */
  result?: string;
}

function trailingToolCalls(messages: OcxMessage[]): TrailingCall[] {
  const results = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "toolResult") results.set(message.toolCallId, toolResultText(message));
  }

  let end = messages.length - 1;
  while (end >= 0 && messages[end]!.role === "developer") end--;
  if (end < 0) return [];
  if (messages[end]!.role === "user") return [];

  const calls: TrailingCall[] = [];
  for (let i = end; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "developer") continue;
    if (message.role === "user") break;
    if (message.role === "toolResult") continue;
    if (message.role !== "assistant") break;
    const toolCalls = message.content.filter(
      (part): part is Extract<OcxAssistantContentPart, { type: "toolCall" }> => part.type === "toolCall",
    );
    const hasText = message.content.some(part => part.type === "text" && part.text.trim());
    if (toolCalls.length === 0) {
      if (hasText) break;
      continue;
    }
    for (let c = toolCalls.length - 1; c >= 0; c--) {
      const call = toolCalls[c]!;
      calls.unshift({ call, result: results.get(call.id) });
    }
  }
  return calls;
}

function toolResultText(message: OcxMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map(part => (part.type === "text" ? part.text : ""))
    .join("");
}

/**
 * Are two tool results the same answer? Exact match after whitespace normalization, or a high
 * token overlap. A missing result is unknown, not dissimilar — it must not break the streak on
 * its own. One empty and one non-empty result are different outcomes.
 */
function similarResults(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return true;
  const na = a.replace(/\s+/g, " ").trim();
  const nb = b.replace(/\s+/g, " ").trim();
  if (na === nb) return true;
  if (na.length === 0 || nb.length === 0) return false;
  const tokensA = new Set(tokenize(na));
  const tokensB = new Set(tokenize(nb));
  if (tokensA.size === 0 || tokensB.size === 0) return false;
  return jaccard(tokensA, tokensB) >= 0.75;
}

function similarToolCalls(
  a: Extract<OcxAssistantContentPart, { type: "toolCall" }>,
  b: Extract<OcxAssistantContentPart, { type: "toolCall" }>,
): boolean {
  const nameA = namespacedToolName(a.namespace, a.name);
  const nameB = namespacedToolName(b.namespace, b.name);
  if (nameA !== nameB) return false;
  // Shell commands in different verb families are different operations even when they share
  // path tokens: `npx vitest run` and `cat package.json` both mention the same directory but
  // one runs tests and the other reads a file.
  if (isShellToolName(nameA)) {
    const famA = commandFamilies(typeof a.arguments?.command === "string" ? a.arguments.command : "");
    const famB = commandFamilies(typeof b.arguments?.command === "string" ? b.arguments.command : "");
    if (famA.size > 0 && famB.size > 0) {
      let shared = false;
      for (const fam of famA) if (famB.has(fam)) shared = true;
      if (!shared) return false;
    }
  }
  const tokensA = significantTokens(a);
  const tokensB = significantTokens(b);
  if (tokensA.size === 0 && tokensB.size === 0) return true;
  let shared = 0;
  for (const token of tokensA) if (tokensB.has(token)) shared++;
  if (shared >= 1) return true;
  return jaccard(tokensA, tokensB) >= 0.3;
}

function describeFamily(call: Extract<OcxAssistantContentPart, { type: "toolCall" }>): string {
  const name = namespacedToolName(call.namespace, call.name);
  const tokens = [...significantTokens(call)].sort().slice(0, 4);
  return tokens.length > 0 ? `${name}:${tokens.join(",")}` : name;
}

function significantTokens(call: Extract<OcxAssistantContentPart, { type: "toolCall" }>): Set<string> {
  const args = call.arguments ?? {};
  const blobs: string[] = [];
  if (typeof args.command === "string") blobs.push(args.command);
  if (typeof args.path === "string") blobs.push(args.path);
  if (typeof args.file_path === "string") blobs.push(args.file_path);
  if (typeof args.pattern === "string") blobs.push(args.pattern);
  if (blobs.length === 0) blobs.push(JSON.stringify(args));
  const tokens = new Set<string>();
  for (const blob of blobs) {
    for (const word of tokenize(blob)) {
      if (GENERIC_TOKENS.has(word)) continue;
      tokens.add(word);
    }
  }
  return tokens;
}

function tokenize(text: string): string[] {
  const lower = text.toLowerCase().replace(/\\/g, "/");
  const words: string[] = [];
  for (const raw of lower.match(/[a-z][a-z0-9_]{2,}/g) ?? []) {
    for (const part of raw.split("_")) {
      if (part.length >= 3) words.push(part);
    }
  }
  return words;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const token of a) if (b.has(token)) inter++;
  return inter / (a.size + b.size - inter);
}

// ─── Shell verb families ────────────────────────────────────────────────────

const SHELL_TOOL_NAMES = new Set(["bash", "shell", "sh", "terminal", "cmd", "powershell", "zsh"]);

function isShellToolName(name: string): boolean {
  return SHELL_TOOL_NAMES.has(name.toLowerCase());
}

/**
 * Command verbs grouped by what they DO, not how they are spelled. A loop repeats one kind of
 * operation; alternating between families (run tests, then read a file) is normal work.
 */
const COMMAND_FAMILIES: ReadonlyArray<ReadonlySet<string>> = [
  // read / search / inspect
  new Set(["grep", "rg", "sed", "awk", "cat", "head", "tail", "ls", "find", "fd", "less", "more", "wc", "tree", "dir", "type", "sort", "uniq", "diff", "stat", "file", "strings", "which", "where", "pwd", "echo", "printf"]),
  // build / run / test
  new Set(["npx", "npm", "bun", "bunx", "node", "deno", "yarn", "pnpm", "vitest", "jest", "mocha", "tsc", "tsx", "python", "python3", "pytest", "pip", "cargo", "go", "make", "cmake", "mvn", "gradle", "dotnet", "java", "gcc", "clang"]),
  // version control
  new Set(["git", "gh", "svn", "hg"]),
  // network
  new Set(["curl", "wget", "ssh", "scp", "rsync", "ping"]),
  // containers / infra
  new Set(["docker", "kubectl", "helm", "podman", "systemctl", "service"]),
];

function commandFamilies(command: string): Set<number> {
  const families = new Set<number>();
  // Split on shell separators and take each word's basename so `npx`, `go`, and
  // `/usr/bin/grep` all resolve to their verb. `tokenize` would drop two-letter verbs.
  for (const raw of command.toLowerCase().split(/[\s|&;<>(){}"'`]+/)) {
    const word = raw.replace(/^[\w.-]*[\\/]/, "").replace(/\.exe$/, "");
    if (word.length < 2) continue;
    for (let i = 0; i < COMMAND_FAMILIES.length; i++) {
      if (COMMAND_FAMILIES[i]!.has(word)) families.add(i);
    }
  }
  return families;
}

// ─── Conversation-scoped loop guard ─────────────────────────────────────────

export type LoopGuardReason =
  | "tool-call-streak"
  | "empty-completion"
  | "thinking-repetition"
  | "tool-call-flood"
  | "upstream-silent";

export type LoopGuardAction =
  | { kind: "none" }
  | { kind: "steer"; message: string; reason: LoopGuardReason }
  | { kind: "fail"; message: string; reason: LoopGuardReason };

interface GuardState {
  emptyStreak: number;
  /** Escalation counter shared by every stall detector — the budget is per conversation. */
  stallTrips: number;
  lastSeen: number;
}

const guardStates = new Map<string, GuardState>();

export interface DevinLoopGuardDeps {
  now?: () => number;
  streak?: number;
  emptySteer?: number;
  emptyFail?: number;
  fuseTripsFail?: number;
}

/**
 * Per-conversation loop budget. One instance per turn; state persists across turns via the
 * cascadeId-keyed map, mirroring how the language server counts `num_generator_invocations`
 * inside a session.
 *
 * Lifecycle: `evaluate()` before the request is sent (may steer or fail), `recordOutcome()`
 * once the turn's terminal state is known. A turn that errored or was client-aborted records
 * nothing — only a clean empty completion counts against the budget.
 */
export class DevinLoopGuard {
  private readonly state: GuardState;
  private fuseTrippedThisTurn = false;

  constructor(
    private readonly cascadeId: string,
    private readonly deps: DevinLoopGuardDeps = {},
  ) {
    const now = this.deps.now?.() ?? Date.now();
    pruneGuardStates(now);
    let state = guardStates.get(cascadeId);
    if (!state) {
      state = { emptyStreak: 0, stallTrips: 0, lastSeen: now };
      guardStates.set(cascadeId, state);
    }
    state.lastSeen = now;
    // Re-insert so Map order tracks recency for the eviction sweep.
    guardStates.delete(cascadeId);
    guardStates.set(cascadeId, state);
    this.state = state;
  }

  /**
   * Decide what this turn should do before it is sent. Steering appends a user prompt to the
   * outgoing request; failing returns a terminal error the adapter emits without calling upstream.
   */
  evaluate(messages: OcxMessage[]): LoopGuardAction {
    const failAt = this.deps.fuseTripsFail ?? LOOP_GUARD_FUSE_TRIPS_FAIL;

    const trip = detectToolCallStreak(messages, { streak: this.deps.streak });
    if (trip) {
      this.fuseTrippedThisTurn = true;
      this.state.stallTrips++;
      if (this.state.stallTrips >= failAt) {
        return {
          kind: "fail",
          reason: "tool-call-streak",
          message: `Devin loop guard: ${this.state.stallTrips} ignored steering attempts for repeated ${trip.family} calls; stopping the turn instead of continuing the loop.`,
        };
      }
      return { kind: "steer", reason: "tool-call-streak", message: loopFuseSteeringMessage(trip) };
    }

    const repeated = detectThinkingRepetition(messages);
    if (repeated) {
      this.fuseTrippedThisTurn = true;
      this.state.stallTrips++;
      if (this.state.stallTrips >= failAt) {
        return {
          kind: "fail",
          reason: "thinking-repetition",
          message: `Devin loop guard: ${this.state.stallTrips} ignored steering attempts while the model kept restating the same passage; stopping the turn.`,
        };
      }
      return {
        kind: "steer",
        reason: "thinking-repetition",
        message: [
          "[opencodex loop guard]",
          "Your previous reply restated the same passage over and over.",
          "Do not repeat it. Commit to one option and produce the final answer or the concrete next action now.",
        ].join(" "),
      };
    }

    const steerAt = this.deps.emptySteer ?? LOOP_GUARD_EMPTY_STEER;
    const emptyFailAt = this.deps.emptyFail ?? LOOP_GUARD_EMPTY_FAIL;
    if (this.state.emptyStreak >= emptyFailAt) {
      return {
        kind: "fail",
        reason: "empty-completion",
        message: `Devin loop guard: ${this.state.emptyStreak} consecutive empty completions in this conversation; refusing to retry the identical turn.`,
      };
    }
    if (this.state.emptyStreak >= steerAt) {
      return {
        kind: "steer",
        reason: "empty-completion",
        message: [
          "[opencodex loop guard]",
          `Your previous ${this.state.emptyStreak} replies in this conversation were empty (no text, no tool call).`,
          "Produce output now: answer the user, make the tool call you were about to make, or explain in text why you cannot proceed.",
        ].join(" "),
      };
    }
    return { kind: "none" };
  }

  /**
   * Record how the turn ended. `producedOutput` is the downstream definition of non-empty: any
   * text or tool call. A stall-tripped turn that produced output does NOT reset the trip
   * counter — the model ignored the steering and kept looping, which is what escalation is for.
   */
  recordOutcome(producedOutput: boolean): void {
    if (producedOutput) {
      this.state.emptyStreak = 0;
      if (!this.fuseTrippedThisTurn) this.state.stallTrips = 0;
    } else {
      this.state.emptyStreak++;
    }
  }

  private streamThinking = "";
  private streamText = "";
  private lastCheckedThinking = 0;
  private lastCheckedText = 0;

  /**
   * Watch the live stream for a repetition loop. Returns the stall reason once the tail of the
   * accumulated thinking or text is the same block repeated; the adapter aborts the stream and
   * asks `noteStreamStall` whether to continue or fail. Checked at most once per 256
   * accumulated characters per channel.
   */
  noteStreamText(kind: "thinking" | "text", delta: string): LoopGuardReason | null {
    if (!delta) return null;
    if (kind === "thinking") {
      this.streamThinking += delta;
      if (this.streamThinking.length - this.lastCheckedThinking < 256) return null;
      this.lastCheckedThinking = this.streamThinking.length;
      if (!detectRepeatedTail(this.streamThinking)) return null;
    } else {
      this.streamText += delta;
      if (this.streamText.length - this.lastCheckedText < 256) return null;
      this.lastCheckedText = this.streamText.length;
      if (!detectRepeatedTail(this.streamText)) return null;
    }
    return "thinking-repetition";
  }

  /**
   * A generation was aborted mid-stream. Returns "continue" with the prompt for the follow-up
   * request — the adapter replays the partial output and keeps the turn alive — or "fail" once
   * the conversation's stall budget is spent.
   */
  noteStreamStall(reason: LoopGuardReason): { kind: "continue"; message: string } | { kind: "fail"; message: string } {
    this.fuseTrippedThisTurn = true;
    this.state.stallTrips++;
    const failAt = this.deps.fuseTripsFail ?? LOOP_GUARD_FUSE_TRIPS_FAIL;
    if (this.state.stallTrips >= failAt) {
      return {
        kind: "fail",
        message: `Devin loop guard: ${this.state.stallTrips} stalls in this conversation (${reason}); the budget is exhausted, stopping the turn.`,
      };
    }
    const detail = reason === "tool-call-flood"
      ? "Your previous reply was cut off for issuing too many tool calls in one turn."
      : reason === "upstream-silent"
        ? "Your previous reply was cut off when the connection went quiet."
        : "Your previous reply was cut off because it repeated the same passage.";
    return {
      kind: "continue",
      message: [
        "[opencodex loop guard]",
        detail,
        "Continue from where you stopped WITHOUT repeating it: use the results you already have and produce the concrete next action or the final answer.",
      ].join(" "),
    };
  }

  /** Clear the stream accumulators between generation attempts of the same turn. */
  resetStreamState(): void {
    this.streamThinking = "";
    this.streamText = "";
    this.lastCheckedThinking = 0;
    this.lastCheckedText = 0;
  }
}

/** Forget every tracked conversation. Test seam; production never resets. */
export function resetDevinLoopGuard(): void {
  guardStates.clear();
}

// ─── Repetition detection ───────────────────────────────────────────────────

/**
 * Does the tail of `text` consist of one block repeated at least `minRepeats` times?
 *
 * Two block shapes are tried: the last paragraph (blank-line separated) for prose-style
 * repetition, and a fixed 120-char chunk for repetition without paragraph breaks. Whitespace
 * is normalized so rewrapped repeats still match.
 */
export function detectRepeatedTail(text: string, minRepeats = LOOP_GUARD_THINKING_REPEAT): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length < 60) return false;

  const paragraphs = text.split(/\n\s*\n/).map(p => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  const lastParagraph = paragraphs.at(-1) ?? "";
  if (lastParagraph.length >= 40 && countTailRepeats(paragraphs, lastParagraph) >= minRepeats) {
    return true;
  }

  // No paragraph structure: find the repeat unit by scanning candidate periods. The unit length
  // is unknown (a 76-char sentence repeats just as well as a 200-char paragraph), so try every
  // period that can fit `minRepeats` copies in the tail.
  const maxUnit = Math.min(600, Math.floor(normalized.length / minRepeats));
  for (let unit = 40; unit <= maxUnit; unit++) {
    const tail = normalized.slice(-unit);
    let repeats = 1;
    for (let end = normalized.length - unit; end - unit >= 0; end -= unit) {
      if (normalized.slice(end - unit, end) !== tail) break;
      repeats++;
    }
    if (repeats >= minRepeats) return true;
  }
  return false;
}

function countTailRepeats(paragraphs: string[], block: string): number {
  let repeats = 0;
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    if (paragraphs[i] !== block) break;
    repeats++;
  }
  return repeats;
}

/**
 * Cross-turn repetition: the last assistant message's own thinking or text is already a
 * repetition loop, so replaying it unchanged would invite another one.
 */
export function detectThinkingRepetition(messages: OcxMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "developer" || message.role === "toolResult") continue;
    if (message.role !== "assistant" || typeof message.content === "string") return false;
    const thinking = message.content
      .filter((part): part is Extract<OcxAssistantContentPart, { type: "thinking" }> => part.type === "thinking")
      .map(part => part.thinking)
      .join("");
    const text = message.content
      .filter(part => part.type === "text")
      .map(part => (part as { text: string }).text)
      .join("");
    return detectRepeatedTail(thinking) || detectRepeatedTail(text);
  }
  return false;
}

function pruneGuardStates(now: number): void {
  for (const [key, state] of guardStates) {
    if (now - state.lastSeen > GUARD_TTL_MS) guardStates.delete(key);
  }
  while (guardStates.size > GUARD_MAX_ENTRIES) {
    const oldest = guardStates.keys().next().value;
    if (oldest === undefined) break;
    guardStates.delete(oldest);
  }
}
