/**
 * Static seed for the Cognition (Devin) OpenAI-compatible endpoint (api.cognition.ai/v1).
 *
 * Ids follow LiteLLM's first-class `cognition/` provider integration (cost map entries
 * `cognition/swe-1.7`, `cognition/swe-1.7-lightning`, `cognition/swe-1.6`, added in
 * BerriAI/litellm#37743) with the route prefix stripped. Cognition provisions API endpoints
 * per customer, so live `/v1/models` discovery stays authoritative whenever it succeeds;
 * this roster is the degraded fallback for installs where discovery fails or is disabled.
 *
 * The autonomous session/agent surface at api.devin.ai (ACU-billed Devin sessions) is a
 * different product and is deliberately NOT modeled here.
 */
export const DEVIN_MODELS = [
  "swe-1.7",
  "swe-1.7-lightning",
  "swe-1.6",
] as const;

/**
 * SWE-1.7 256K context window. Multiple third-party spec pages (BenchLM, TipJournal,
 * AwesomeAgents) agree on 256K, tracing it to the public Kimi K2.7 Code base; Cognition's
 * own announcement does not state a number. swe-1.6 has no published figure and is
 * deliberately omitted until one exists.
 */
export const DEVIN_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "swe-1.7": 262_144,
  "swe-1.7-lightning": 262_144,
};
