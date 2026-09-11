import type { AdapterEvent, OcxProviderConfig } from "../types";
import type { AdapterRequest, ProviderAdapter } from "./base";
import { runDevinAcpTurn, type DevinTurnDeps } from "./devin/turn";

export { fetchDevinModels, parseDevinModelList, setFetchDevinModelsForTests, type DevinModelsResult } from "./devin/models";
export { buildDevinChildEnv, DEVIN_PROFILE, refusalHandler, runDevinAcpTurn } from "./devin/turn";
export { AcpConnection, type AgentRequestHandler } from "./devin/transport";

/**
 * Devin CLI adapter: a text/reasoning channel through the `devin acp` Agent Client Protocol
 * agent (260911_devin_acp_bridge/000_plan.md).
 *
 * This is NOT a model contract in the openai-chat sense and deliberately does not pretend to be
 * one: the agent gathers its own context with its own tools and ignores Codex's tool list. The
 * bridge exists because the vendor CLI is the only self-serve transport to Devin's models (the
 * OpenAI-compatible api.cognition.ai endpoint is provisioned per customer); it is the same honest
 * compromise as the qoder/codebuddy single-shot CLIs, with a bidirectional protocol. The registry
 * note carries the trust boundary.
 */
export function createDevinAdapter(provider: OcxProviderConfig, deps: DevinTurnDeps = {}): ProviderAdapter {
  return {
    name: "devin",

    // runTurn owns the turn; buildRequest/parseStream are the disabled HTTP path (mirrors cursor).
    buildRequest(): AdapterRequest {
      return { url: provider.baseUrl, method: "POST", headers: {}, body: "" };
    },
    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield { type: "error", message: "Devin adapter uses runTurn; the fetch/parseStream path is disabled." };
    },

    async runTurn(parsed, incoming, emit): Promise<void> {
      await runDevinAcpTurn(provider, parsed, incoming, emit, deps);
    },
  };
}
