import { readBoundedResponseBody } from "../lib/bounded-body";

const COMMAND_CODE_MODEL_EFFORTS = {
  "deepseek/deepseek-v4-pro": {
    efforts: ["high", "max"],
    profileUrl: "https://commandcode.ai/models/deepseek-v4-pro",
  },
  "deepseek/deepseek-v4-flash": {
    efforts: ["high", "max"],
    profileUrl: "https://commandcode.ai/models/deepseek-v4-flash",
  },
  /*
   * V4.1 Flash (#catalog 2026-09-10). Distinct from v4-flash: the live id is
   * `deepseek/deepseek-v4.1-flash` (dot, not hyphen), so modelRecordValue cannot
   * inherit the v4-flash [high, max] ladder. The page payload declares
   * [low, high, max] (decoded 2026-09-10 from the embedded flight array, indices
   * 231/233/301, cross-validated against six seeded rows on the same page).
   * Profile URL uses Command Code's hyphenated slug.
   */
  "deepseek/deepseek-v4.1-flash": {
    efforts: ["low", "high", "max"],
    profileUrl: "https://commandcode.ai/models/deepseek-v4-1-flash",
  },
  /*
   * Three live routes that reached the catalog without an effort ladder (#2647).
   * Without a row here the model advertises no efforts at all, so a client that
   * sends one gets it stripped or rejected rather than honored.
   *
   * PROVENANCE, stated plainly: these three ladders are the reporter's
   * (darwintree, #2647), recorded as reported and NOT independently verified.
   * The rows below were later cross-checked against the serialized flight
   * payload embedded in the profile pages (see parseCommandCodeProfileEfforts):
   * deepseek-v4-pro and -flash [high, max] and gemini-3.7-flash
   * [low, medium, high] all match what the pages publish today.
   *
   * Since the payload parser landed, the refresh path is live again for every
   * row: it reads the embedded payload (not the long-dead prose format), merges
   * page-declared words into the shared record, and a rejected word is dropped
   * locally by removeCommandCodeEffort on the 400-retry path. A wrong seed
   * therefore heals toward the page instead of staying wrong until a human
   * edits it — the union merge only ever adds words the page declares, so a
   * measured word the page does not list (muse-spark max, verified by upstream
   * POST on 2026-08-13) survives a page that lags reality.
   */
  "deepseek/deepseek-v4-flash-vision-exp": {
    efforts: ["high", "max"],
    profileUrl: "https://commandcode.ai/models/deepseek-v4-flash-vision-exp",
  },
  "gpt-5.6-luna": {
    efforts: ["low", "medium", "high", "xhigh", "max"],
    profileUrl: "https://commandcode.ai/models/gpt-5-6-luna",
  },
  "google/gemini-3.7-flash": {
    efforts: ["low", "medium", "high"],
    profileUrl: "https://commandcode.ai/models/gemini-3-7-flash",
  },
  // Keys must match the EXACT upstream /provider/v1/models ids (GLM ships as
  // `zai-org/GLM-5.3`, not `zai-org/glm-5.3`). The table doubles as the router's
  // known-ids decode source (via `knownModelIdsForProvider`), so a case mismatch
  // makes the Codex-facing slug `commandcode/zai-org-GLM-5.3` pass through
  // undecoded and upstream rejects it with `unsupported_model`.
  "zai-org/GLM-5": {
    efforts: ["high", "max"],
    profileUrl: "https://commandcode.ai/models/glm-5",
  },
  "zai-org/GLM-5.1": {
    efforts: ["high", "max"],
    profileUrl: "https://commandcode.ai/models/glm-5-1",
  },
  "zai-org/GLM-5.2": {
    efforts: ["high", "max"],
    profileUrl: "https://commandcode.ai/models/glm-5-2",
  },
  "zai-org/GLM-5.2-Fast": {
    efforts: ["high", "max"],
    profileUrl: "https://commandcode.ai/models/glm-5-2-fast",
  },
  "zai-org/GLM-5.3": {
    efforts: ["low", "high", "max"],
    profileUrl: "https://commandcode.ai/models/glm-5-3",
  },
  /*
   * GLM-5.3-Flash (#2883). Reported as advertising NO efforts at all: the live
   * route is `z-ai/glm-5.3-flash`, which shares neither vendor prefix nor model
   * id with `zai-org/GLM-5.3` above, so `modelRecordValue` cannot bridge them
   * (exact / colon-family / case-folded only — by design; a substring match here
   * would merge two genuinely different models across two vendor namespaces).
   *
   * PROVENANCE: unlike the #2647 rows above, this ladder is MEASURED, not
   * reported. commandcode.ai renders the profile client-side, but the delivered
   * HTML ships a serialized React payload whose string table can be read
   * directly: in the 2026-08-29 fetch of /models/glm-5-3-flash (HTTP 200,
   * 228749 bytes) the indices resolve as 224=low, 225=medium, 226=high,
   * 227=xhigh, 569=max, and this model's array is [224,226,569].
   *
   * The index map was cross-validated against every row in this table that the
   * same page carries: deepseek-v4-pro and -flash [226,569], gpt-5.6-luna
   * [224,225,226,227,569], gemini-3.7-flash [224,225,226], GLM-5.2 [226,569],
   * GLM-5.3 [224,226,569] — six for six against the values already committed
   * here. No authenticated upstream generate probe was performed.
   *
   * parseCommandCodeProfileEfforts now automates exactly this decode, so the
   * manual string-table walk is no longer the only way to measure a row.
   */
  "z-ai/glm-5.3-flash": {
    efforts: ["low", "high", "max"],
    profileUrl: "https://commandcode.ai/models/glm-5-3-flash",
  },
  // Muse Spark: CLI currently prints "has no adjustable reasoning effort" and
  // blocks --effort locally, but the upstream /alpha/generate endpoint accepts
  // reasoning_effort low..max for meta/muse-spark-1.2-contributor (verified
  // 2026-08-13: direct upstream POST with low/medium/high/xhigh/max all 200,
  // ultra 400; reasoningTokens differentiated 114..253; proxy previously stripped
  // the field so effort changes had no effect).
  //
  // 1.3 shipped 2026-09-02 as the same-shaped successor to 1.2 (Command Code
  // publishes meta/muse-spark-1.3 and meta/muse-spark-1.3-contributor alongside
  // the 1.2 pair, and Zen serves muse-spark-1.3-contributor over the same
  // /responses wire). It carries the 1.2 ladder because it IS the 1.2 spec: the
  // upstream ladder statement is per-family, and a narrower guess here would
  // strip an effort the gateway accepts. Additive — 1.2 and 1.1 stay live.
  "meta/muse-spark-1.3": {
    efforts: ["low", "medium", "high", "xhigh", "max"],
    profileUrl: "https://commandcode.ai/models/meta-muse-spark-1.3",
  },
  "meta/muse-spark-1.3-contributor": {
    efforts: ["low", "medium", "high", "xhigh", "max"],
    profileUrl: "https://commandcode.ai/models/meta-muse-spark-1.3-contributor",
  },
  "meta/muse-spark-1.2": {
    efforts: ["low", "medium", "high", "xhigh", "max"],
    profileUrl: "https://commandcode.ai/models/meta-muse-spark-1.2",
  },
  "meta/muse-spark-1.2-contributor": {
    efforts: ["low", "medium", "high", "xhigh", "max"],
    profileUrl: "https://commandcode.ai/models/meta-muse-spark-1.2-contributor",
  },
  "meta/muse-spark-1.1": {
    efforts: ["low", "medium", "high", "xhigh", "max"],
    profileUrl: "https://commandcode.ai/models/meta-muse-spark-1.1",
  },
} as const;

/**
 * Official Command Code model-profile facts, not a model catalog. Models remain
 * account-scoped and come exclusively from the authenticated /provider/v1/models endpoint.
 *
 * This object is deliberately MUTABLE after module load: the profile-payload
 * refresh merges page-declared ladders into it in place, and the registry
 * entries (`command-code` OAuth row and the `commandcode` key preset) hold this
 * exact reference, so /api/models, the codex catalog sync, and slug decoding all
 * observe refreshed ladders without any plumbing. resetCommandCodeReasoningEffortsForTest
 * restores the seed snapshot.
 */
const COMMAND_CODE_EFFORT_SEED: Record<string, string[]> = Object.fromEntries(
  Object.entries(COMMAND_CODE_MODEL_EFFORTS).map(([id, row]) => [id, [...row.efforts]]),
);

export const COMMAND_CODE_MODEL_REASONING_EFFORTS: Record<string, string[]> = { ...COMMAND_CODE_EFFORT_SEED };

/** Canonical wire order used to keep merged ladders deterministic. */
const EFFORT_ORDER: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Words a profile-payload ladder may contain. Anything else is treated as a
 * decode failure for that array (defence against mistaking some other index
 * array in the flight payload for an effort ladder). Extend this set — and
 * EFFORT_ORDER — together if Command Code ever ships a new wire tier.
 */
const COMMAND_CODE_EFFORT_WORDS: ReadonlySet<string> = new Set(EFFORT_ORDER);

/**
 * Any profile page carries the whole model catalog in its embedded flight
 * payload, so the refresh/ensure paths can fetch one fixed URL. Pinned to the
 * deepseek-v4-flash profile: a table row that exists today and renders the
 * full catalog payload (verified 2026-09-10, 242818 bytes, HTTP 200).
 */
const COMMAND_CODE_CATALOG_PROFILE_URL = "https://commandcode.ai/models/deepseek-v4-flash";

/** Minimum delay between profile-page catalog fetches on the ensure path. */
const COMMAND_CODE_PROFILE_REFRESH_INTERVAL_MS = 10 * 60_000;

function keyFor(modelId: string): string {
  return modelId.trim().toLowerCase();
}

export function commandCodeReasoningEfforts(modelId: string): readonly string[] | undefined {
  const key = keyFor(modelId);
  // Exact key first (the hot path), then the case-insensitive walk: the shared
  // record keys match the EXACT upstream ids (e.g. `zai-org/GLM-5.3`), but
  // callers may pass either case. hasOwn guards the fast path: a model id like
  // "constructor" must resolve through the prototype chain, not onto it.
  const exact = Object.hasOwn(COMMAND_CODE_MODEL_REASONING_EFFORTS, modelId)
    ? COMMAND_CODE_MODEL_REASONING_EFFORTS[modelId]
    : undefined;
  if (exact !== undefined) return exact;
  for (const [id, efforts] of Object.entries(COMMAND_CODE_MODEL_REASONING_EFFORTS)) {
    if (keyFor(id) === key) return efforts;
  }
  return undefined;
}

/*
 * Profile-flight payload decoding.
 *
 * commandcode.ai renders model profiles client-side. The delivered HTML embeds
 * the catalog in a React Router flight stream:
 *
 *   window.__reactRouterContext.streamController.enqueue("[{\"_1\":2,...}]")
 *
 * The enqueue argument is a JS string literal whose escapes line up with the
 * JSON document it carries (the serializer relies on escapes that are valid in
 * both, e.g. \" and \uXXXX), so one JS-style unescape yields text that
 * JSON.parse accepts. The parsed document is one flat array — the serialized
 * tree — where integers are references to other array slots and `{"_N": M}`
 * objects reference keys and values by slot. Effort ladders appear in two
 * shapes (both verified against the live page of 2026-09-10):
 *
 * - catalog rows:  ...,"vendor/slug","Name","description",<caps>,[refs...],...
 *   where [refs...] is the ladder and each ref resolves to an effort word.
 * - detail records: ...,"id","vendor/slug",...,"reasoningEfforts",[refs...],...
 *   with the owning model id nearby BEFORE the "reasoningEfforts" key.
 *
 * Unknown/ladder-shaped arrays (pricing buckets, benchmark rows) are rejected
 * by the effort-word whitelist at resolve time, so a drift in the payload
 * layout degrades to "no refresh" rather than to a wrong ladder.
 */

function readJsDoubleQuotedLiteral(html: string, start: number): string | undefined {
  let i = start;
  while (i < html.length && (html[i] === " " || html[i] === "\t")) i += 1;
  if (html[i] !== '"') return undefined;
  i += 1;
  let out = "";
  const simpleEscapes: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
  while (i < html.length) {
    const c = html[i]!;
    if (c === '"') return out;
    if (c === "\\") {
      const next = html[i + 1];
      if (next === undefined) return undefined;
      if (next === "u") {
        const hex = html.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      const mapped = simpleEscapes[next];
      if (mapped === undefined) return undefined;
      out += mapped;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return undefined;
}

function commandCodeProfileFlightDocuments(html: string): unknown[] {
  const marker = "streamController.enqueue(";
  const documents: unknown[] = [];
  let index = html.indexOf(marker);
  while (index !== -1) {
    const literal = readJsDoubleQuotedLiteral(html, index + marker.length);
    if (literal !== undefined) {
      try {
        documents.push(JSON.parse(literal));
      } catch {
        // A chunk that is not a whole JSON document is skipped; the next
        // enqueue (or nothing) carries the parsable one.
      }
    }
    index = html.indexOf(marker, index + marker.length);
  }
  return documents;
}

function looksLikeCommandCodeModelId(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 2 || value.length > 120) return false;
  // Effort words themselves sit in the string table right before a catalog row's
  // ladder (e.g. ...,"max","muse-spark-1-2-contributor",...); they must never
  // qualify as the owning id.
  if (COMMAND_CODE_EFFORT_WORDS.has(value)) return false;
  if (value.includes("/")) return !value.startsWith("http");
  // Bare ids (gpt-5.6-luna — the /provider/v1/models shape) are lowercase-starting,
  // space-free, and carry at least one separator or digit, so display names,
  // prose words, and vendor tags ("DeepSeek", "outputCost") do not qualify.
  return /^[a-z0-9][a-z0-9._:-]*$/.test(value) && /[0-9._:-]/.test(value.slice(1));
}

function resolvedEffortLadder(flat: readonly unknown[], value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return undefined;
  const words: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0 || entry >= flat.length) return undefined;
    const word = flat[entry];
    if (typeof word !== "string" || !COMMAND_CODE_EFFORT_WORDS.has(word)) return undefined;
    words.push(word);
  }
  return words;
}

/** Extract every model's page-declared ladder from a profile page's HTML. */
export function parseCommandCodeProfileEfforts(html: string): Record<string, string[]> | undefined {
  const found = new Map<string, string[]>();
  let sawFlightDocument = false;
  for (const document of commandCodeProfileFlightDocuments(html)) {
    if (!Array.isArray(document)) continue;
    sawFlightDocument = true;
    const flat = document as unknown[];
    for (let i = 0; i < flat.length; i += 1) {
      const entry = flat[i];
      if (entry === "reasoningEfforts") {
        // Detail record: the owning model id sits among the (few) preceding slots.
        const ladder = resolvedEffortLadder(flat, flat[i + 1]);
        if (!ladder) continue;
        for (let back = i - 1; back >= Math.max(0, i - 24); back -= 1) {
          const candidate = flat[back];
          if (looksLikeCommandCodeModelId(candidate)) {
            if (!found.has(candidate)) found.set(candidate, ladder);
            break;
          }
        }
        continue;
      }
      const ladder = resolvedEffortLadder(flat, entry);
      if (!ladder) continue;
      // Catalog row ("...id,name,desc,caps,[ladder]..."): attribute the ladder to
      // the NEAREST preceding model id. Walking backwards from the array (rather
      // than forwards from an id) is what keeps the page's URL-slug twin
      // ("deepseek-v4-1-flash" next to "deepseek/deepseek-v4.1-flash") from
      // claiming the row: the real id is always the closer candidate.
      for (let back = i - 1; back >= Math.max(0, i - 6); back -= 1) {
        const candidate = flat[back];
        if (looksLikeCommandCodeModelId(candidate)) {
          if (!found.has(candidate)) found.set(candidate, ladder);
          break;
        }
      }
    }
  }
  if (!sawFlightDocument) return undefined;
  return Object.fromEntries(found);
}

function canonicalEffortOrder(words: readonly string[]): string[] {
  const remaining = new Set(words);
  const ordered = EFFORT_ORDER.filter(word => remaining.delete(word));
  return [...ordered, ...remaining];
}

/**
 * Merge page-declared ladders into the shared record. Union semantics: words
 * the page declares are added, words already recorded (e.g. measured against
 * the upstream generate endpoint) are never dropped by a page that lags
 * reality. Rejected words are removed separately on the 400-retry path.
 * Returns the ids whose ladder changed.
 */
function mergeProfileEfforts(parsed: Record<string, string[]>): string[] {
  const touched: string[] = [];
  for (const [id, incoming] of Object.entries(parsed)) {
    if (incoming.length === 0) continue;
    const merged = canonicalEffortOrder([...(COMMAND_CODE_MODEL_REASONING_EFFORTS[id] ?? []), ...incoming]);
    const existing = COMMAND_CODE_MODEL_REASONING_EFFORTS[id];
    if (existing && existing.length === merged.length && existing.every((word, index) => word === merged[index])) continue;
    COMMAND_CODE_MODEL_REASONING_EFFORTS[id] = merged;
    touched.push(id);
  }
  return touched;
}

/**
 * Drop one effort word from a model's shared-record ladder after the upstream
 * rejected it with a reasoning-effort error. The next successful profile merge
 * adds the word back if the page still declares it, so a transient upstream
 * 400 self-heals. Returns the remaining ladder, or undefined when the model has
 * no recorded ladder at all.
 */
export function removeCommandCodeEffort(modelId: string, word: string): readonly string[] | undefined {
  const key = keyFor(modelId);
  let entryId: string | undefined;
  if (Object.hasOwn(COMMAND_CODE_MODEL_REASONING_EFFORTS, modelId)) entryId = modelId;
  else {
    for (const id of Object.keys(COMMAND_CODE_MODEL_REASONING_EFFORTS)) {
      if (keyFor(id) === key) { entryId = id; break; }
    }
  }
  if (entryId === undefined) return undefined;
  const current = COMMAND_CODE_MODEL_REASONING_EFFORTS[entryId]!;
  const next = current.filter(effort => effort !== word);
  if (next.length === current.length) return current;
  COMMAND_CODE_MODEL_REASONING_EFFORTS[entryId] = next;
  return next;
}

let catalogFetchInFlight: Promise<boolean> | undefined;
let catalogFetchedAtMs = 0;

/**
 * Fetch one Command Code profile page, decode the embedded catalog payload, and
 * merge every model's declared ladder into the shared record. Throttled and
 * single-flight; safe to fire-and-forget from a request path.
 */
export async function ensureCommandCodeProfileCatalog(
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  now: () => number = Date.now,
): Promise<boolean> {
  if (catalogFetchInFlight) return catalogFetchInFlight;
  if (now() - catalogFetchedAtMs < COMMAND_CODE_PROFILE_REFRESH_INTERVAL_MS) return false;
  const attempt = (async () => {
    try {
      const response = await fetchFn(COMMAND_CODE_CATALOG_PROFILE_URL, {
        headers: { Accept: "text/html" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return false;
      // The catalog payload rides inside the page HTML; the live page measured
      // ~243KB, and a page grown past 1MB must fail the refresh rather than
      // allocate without bound on a request path.
      const observed = await readBoundedResponseBody(response, { maxBytes: 1024 * 1024 });
      if (!observed.displaySafe) return false;
      const parsed = parseCommandCodeProfileEfforts(observed.text);
      if (!parsed) return false;
      return mergeProfileEfforts(parsed).length > 0;
    } catch {
      return false;
    }
  })();
  catalogFetchInFlight = attempt;
  try {
    return await attempt;
  } finally {
    catalogFetchedAtMs = now();
    catalogFetchInFlight = undefined;
  }
}

function profileUrlFor(modelId: string): string | undefined {
  const key = keyFor(modelId);
  for (const [id, row] of Object.entries(COMMAND_CODE_MODEL_EFFORTS)) {
    if (keyFor(id) === key) return row.profileUrl;
  }
  return undefined;
}

/**
 * Refresh ladders from a model's public profile page after the upstream rejects
 * an effort request. Models outside the seed table resolve against the shared
 * catalog page, so a newly discovered model heals on its first rejection.
 * A failed or unparseable page deliberately leaves the shared record unchanged.
 */
export async function refreshCommandCodeReasoningEfforts(
  modelId: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<readonly string[] | undefined> {
  const profileUrl = profileUrlFor(modelId) ?? COMMAND_CODE_CATALOG_PROFILE_URL;
  try {
    const response = await fetchFn(profileUrl, {
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    // Bound the profile page before parsing: a large or malformed page must not
    // allocate unbounded memory on the request path.
    const observed = await readBoundedResponseBody(response, { maxBytes: 1024 * 1024 });
    if (!observed.displaySafe) return undefined;
    const parsed = parseCommandCodeProfileEfforts(observed.text);
    if (parsed !== undefined) {
      mergeProfileEfforts(parsed);
      return commandCodeReasoningEfforts(modelId);
    }
    // Legacy fallback: the prose format the pages carried before the flight
    // payload. Nothing live emits it (measured 2026-08-27), but stubs and any
    // future server-side rendering reintroducing it keep working. The prose has
    // no model-id context, so the ladder belongs to the queried model.
    const proseLadder = parsedProfileEfforts(observed.text);
    if (proseLadder === undefined) return undefined;
    mergeProfileEfforts({ [modelId]: proseLadder });
    return commandCodeReasoningEfforts(modelId);
  } catch {
    return undefined;
  }
}

function parsedProfileEfforts(page: string): string[] | undefined {
  const match = page.match(/Reasoning efforts\s+([^.;]+?)\s+are supported;\s*([^.]*)/i);
  if (!match) return undefined;
  const listed = match[1]!.toLowerCase().match(/\b(?:low|medium|high|xhigh|max)\b/g) ?? [];
  const mapped = match[2]!.toLowerCase().match(/\b(?:low|medium|high|xhigh|max)\s+maps to\s+(?:low|medium|high|xhigh|max)\b/g) ?? [];
  const normalized = new Set(listed);
  for (const mapping of mapped) {
    const [, source, target] = mapping.match(/(low|medium|high|xhigh|max)\s+maps to\s+(low|medium|high|xhigh|max)/) ?? [];
    if (source && target) {
      normalized.delete(source);
      normalized.add(target);
    }
  }
  return normalized.size > 0 ? [...normalized] : undefined;
}

export function resetCommandCodeReasoningEffortsForTest(): void {
  for (const id of Object.keys(COMMAND_CODE_MODEL_REASONING_EFFORTS)) delete COMMAND_CODE_MODEL_REASONING_EFFORTS[id];
  Object.assign(COMMAND_CODE_MODEL_REASONING_EFFORTS, COMMAND_CODE_EFFORT_SEED);
  catalogFetchInFlight = undefined;
  catalogFetchedAtMs = 0;
}
