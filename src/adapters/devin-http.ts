import type { AdapterEvent, OcxProviderConfig } from "../types";
import type { AdapterRequest, ProviderAdapter } from "./base";
import { runDevinHttpTurn, type DevinHttpTurnDeps } from "./devin-http/turn";

export {
  DEVIN_CASCADE_BASE_URL,
  DevinHttpError,
  fetchUserJwt,
  fetchDevinHttpModels,
  streamDevinChat,
  type DevinStreamEvent,
} from "./devin-http/client";
export { type CliModelConfig } from "./devin-http/proto";
export {
  DevinMissingCredentialError,
  devinCredentialFileCandidates,
  normalizeDevinToken,
  readDevinCredentialFile,
  readDevinTokenFromDisk,
  resolveDevinToken,
} from "./devin-http/credentials";
export {
  decomposeDevinUid,
  devinExposedModelId,
  foldDevinRoster,
  resolveDevinWireUid,
  type DevinHttpModel,
  type DevinRosterFold,
} from "./devin-http/roster";
export {
  collectSystemPrompt,
  projectDevinPrompts,
  resolveWireUid,
  runDevinHttpTurn,
  stopReasonToDevinStopReason,
  toCompletionConfiguration,
  toDevinToolDefinitions,
  type DevinHttpTurnDeps,
} from "./devin-http/turn";

/**
 * Devin/Cascade adapter over the vendor's own Connect API (direct HTTP, no CLI).
 *
 * ## Relationship to the other two Devin entries
 *
 * - `devin` bridges the vendor CLI over ACP: text and reasoning only, because the CLI's agent keeps
 *   its own tools and ignores Codex's. Its value is a hard read-only posture (no fs/terminal
 *   capabilities, every permission request declined).
 * - `devin-api` fronts `api.cognition.ai/v1`, the per-token OpenAI-compatible endpoint, which needs
 *   a Teams/Enterprise service-user key.
 * - **this adapter** calls the same backend the CLI does, over plain HTTP, using the credential the
 *   CLI already stored. It is a real model contract: Codex's tool list reaches the model and the
 *   model's tool calls come back for Codex to execute.
 *
 * The trade against the ACP bridge is capability for containment. This path exposes the account's
 * full model roster (74 selectable models across every hosted family, not just Cognition's own SWE
 * line) and real tool calling, but the read-only guarantees the ACP bridge enforces by refusing
 * permission requests do not apply — here there is no local agent to contain, only a model.
 */
export function createDevinHttpAdapter(provider: OcxProviderConfig, deps: DevinHttpTurnDeps = {}): ProviderAdapter {
  return {
    name: "devin-http",

    // runTurn owns the turn: the Connect transport is a streaming RPC with its own framing, which
    // the fetch/parseStream pair cannot express (the request body is a gzipped protobuf frame, not
    // a JSON string). Mirrors the cursor and devin adapters.
    buildRequest(): AdapterRequest {
      return { url: provider.baseUrl, method: "POST", headers: {}, body: "" };
    },
    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield { type: "error", message: "Devin HTTP adapter uses runTurn; the fetch/parseStream path is disabled." };
    },

    async runTurn(parsed, incoming, emit): Promise<void> {
      await runDevinHttpTurn(provider, parsed, incoming, emit, deps);
    },
  };
}
