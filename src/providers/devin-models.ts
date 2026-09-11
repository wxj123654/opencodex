/**
 * Static seeds for the two Devin provider entries.
 *
 * - DEVIN_CLI_MODELS serves the `devin` ACP CLI bridge. Ids are the REAL `model_uid` values from
 *   `devin models list --format json` (verified against devin 3000.10.21 on 2026-09-11, logged in
 *   with a Free-plan account): the CLI uses HYPHENATED ids (`swe-1-7`, `swe-2-medium`), NOT the
 *   dotted LiteLLM spellings. Live roster discovery is authoritative; this list is only the
 *   degraded fallback, and unadvertised ids fail closed at session/set_model.
 * - DEVIN_API_MODELS serves the `devin-api` OpenAI-compatible catalog (api.cognition.ai/v1). Ids
 *   follow LiteLLM's first-class `cognition/` provider integration (cost map entries
 *   `cognition/swe-1.7`, `cognition/swe-1.7-lightning`, `cognition/swe-1.6`, added in
 *   BerriAI/litellm#37743) with the route prefix stripped; the endpoint could not be probed
 *   without a Teams/Enterprise key, so that roster keeps the third-party spellings.
 *
 * The autonomous session/agent surface at api.devin.ai (ACU-billed Devin sessions) is a
 * different product and is deliberately NOT modeled here.
 */

export const DEVIN_CLI_MODELS = [
  "swe-2-medium",
  "swe-2-high",
  "swe-2-max",
  "swe-1-7",
  "swe-1-7-lightning",
  "swe-1-6",
] as const;

export const DEVIN_API_MODELS = [
  "swe-1.7",
  "swe-1.7-lightning",
  "swe-1.6",
] as const;

/**
 * Context windows for the CLI bridge, from the SAME live roster (max_context_tokens per variant,
 * 2026-09-11): swe-2* and swe-1-7* report 262000; swe-1-7-lightning* 202752; swe-1-6* 200000.
 * SWE-2 is Cognition's newest in-house family (swe-2-medium/high/max).
 */
export const DEVIN_CLI_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "swe-2-medium": 262_000,
  "swe-2-high": 262_000,
  "swe-2-max": 262_000,
  "swe-1-7": 262_000,
  "swe-1-7-medium": 262_000,
  "swe-1-7-lightning": 202_752,
  "swe-1-7-lightning-medium": 202_752,
  "swe-1-6": 200_000,
  "swe-1-6-fast": 200_000,
};

/**
 * Context window carried over for the devin-api catalog: 256K-class on the SWE-1.7 family per
 * the cognition.com announcement and third-party spec pages (the per-token API has not been
 * probed directly). swe-1.6 has no published figure and is omitted.
 */
export const DEVIN_API_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "swe-1.7": 262_144,
  "swe-1.7-lightning": 262_144,
};
