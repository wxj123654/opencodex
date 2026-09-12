import { execFile } from "node:child_process";
import { commandInvocation } from "../../lib/win-exec";
import { isValidModelDiscoveryModelId } from "../../providers/model-discovery-limits";
import { baseScopedEnv } from "../coding-agent/turn";
import { resolveCodingAgentBinary, type WhichFn } from "../coding-agent/profile";
import { DEVIN_PROFILE } from "./turn";

/**
 * Entitlement-aware model discovery for the Devin bridge: `devin models list --format json`.
 *
 * The roster is account-specific (Free/Pro/Max/Teams see different families), so live discovery
 * is authoritative and the registry's static seed is only a degraded fallback.
 *
 * Live shape (verified against devin 3000.10.21, 2026-09-11):
 * `{families: [{slug, variants: [{model_uid, max_context_tokens, ...}]}]}`.
 *
 * Variants are NOT emitted as separate models. A reasoning-variant suffix (`-medium`, `-high`,
 * `-max`, ...) is folded into the base id's effort ladder (`swe-2-medium/high/max` → model
 * `swe-2`, efforts `[medium, high, max]`), matching how Codex and pi surface thinking levels.
 * The adapter re-attaches the suffix at session/set_model time. Only Cognition's own `swe`
 * families are emitted: the roster also carries dozens of hosted third-party families
 * (claude/gpt/gemini/glm/kimi/fusion...) that users already reach through their own direct
 * providers, and the fusion combinatorial tail alone would eat the model-count ceiling.
 */

const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_MODELS = 256;

/** Reasoning-effort suffixes folded into the base id's ladder (single trailing suffix). */
const EFFORT_SUFFIXES = new Set(["medium", "high", "max", "low", "xhigh", "minimal", "none"]);

/** Only families whose slug starts with this prefix are emitted (Cognition's in-house line). */
const EMITTED_FAMILY_PREFIX = "swe";

export interface DevinDiscoveredModel {
  id: string;
  /** Reasoning efforts folded out of variant suffixes, in first-seen order. */
  efforts: string[];
}

export type DevinModelsResult =
  | { ok: true; models: DevinDiscoveredModel[] }
  | { ok: false; error: "cli_not_found" | "timeout" | "process" | "invalid_output" | "empty" | "too_large"; detail?: string };

export interface DevinModelsDeps {
  which?: WhichFn;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  exec?: typeof execFile;
}

type DevinModelsFetcher = () => DevinModelsResult | Promise<DevinModelsResult>;
let devinModelsFetcherForTests: DevinModelsFetcher | null = null;

/** Test seam: replace the roster fetch entirely (mirrors the qoder discovery seam). */
export function setFetchDevinModelsForTests(next: DevinModelsFetcher | null): void {
  devinModelsFetcherForTests = next;
}

/** Split one model_uid into (base id, trailing effort suffix) — `swe-2-medium` → swe-2 + medium. */
export function splitEffortSuffix(id: string): { base: string; effort?: string } {
  const index = id.lastIndexOf("-");
  if (index <= 0) return { base: id };
  const suffix = id.slice(index + 1);
  if (!EFFORT_SUFFIXES.has(suffix)) return { base: id };
  return { base: id.slice(0, index), effort: suffix };
}

/** A tolerant id row shape accepted by the legacy fallback parser. */
function rowId(row: unknown): unknown {
  return row !== null && typeof row === "object"
    ? (row as { id?: unknown }).id ?? (row as { modelId?: unknown }).modelId
    : row;
}

/**
 * Parse the roster. The live families shape is folded per-family (SWE families only, variant
 * suffixes merged into effort ladders). Legacy tolerant shapes (bare array / `{models}` /
 * `{data}`) emit one model per row with no effort folding, so a future format change degrades
 * instead of crashing.
 */
export function parseDevinModelList(stdout: string): DevinModelsResult {
  if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) return { ok: false, error: "too_large" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, error: "invalid_output", detail: "output is not JSON" };
  }
  if (parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { families?: unknown }).families)) {
    return parseFamilyRoster((parsed as { families: unknown[] }).families);
  }
  const rows: unknown = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { models?: unknown }).models)
      ? (parsed as { models: unknown[] }).models
      : parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { data?: unknown }).data)
        ? (parsed as { data: unknown[] }).data
        : undefined;
  if (!Array.isArray(rows)) {
    return { ok: false, error: "invalid_output", detail: "expected a families roster or an array of model rows" };
  }
  const models: DevinDiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = rowId(row);
    if (typeof id !== "string" || !id || seen.has(id) || !isValidModelDiscoveryModelId(id)) continue;
    seen.add(id);
    models.push({ id, efforts: [] });
    if (models.length >= MAX_MODELS) break;
  }
  return models.length > 0 ? { ok: true, models } : { ok: false, error: "empty" };
}

/**
 * Fold the live families roster. Non-SWE families are dropped; within a SWE family each
 * reasoning-variant suffix becomes one effort rung on the base id's ladder, and suffix-less
 * variants keep the bare id (its presence means the bare id is itself routable, e.g. `swe-1-7`).
 */
function parseFamilyRoster(families: unknown[]): DevinModelsResult {
  const order: string[] = [];
  const byBase = new Map<string, DevinDiscoveredModel>();
  const record = (model: DevinDiscoveredModel): void => {
    const existing = byBase.get(model.id);
    if (existing) {
      for (const effort of model.efforts) {
        if (!existing.efforts.includes(effort)) existing.efforts.push(effort);
      }
      return;
    }
    byBase.set(model.id, model);
    order.push(model.id);
  };
  for (const family of families) {
    const slug = family !== null && typeof family === "object" ? (family as { slug?: unknown }).slug : undefined;
    if (typeof slug !== "string" || !slug.toLowerCase().startsWith(EMITTED_FAMILY_PREFIX)) continue;
    const variants = family !== null && typeof family === "object" && Array.isArray((family as { variants?: unknown }).variants)
      ? (family as { variants: unknown[] }).variants
      : [];
    for (const variant of variants) {
      const uid = variant !== null && typeof variant === "object" ? (variant as { model_uid?: unknown }).model_uid : undefined;
      if (typeof uid !== "string" || !uid || !isValidModelDiscoveryModelId(uid)) continue;
      const { base, effort } = splitEffortSuffix(uid);
      if (!isValidModelDiscoveryModelId(base)) continue;
      record(effort ? { id: base, efforts: [effort] } : { id: base, efforts: [] });
      if (order.length >= MAX_MODELS) return { ok: true, models: order.map(id => byBase.get(id)!) };
    }
  }
  const models = order.map(id => byBase.get(id)!);
  return models.length > 0 ? { ok: true, models } : { ok: false, error: "empty" };
}

export async function fetchDevinModels(deps: DevinModelsDeps = {}): Promise<DevinModelsResult> {
  if (devinModelsFetcherForTests) return devinModelsFetcherForTests();
  const binary = resolveCodingAgentBinary(DEVIN_PROFILE, deps.which);
  if (!binary) return { ok: false, error: "cli_not_found" };
  const exec = deps.exec ?? execFile;
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const platform = deps.platform ?? process.platform;
  const env = baseScopedEnv();
  const invocation = commandInvocation(binary, ["models", "list", "--format", "json"], platform, { env });
  return new Promise<DevinModelsResult>(resolve => {
    exec(
      invocation.file,
      platform === "win32" && /\.cmd$/i.test(binary) ? [] : [...invocation.args],
      { env, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          const killed = (error as { killed?: boolean }).killed === true;
          resolve(killed
            ? { ok: false, error: "timeout" }
            : { ok: false, error: "process", detail: String(stderr || error.message).slice(0, 256) });
          return;
        }
        const result = parseDevinModelList(stdout);
        resolve(result);
      },
    );
  });
}
