import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gatherRoutedModels } from "../../src/codex/catalog";
import { clearModelCache } from "../../src/codex/model-cache";
import { setFetchDevinHttpModelsForTests } from "../../src/adapters/devin-http/discovery";
import type { CliModelConfig } from "../../src/adapters/devin-http/proto";
import type { OcxConfig } from "../../src/types";
import { withStubbedProviderFetch } from "../helpers/catalog-provider-fetch";

/**
 * Catalog-side credential coverage for `devin-http`.
 *
 * `devin-http` is `keyOptional: true`: its documented zero-configuration credential is whatever
 * `devin auth login` already wrote to the CLI's `credentials.toml`. The chat path has always
 * resolved it (`resolveDevinToken`), but the catalog gather resolved only `provider.apiKey`, so an
 * unconfigured provider degraded on every gather. That mattered beyond the model list: a degraded
 * gather is never authoritative, and `reconcileInitialModelSelections` only decides for
 * authoritative providers — so `initialModelSelection` stayed `pending` forever and the Models
 * inventory disabled every switch with no way out.
 *
 * These tests pin the catalog's credential source, not the roster fold (covered next to the
 * adapter).
 */

/** The on-disk credential the CLI leaves behind after `devin auth login`. */
const STORED_TOKEN = "devin-session-token$catalog-credential";

let home = "";
const originalEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  APPDATA: process.env.APPDATA,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  DEVIN_CONFIG_DIR: process.env.DEVIN_CONFIG_DIR,
};

/** Write a CLI credential file the platform-neutral candidate list will find. */
function writeStoredCredential(token = STORED_TOKEN): void {
  const dir = join(home, ".local", "share", "devin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "credentials.toml"), `windsurf_api_key = "${token}"\n`);
}

function devinConfig(apiKey?: string): OcxConfig {
  return withStubbedProviderFetch({
    port: 0,
    defaultProvider: "devin-http",
    providers: {
      "devin-http": {
        adapter: "devin-http",
        baseUrl: "https://server.codeium.com",
        authMode: "key",
        keyOptional: true,
        liveModels: true,
        defaultModel: "swe-2",
        models: ["swe-2"],
        ...(apiKey === undefined ? {} : { apiKey }),
      },
    },
  } as OcxConfig);
}

/** Minimal live roster; only the ids matter to the credential assertion. */
function roster(ids: string[]): CliModelConfig[] {
  return ids.map(id => ({ id, label: id, contextWindow: 200_000, supportsImages: false, supportsThinking: true }));
}

async function gather(config: OcxConfig): Promise<{ devin: string[]; state: string | undefined; capturedToken: string | undefined }> {
  const outcomes: Array<{ provider: string; state: "authoritative" | "degraded" }> = [];
  const models = await gatherRoutedModels(config, { providerModelOutcomes: outcomes });
  return {
    devin: models.filter(model => model.provider === "devin-http").map(model => model.id),
    state: outcomes.find(outcome => outcome.provider === "devin-http")?.state,
    capturedToken: lastCapturedToken,
  };
}

afterEach(() => {
  setFetchDevinHttpModelsForTests(null);
  clearModelCache();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

let lastCapturedToken: string | undefined;

describe("devin-http catalog credential resolution", () => {
  test("the CLI's stored credential makes an unconfigured provider authoritative", async () => {
    home = mkdtempSync(join(tmpdir(), "devin-catalog-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.XDG_DATA_HOME;
    delete process.env.APPDATA;
    delete process.env.LOCALAPPDATA;
    delete process.env.DEVIN_CONFIG_DIR;
    writeStoredCredential();

    lastCapturedToken = undefined;
    setFetchDevinHttpModelsForTests(token => {
      lastCapturedToken = token;
      return { ok: true, models: roster(["swe-2", "glm-5-2"]).map(model => ({ id: model.id, efforts: [], contextWindow: model.contextWindow })), foldedVariants: 0 };
    });

    const result = await gather(devinConfig());
    // The whole point: the CLI credential reaches discovery and the gather is authoritative.
    expect(result.capturedToken).toBe(STORED_TOKEN);
    expect(result.state).toBe("authoritative");
    expect(result.devin).toEqual(["glm-5-2", "swe-2"]);
  });

  test("an explicitly configured key still wins over the stored credential", async () => {
    home = mkdtempSync(join(tmpdir(), "devin-catalog-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.XDG_DATA_HOME;
    delete process.env.APPDATA;
    delete process.env.LOCALAPPDATA;
    delete process.env.DEVIN_CONFIG_DIR;
    writeStoredCredential("devin-session-token$other-account");

    lastCapturedToken = undefined;
    setFetchDevinHttpModelsForTests(token => {
      lastCapturedToken = token;
      return { ok: true, models: [{ id: "swe-2", efforts: [] }], foldedVariants: 0 };
    });

    const result = await gather(devinConfig("devin-session-token$configured"));
    // The multi-account path must not be hijacked by whatever account the CLI is logged into.
    expect(result.capturedToken).toBe("devin-session-token$configured");
    expect(result.state).toBe("authoritative");
  });

  test("no credential at all degrades to the static seed instead of probing", async () => {
    home = mkdtempSync(join(tmpdir(), "devin-catalog-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.XDG_DATA_HOME;
    delete process.env.APPDATA;
    delete process.env.LOCALAPPDATA;
    delete process.env.DEVIN_CONFIG_DIR;

    lastCapturedToken = undefined;
    setFetchDevinHttpModelsForTests(token => {
      lastCapturedToken = token;
      return { ok: true, models: [{ id: "should-not-be-used", efforts: [] }], foldedVariants: 0 };
    });

    const result = await gather(devinConfig());
    expect(result.capturedToken).toBeUndefined();
    expect(result.state).toBe("degraded");
    expect(result.devin).toEqual(["swe-2"]);
  });
});
