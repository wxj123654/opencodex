import type { OcxAssistantContentPart, OcxMessage } from "../../types";

/**
 * Stable conversation identity for the devin-http adapter.
 *
 * ## Why stable ids at all
 *
 * The observed real client (devin.exe, calibrated from a 9-request live capture) does NOT mint a
 * fresh `#16 session_id` per request. One multi-turn conversation reuses ONE session id, carries a
 * stable `#15 ModelConfig { id, turn }` whose `turn` counts up monotonically per request, and
 * reuses ONE `#22 request_id` across the tool loop of a single user exchange while rotating it on
 * the next user message. Turn 1 carries NO `#22` at all.
 *
 * Minting a fresh random uuid per request — what this adapter did before — makes the upstream
 * velocity limiter read one agent loop as N brand-new sessions, and drops the model's conversation
 * into a shape it was never trained on. Both were observed live as cache collapses and, at
 * ~190 turns, as a fully degenerate same-command loop ending in a silent upstream stream.
 *
 * ## What this module does NOT do
 *
 * It does not resume server-side conversation state and does not change what history is sent:
 * every turn still replays the whole conversation. Only the identity fields become stable. The
 * server's view of history therefore remains a strict function of the request bytes, which is the
 * invariant the adapter's "stateless per turn" design was protecting.
 *
 * ## Session matching
 *
 * A conversation is recognized by its message-projection chain: each user/assistant/toolResult
 * message is hashed into a slot (role + bounded text + tool-call identity), and a stored chain
 * matches when it is a PREFIX of the incoming chain. Three outcomes:
 *
 * - **Extend** — incoming chain is longer and starts with the stored chain: same conversation,
 *   next turn. `turn += 1`.
 * - **Idempotent retry** — chains are equal: a retried request must produce identical ids (this
 *   also keeps the upstream prompt cache warm across the retry).
 * - **Miss** — no stored chain is a prefix (fork, truncation, or a genuinely new conversation):
 *   fresh identity, `turn = 1`.
 *
 * The chain deliberately excludes `thinking` (clients replay assistant turns with thinking
 * stripped or re-signed, which would fork the chain every turn) and `developer` messages (they
 * are folded into the system prompt and never reach `chatMessagePrompts`).
 *
 * Storage is in-memory, LRU-bounded and TTL-expired, keyed by the FIRST chain slot — the opening
 * user message of the conversation — with multiple chains allowed under one key (two conversations
 * opening with the same first message must not evict each other).
 */

/** Conversations idle longer than this are forgotten; their next turn starts a fresh identity. */
const SESSION_TTL_MS = 30 * 60 * 1000;
/** Hard ceiling on tracked conversations (LRU by last-seen), bounding memory to a few MB. */
const SESSION_MAX = 500;
/** Text per message that participates in the projection slot. Enough to fork early, cheap to hash. */
const PROJECTION_TEXT_CHARS = 256;
/** Tool-call material per call that participates in the projection slot. */
const PROJECTION_CALL_CHARS = 256;

export interface DevinSessionIdentityDeps {
  /** Replaces `crypto.randomUUID` so tests can pin generated ids. */
  randomId?: () => string;
  /** Test seam for TTL expiry. Production leaves this unset. */
  now?: () => number;
}

export interface DevinSessionIdentity {
  /** `#16` — stable across the whole conversation. */
  cascadeId: string;
  /** `#15.1` — stable per conversation, paired with `turn`. */
  modelConfigId: string;
  /**
   * `#22` — empty on the conversation's first turn (the observed client sends no `#22` there);
   * rotated per user exchange and shared across that exchange's tool loop.
   */
  executionId: string;
  /** `#15.2` — starts at 1, counts up once per request in the same conversation. */
  turn: number;
}

interface SessionState {
  cascadeId: string;
  modelConfigId: string;
  /** The current user exchange's request id; `""` only while only turn 1 has been sent. */
  executionId: string;
  /** Latest turn number handed out for this conversation. */
  turn: number;
  /** The projection chain as last seen; a longer chain with this prefix extends the session. */
  chain: string[];
  lastSeen: number;
}

const sessions = new Map<string, SessionState[]>();

/**
 * Resolve the stable identity for this turn, creating or extending a tracked conversation.
 *
 * Pure with respect to the message list: the same list always resolves to the same identity, and
 * a list that extends a tracked conversation reuses that conversation's ids.
 */
export function resolveDevinSessionIdentity(
  messages: OcxMessage[],
  deps: DevinSessionIdentityDeps = {},
): DevinSessionIdentity {
  const now = deps.now?.() ?? Date.now();
  const freshId = (): string => deps.randomId?.() ?? crypto.randomUUID();
  const chain = projectConversation(messages);
  prune(now);

  // No projectable content (e.g. a developer-only request): nothing to anchor a conversation on.
  // Hand out a one-shot identity without tracking it — the next request cannot extend a chain of
  // zero slots anyway.
  if (chain.length === 0) {
    return { cascadeId: freshId(), modelConfigId: freshId(), executionId: "", turn: 1 };
  }

  const root = chain[0]!;
  const tracked = sessions.get(root) ?? [];
  const match = longestPrefixMatch(tracked, chain);

  if (match) {
    const idempotent = match.state.chain.length === chain.length;
    const nextTurn = idempotent ? match.state.turn : match.state.turn + 1;
    // A request ending in a user message begins a new user exchange; one ending in a tool result
    // continues the current exchange's tool loop and must REUSE the exchange id. An assistant
    // tail is not a legal client shape; treating it as a continuation is the defensive read.
    const newExchange = !idempotent && endsWithUserMessage(messages);
    let executionId = match.state.executionId;
    if (!idempotent && (newExchange || executionId === "")) executionId = freshId();
    if (!idempotent) {
      match.state.chain = chain;
      match.state.turn = nextTurn;
      match.state.executionId = executionId;
    }
    match.state.lastSeen = now;
    // Re-append so Map insertion order tracks recency for the LRU sweep.
    tracked.splice(match.index, 1);
    tracked.push(match.state);
    return {
      cascadeId: match.state.cascadeId,
      modelConfigId: match.state.modelConfigId,
      executionId: idempotent ? match.state.executionId : executionId,
      turn: nextTurn,
    };
  }

  const state: SessionState = {
    cascadeId: freshId(),
    modelConfigId: freshId(),
    // Turn 1 of a conversation carries no #22 on the wire (calibrated against the observed
    // client); the first extension rotates in a real id above.
    executionId: "",
    turn: 1,
    chain,
    lastSeen: now,
  };
  tracked.push(state);
  sessions.set(root, tracked);
  return { cascadeId: state.cascadeId, modelConfigId: state.modelConfigId, executionId: "", turn: 1 };
}

/** Forget every tracked conversation. Test seam; production never resets. */
export function resetDevinSessionTracking(): void {
  sessions.clear();
}

interface PrefixMatch {
  state: SessionState;
  index: number;
}

function longestPrefixMatch(tracked: SessionState[], chain: string[]): PrefixMatch | null {
  let best: PrefixMatch | null = null;
  for (let i = 0; i < tracked.length; i++) {
    const state = tracked[i]!;
    if (state.chain.length > chain.length) continue;
    if (!isPrefix(state.chain, chain)) continue;
    // Longer stored chains are more specific: under one root key, the deepest tracked fork is
    // the one this request actually extends.
    if (!best || state.chain.length > best.state.chain.length) best = { state, index: i };
  }
  return best;
}

function isPrefix(candidate: string[], chain: string[]): boolean {
  for (let i = 0; i < candidate.length; i++) {
    if (candidate[i] !== chain[i]) return false;
  }
  return true;
}

function endsWithUserMessage(messages: OcxMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i]?.role;
    if (role === "user") return true;
    if (role === "assistant" || role === "toolResult") return false;
    // developer messages sit between exchanges; keep looking for the exchange-defining role.
  }
  return false;
}

function prune(now: number): void {
  let live = 0;
  for (const [root, tracked] of sessions) {
    const kept = tracked.filter(state => now - state.lastSeen < SESSION_TTL_MS);
    if (kept.length === 0) sessions.delete(root);
    else if (kept.length !== tracked.length) sessions.set(root, kept);
    live += kept.length;
  }
  if (live <= SESSION_MAX) return;
  // Flatten by lastSeen, oldest first, until the ceiling is met. Map insertion order per root
  // already tracks recency within a root; across roots the timestamp decides.
  const all = [...sessions.values()].flat().sort((a, b) => a.lastSeen - b.lastSeen);
  const doomed = new Set(all.slice(0, live - SESSION_MAX));
  for (const [root, tracked] of sessions) {
    const kept = tracked.filter(state => !doomed.has(state));
    if (kept.length === 0) sessions.delete(root);
    else if (kept.length !== tracked.length) sessions.set(root, kept);
  }
}

// ─── Projection ─────────────────────────────────────────────────────────────

/**
 * Hash each user/assistant/toolResult message into one opaque slot. FNV-1a over a bounded
 * prefix of the message's wire-relevant material; collisions only matter when two different
 * conversations share an opening slot, where the rest of the chain still forks them.
 */
function projectConversation(messages: OcxMessage[]): string[] {
  const chain: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      chain.push(fnv1a(`u\n${bounded(messageText(message))}`));
      continue;
    }
    if (message.role === "assistant") {
      const calls = message.content
        .filter((part): part is Extract<OcxAssistantContentPart, { type: "toolCall" }> => part.type === "toolCall")
        .map(part => `${part.id}|${part.namespace ?? ""}|${part.name}|${bounded(JSON.stringify(part.arguments ?? {}), PROJECTION_CALL_CHARS)}`)
        .join("\n");
      chain.push(fnv1a(`a\n${bounded(messageText(message))}\n${calls}`));
      continue;
    }
    if (message.role === "toolResult") {
      chain.push(fnv1a(`t\n${message.toolCallId}\n${message.isError ? "e" : "o"}\n${bounded(messageText(message))}`));
    }
    // developer: folded into the system prompt, never replayed as a chat message prompt.
  }
  return chain;
}

function bounded(text: string, max = PROJECTION_TEXT_CHARS): string {
  return text.length > max ? text.slice(0, max) : text;
}

function messageText(message: OcxMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map(part => (part.type === "text" ? part.text : ""))
    .join("");
}

function fnv1a(seed: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
