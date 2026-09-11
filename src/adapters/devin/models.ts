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
 * is authoritative and the registry's static seed is only a degraded fallback — the same policy
 * the qoder adapter documents. Output shape is not versioned anywhere public, so the parser is
 * tolerant: it accepts a bare array, `{models: [...]}`, or `{data: [...]}`, and accepts either
 * `id` or `modelId` string fields, rejecting everything else.
 */

const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_MODELS = 256;

export type DevinModelsResult =
  | { ok: true; models: string[] }
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

/** Tolerant parse of the `devin models list --format json` output. Exported for unit tests.
 *
 * Two shapes are accepted:
 * - LIVE (verified against devin 3000.10.21, 2026-09-11): `{families: [{slug, variants:
 *   [{model_uid, max_context_tokens, ...}]}]}`. Each variant yields one model id; the family
 *   slug is NOT prepended (model_uid values are already globally unique, e.g. `swe-2-medium`).
 * - LEGACY/tolerant: a bare array, `{models: [...]}`, or `{data: [...]}` of plain string ids or
 *   `{id | modelId}` rows, kept so a future CLI format change degrades instead of crashing.
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
  const models: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = row !== null && typeof row === "object"
      ? (row as { id?: unknown }).id ?? (row as { modelId?: unknown }).modelId
      : row;
    if (typeof id !== "string" || !id || seen.has(id) || !isValidModelDiscoveryModelId(id)) continue;
    seen.add(id);
    models.push(id);
    if (models.length >= MAX_MODELS) break;
  }
  return models.length > 0 ? { ok: true, models } : { ok: false, error: "empty" };
}

/** Flatten the live families roster into deduped model ids (model_uid per variant). */
function parseFamilyRoster(families: unknown[]): DevinModelsResult {
  const models: string[] = [];
  const seen = new Set<string>();
  for (const family of families) {
    const variants = family !== null && typeof family === "object" && Array.isArray((family as { variants?: unknown }).variants)
      ? (family as { variants: unknown[] }).variants
      : [];
    for (const variant of variants) {
      const id = variant !== null && typeof variant === "object" ? (variant as { model_uid?: unknown }).model_uid : undefined;
      if (typeof id !== "string" || !id || seen.has(id) || !isValidModelDiscoveryModelId(id)) continue;
      seen.add(id);
      models.push(id);
      if (models.length >= MAX_MODELS) return { ok: true, models };
    }
  }
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
