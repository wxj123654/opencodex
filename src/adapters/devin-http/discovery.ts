import { fetchDevinHttpModels, type DevinHttpDeps } from "./client";
import { foldDevinRoster, type DevinHttpModel } from "./roster";
import { DevinMissingCredentialError, readDevinTokenFromDisk } from "./credentials";

/**
 * Entitlement-aware model discovery for the `devin-http` provider.
 *
 * The roster comes from Cascade's own `GetCliModelConfigs` RPC, so what the account can actually
 * call is the authority — the registry's static seed is only the degraded fallback. This mirrors
 * the ACP provider's relationship with `devin models list`, minus the CLI: same source data, one
 * authenticated HTTP call instead of a child process.
 */

export type DevinHttpModelsResult =
  | { ok: true; models: DevinHttpModel[]; foldedVariants: number }
  | { ok: false; error: "missing_credential" | "timeout" | "network" | "upstream" | "invalid_output" | "empty"; detail?: string };

export interface DevinHttpModelsDeps extends DevinHttpDeps {
  /**
   * Test seam AND the catalog's credential path: the catalog has already resolved the provider's
   * key by the time it asks for a roster, so passing the token avoids re-deriving it from disk.
   */
  token?: string;
}

type Fetcher = (token?: string) => DevinHttpModelsResult | Promise<DevinHttpModelsResult>;
let fetcherForTests: Fetcher | null = null;

/** Test seam: replace the roster fetch entirely (mirrors the qoder and devin discovery seams). */
export function setFetchDevinHttpModelsForTests(next: Fetcher | null): void {
  fetcherForTests = next;
}

function reason(error: unknown): { error: "timeout" | "network" | "upstream"; detail: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return { error: "timeout", detail: message };
  }
  if (error instanceof Error && error.name === "DevinHttpError") {
    return { error: "upstream", detail: message };
  }
  return { error: "network", detail: message };
}

/**
 * Resolve the roster for `token`.
 *
 * When no token is supplied the CLI's stored credential is used, matching the chat path's fallback
 * so a user who ran `devin auth login` gets discovery with no configuration either.
 */
export async function fetchDevinHttpModelsLive(
  token?: string,
  deps: DevinHttpModelsDeps = {},
): Promise<DevinHttpModelsResult> {
  if (fetcherForTests) return fetcherForTests(token);

  const credential = token?.trim() || readDevinTokenFromDisk();
  if (!credential) {
    return { ok: false, error: "missing_credential", detail: new DevinMissingCredentialError().message };
  }

  let configs;
  try {
    configs = await fetchDevinHttpModels(credential, deps);
  } catch (error) {
    return { ok: false, ...reason(error) };
  }

  if (configs.length === 0) return { ok: false, error: "empty" };

  const folded = foldDevinRoster(configs);
  if (folded.models.length === 0) return { ok: false, error: "invalid_output", detail: "no model ids survived validation" };

  return { ok: true, models: folded.models, foldedVariants: folded.foldedVariants };
}
