import type { OcxProviderConfig, OcxParsedRequest } from "../types";
import { resolveEffortAtOrBelow } from "../reasoning-effort";
import {
  WINDSURF_API_MODEL_DEFAULT_REASONING_EFFORTS,
  WINDSURF_API_MODEL_REASONING_EFFORTS,
  WINDSURF_API_MODEL_WIRE_UIDS,
} from "../providers/windsurf-api-models";
import type { AdapterRequest, IncomingMeta, ProviderAdapter } from "./base";
import { createOpenAIChatAdapter } from "./openai-chat";

/**
 * WindsurfAPI reverse proxy adapter: a thin wrapper over `openai-chat`.
 *
 * The upstream speaks plain OpenAI Chat Completions, but the reasoning effort is baked into the
 * model id (`claude-opus-5-high`, `gpt-5-6-sol-none-priority`) instead of a `reasoning_effort`
 * field — the same contract shape as `devin-http`. The wrapper resolves the routed model id +
 * Codex effort to the exact wire id, rewrites `body.model` after the inner adapter serializes
 * the request, and strips `reasoning_effort` so the effort is not sent twice.
 *
 * Resolution rules (mirroring `resolveDevinWireUid`):
 * - an explicit effort resolves through the model's ladder, clamped at-or-below like every other
 *   Codex-facing ladder (`minimal` lands on the lowest rung, `none` on the `-none` rung when the
 *   family ships one);
 * - no effort: the bare uid wins when the family ships one, else the seeded default rung;
 * - unknown model ids pass through verbatim (with a `-effort` suffix guess when an effort was
 *   requested) so the server answers with its own error rather than the adapter inventing one.
 */
export function resolveWindsurfApiWireModel(modelId: string, effort?: string): string {
  const rungs = WINDSURF_API_MODEL_WIRE_UIDS[modelId];
  if (rungs) {
    if (effort) {
      const ladder = WINDSURF_API_MODEL_REASONING_EFFORTS[modelId] ?? [];
      const rung = resolveEffortAtOrBelow(effort, ladder);
      if (rung && rungs[rung] !== undefined) return rungs[rung];
      // The requested effort has no rung on this model: fall through to the default/bare uid
      // rather than guessing a suffix the roster never advertised.
    }
    if (rungs[""] !== undefined) return rungs[""];
    const defaultEffort = WINDSURF_API_MODEL_DEFAULT_REASONING_EFFORTS[modelId];
    if (defaultEffort && rungs[defaultEffort] !== undefined) return rungs[defaultEffort];
    const first = Object.values(rungs)[0];
    if (first !== undefined) return first;
  }
  if (effort && effort !== "none" && effort !== "minimal") return `${modelId}-${effort}`;
  return modelId;
}

/**
 * Rewrite the serialized Chat Completions body: `model` becomes the resolved wire id and the
 * `reasoning_effort`/`reasoning` fields are dropped because the effort now rides in the id.
 * The reasoning log is cleared for the same reason — it would otherwise report a field the
 * request no longer carries.
 */
function rewriteWindsurfApiRequest(request: AdapterRequest, parsed: OcxParsedRequest): AdapterRequest {
  const wireModel = resolveWindsurfApiWireModel(
    parsed.modelId,
    typeof parsed.options.reasoning === "string" ? parsed.options.reasoning : undefined,
  );
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(request.body) as Record<string, unknown>;
  } catch {
    return request;
  }
  body.model = wireModel;
  delete body.reasoning_effort;
  delete body.reasoning;
  delete body.thinking;
  delete body.thinking_budget;
  delete request.reasoningLog;
  return { ...request, body: JSON.stringify(body) };
}

export function createWindsurfApiAdapter(provider: OcxProviderConfig): ProviderAdapter {
  const inner = createOpenAIChatAdapter(provider);
  return {
    ...inner,
    name: "windsurf-api",
    buildRequest(parsed: OcxParsedRequest, incoming: IncomingMeta) {
      const request = inner.buildRequest(parsed, incoming);
      return request instanceof Promise
        ? request.then(resolved => rewriteWindsurfApiRequest(resolved, parsed))
        : rewriteWindsurfApiRequest(request, parsed);
    },
  };
}
