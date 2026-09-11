import { afterEach, describe, expect, test } from "bun:test";
import { clearModelCache } from "../../src/codex/model-cache";
import { buildInitProviders } from "../../src/cli/init";
import {
  deriveInitProviders,
  deriveProviderPresets,
  providerConfigSeed,
} from "../../src/providers/derive";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { routeModel } from "../../src/router";
import type { OcxConfig } from "../../src/types";

afterEach(() => clearModelCache("devin"));

function registryEntry(id: string) {
  const entry = PROVIDER_REGISTRY.find(row => row.id === id);
  if (!entry) throw new Error(`missing ${id} registry entry`);
  return entry;
}

function devinConfig(overrides: Partial<OcxConfig["providers"][string]> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "devin",
    providers: {
      devin: {
        adapter: "devin",
        baseUrl: "https://cli.devin.ai",
        authMode: "key",
        liveModels: true,
        ...overrides,
      },
    },
  };
}

describe("Devin provider split: CLI bridge vs per-token API", () => {
  test("the devin entry bridges the ACP CLI, not an HTTP endpoint", () => {
    const entry = registryEntry("devin");
    expect(entry).toMatchObject({
      id: "devin",
      label: "Devin CLI (ACP)",
      adapter: "devin",
      baseUrl: "https://cli.devin.ai",
      authKind: "key",
      keyOptional: true,
      defaultModel: "swe-2-medium",
      liveModels: true,
    });
    // Ids verified LIVE against devin 3000.10.21 (2026-09-11): the CLI uses hyphenated
    // model_uid spellings, and swe-2 is the newest Cognition family.
    expect(entry.models).toEqual(["swe-2-medium", "swe-2-high", "swe-2-max", "swe-1-7", "swe-1-7-lightning", "swe-1-6"]);
    expect(entry.modelContextWindows?.["swe-2-medium"]).toBe(262_000);
    expect(entry.modelContextWindows?.["swe-1-7-lightning"]).toBe(202_752);
    // Contract honesty: the note must carry the agent-vs-model boundary for operators.
    expect(entry.note).toContain("ignores Codex's tool list");
    expect(entry.note).toContain("ask");
  });

  test("the devin-api entry keeps the per-token Cognition catalog on openai-chat", () => {
    const entry = registryEntry("devin-api");
    expect(entry).toMatchObject({
      id: "devin-api",
      label: "Devin API (Cognition)",
      adapter: "openai-chat",
      baseUrl: "https://api.cognition.ai/v1",
      authKind: "key",
      defaultModel: "swe-1.7",
      liveModels: true,
    });
    expect(entry.modelContextWindows).toEqual({
      "swe-1.7": 262_144,
      "swe-1.7-lightning": 262_144,
    });
    // No verified reasoning_effort contract yet: the entry must not advertise an
    // effort ladder the chat API has not been probed for.
    expect(entry.reasoningEfforts).toBeUndefined();
    expect(entry.modelReasoningEfforts).toBeUndefined();
  });

  test("both entries derive key-login, init, and dashboard presets", () => {
    expect(deriveInitProviders()).toEqual(buildInitProviders());
    for (const id of ["devin", "devin-api"] as const) {
      const initRow = buildInitProviders().find(row => row.id === id);
      expect(initRow).toBeDefined();
      expect(deriveProviderPresets().find(row => row.id === id)).toBeDefined();
    }
    expect(providerConfigSeed(registryEntry("devin")).models).toEqual(["swe-2-medium", "swe-2-high", "swe-2-max", "swe-1-7", "swe-1-7-lightning", "swe-1-6"]);
    expect(providerConfigSeed(registryEntry("devin-api")).models).toEqual(["swe-1.7", "swe-1.7-lightning", "swe-1.6"]);
    // The CLI entry seeds WITHOUT a credential: the local devin auth login cache is the default
    // authority, so the seed must not fabricate a key requirement beyond authMode itself.
    expect(providerConfigSeed(registryEntry("devin"))).toMatchObject({
      adapter: "devin",
      baseUrl: "https://cli.devin.ai",
      liveModels: true,
    });
  });

  test("routes devin/<model> to the ACP adapter without an apiKey requirement", () => {
    const route = routeModel(devinConfig(), "devin/swe-2-medium");
    expect(route.modelId).toBe("swe-2-medium");
    expect(route.provider.adapter).toBe("devin");
    expect(route.provider.baseUrl).toBe("https://cli.devin.ai");
    expect(route.provider.apiKey).toBeUndefined();
  });
});
