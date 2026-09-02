import { afterEach, describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { buildClientConfigText } from "../src/clients/config-export";
import { gatherRoutedModels } from "../src/codex/catalog";
import { clearModelCache } from "../src/codex/model-cache";
import { loadExportModels } from "../src/server/management/model-rows";
import { KEY_LOGIN_PROVIDERS } from "../src/oauth/key-providers";
import { enrichProviderFromRegistry, providerConfigSeed } from "../src/providers/derive";
import { providerModelMatchesDiscoveryFilter } from "../src/providers/model-discovery";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { configuredReasoningEfforts, mapReasoningEffort } from "../src/reasoning-effort";
import { routeModel } from "../src/router";
import type { OcxConfig, OcxParsedRequest } from "../src/types";
import { withStubbedProviderFetch } from "./helpers/catalog-provider-fetch";

const OFFICIAL_ELECTRONHUB_CODING_PLAN_MODELS = [
  "glm-5.3-flash:dev",
  "deepseek-v4-flash:dev",
  "deepseek-v4-flash-0731:dev",
  "mimo-v2.5:dev",
  "qwen3.6-27b:dev",
  "qwen3.8-27b:dev",
  "minimax-m2.7:dev",
  "kimi-k2.6:dev",
  "kimi-k2.7-code:dev",
  "glm-5.3:dev",
];

function parsed(modelId: string): OcxParsedRequest {
  return {
    modelId,
    context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    stream: false,
    options: {},
  };
}

function registryEntry() {
  const entry = PROVIDER_REGISTRY.find(provider => provider.id === "electronhub-coding-plan");
  if (!entry) throw new Error("missing Electron Hub Coding Plan registry entry");
  return entry;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("electronhub-coding-plan");
});

describe("Electron Hub Coding Plan provider", () => {
  test("registry exposes the DevPass transport and static :dev catalog", () => {
    const entry = registryEntry();

    expect(entry).toMatchObject({
      label: "Electron Hub Coding Plan",
      adapter: "openai-chat",
      baseUrl: "https://api.electronhub.ai/v1",
      authKind: "key",
      dashboardUrl: "https://app.electronhub.ai",
      defaultModel: "glm-5.3:dev",
      liveModels: true,
      preserveCustomDestination: true,
      modelDiscovery: {
        path: "models",
        filter: {
          allOf: [{ path: ["id"], containsAny: [":dev"] }],
        },
      },
    });
    expect(entry.models).toEqual(OFFICIAL_ELECTRONHUB_CODING_PLAN_MODELS);
    expect(entry.models).toContain(entry.defaultModel);
    expect(entry.modelContextWindows?.["glm-5.3:dev"]).toBe(262_144);
    expect(entry.modelContextWindows?.["glm-5.3-flash:dev"]).toBe(1_048_576);
    expect(entry.modelInputModalities?.["glm-5.3-flash:dev"]).toEqual(["text", "image"]);
    expect(entry.modelInputModalities?.["glm-5.3:dev"]).toEqual(["text"]);
    expect(entry.noVisionModels).toEqual([
      "deepseek-v4-flash:dev",
      "deepseek-v4-flash-0731:dev",
      "minimax-m2.7:dev",
      "kimi-k2.6:dev",
      "kimi-k2.7-code:dev",
      "glm-5.3:dev",
    ]);
    expect(KEY_LOGIN_PROVIDERS["electronhub-coding-plan"]?.models).toEqual(
      OFFICIAL_ELECTRONHUB_CODING_PLAN_MODELS,
    );
    expect(KEY_LOGIN_PROVIDERS["electronhub-coding-plan"]?.noVisionModels).toEqual(entry.noVisionModels);
    const seed = providerConfigSeed(entry);
    expect(seed).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://api.electronhub.ai/v1",
      defaultModel: "glm-5.3:dev",
      liveModels: true,
    });
    expect(seed).not.toHaveProperty("preserveCustomDestination");
    expect(seed).not.toHaveProperty("modelDiscovery");
    expect(KEY_LOGIN_PROVIDERS["electronhub-coding-plan"]).not.toHaveProperty("modelDiscovery");
  });

  test(":dev models inherit the de-suffixed thinking ladders", () => {
    const seed = providerConfigSeed(registryEntry());
    // GLM-5.3 folds every incoming effort into three effective tiers (z.ai), so the
    // default five-rung ladder must NOT leak through just because the id carries :dev.
    expect(configuredReasoningEfforts(seed, "glm-5.3:dev")).toEqual(["low", "high", "max"]);
    expect(configuredReasoningEfforts(seed, "glm-5.3-flash:dev")).toEqual(["low", "high", "max"]);
    expect(configuredReasoningEfforts(seed, "deepseek-v4-flash:dev")).toEqual(["low", "high", "max"]);
    expect(configuredReasoningEfforts(seed, "deepseek-v4-flash-0731:dev")).toEqual(["low", "high", "max"]);
    // Kimi Code exposes no effort control for the k2.x roster on its home plan.
    expect(configuredReasoningEfforts(seed, "kimi-k2.6:dev")).toEqual([]);
    expect(configuredReasoningEfforts(seed, "kimi-k2.7-code:dev")).toEqual([]);
    // Aggregator-hosted families take the plain five-rung ladder.
    expect(configuredReasoningEfforts(seed, "minimax-m2.7:dev"))
      .toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(configuredReasoningEfforts(seed, "qwen3.8-27b:dev"))
      .toEqual(["low", "medium", "high", "xhigh", "max"]);
    // DeepSeek's wire map folds medium/xhigh onto high through the :dev id too.
    expect(mapReasoningEffort(seed, "deepseek-v4-flash-0731:dev", "medium")).toBe("high");
    expect(mapReasoningEffort(seed, "deepseek-v4-flash-0731:dev", "xhigh")).toBe("high");
    expect(mapReasoningEffort(seed, "deepseek-v4-flash-0731:dev", "max")).toBe("max");
  });

  test("the pi export carries the ladders as reasoning + thinkingLevelMap", async () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "electronhub-coding-plan",
      providers: {
        "electronhub-coding-plan": {
          adapter: "openai-chat",
          baseUrl: "https://api.electronhub.ai/v1",
          apiKey: "ek-dev-test",
          authMode: "key",
        },
      },
    };
    const rows = await loadExportModels(config);
    const built = buildClientConfigText("pi", {
      baseUrl: "http://127.0.0.1:10100/v1",
      models: rows,
      config,
    });
    const models = (built.document as {
      providers: { opencodex: { models: Array<{ id: string; reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> }> } };
    }).providers.opencodex.models;
    const glm = models.find(model => model.id === "electronhub-coding-plan/glm-5.3:dev");
    // GLM-5.3 folds to three effective tiers; pi must not be offered the default five.
    expect(glm?.reasoning).toBe(true);
    expect(glm?.thinkingLevelMap).toMatchObject({ low: "low", high: "high", max: "max", medium: null });
    // Kimi k2.x has no effort control on its home plan, so pi gets no reasoning boolean.
    const kimi = models.find(model => model.id === "electronhub-coding-plan/kimi-k2.7-code:dev");
    expect(kimi).not.toHaveProperty("reasoning");
  });

  test("live discovery keeps only :dev models from the full Electron Hub catalog", async () => {
    const filter = registryEntry().modelDiscovery?.filter;
    expect(providerModelMatchesDiscoveryFilter({ id: "glm-5.3:dev" }, filter)).toBe(true);
    expect(providerModelMatchesDiscoveryFilter({ id: "gpt-4o" }, filter)).toBe(false);

    await withStubbedProviderFetch(async () => {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        expect(String(input)).toBe("https://api.electronhub.ai/v1/models");
        return new Response(JSON.stringify({
          object: "list",
          data: [
            { id: "gpt-4o", object: "model" },
            { id: "glm-5.3:dev", object: "model" },
            { id: "kimi-k2.7-code:dev", object: "model" },
            { id: "claude-sonnet-4", object: "model" },
          ],
        }), { status: 200 });
      }) as typeof fetch;

      const config: OcxConfig = {
        port: 10100,
        defaultProvider: "electronhub-coding-plan",
        providers: {
          "electronhub-coding-plan": {
            adapter: "openai-chat",
            baseUrl: "https://api.electronhub.ai/v1",
            apiKey: "ek-dev-test-key",
            authMode: "key",
            liveModels: true,
          },
        },
      };
      const models = (await gatherRoutedModels(config))
        .filter(row => row.provider === "electronhub-coding-plan");
      const ids = models.map(row => row.id);
      expect(ids).toContain("glm-5.3:dev");
      expect(ids).toContain("kimi-k2.7-code:dev");
      expect(ids).not.toContain("gpt-4o");
      expect(ids).not.toContain("claude-sonnet-4");
    });
  });

  test("catalog enrichment fills missing roster metadata without overwriting an explicit models list", () => {
    const missing = providerConfigSeed(registryEntry());
    delete missing.models;
    delete missing.modelContextWindows;
    delete missing.noVisionModels;

    enrichProviderFromRegistry("electronhub-coding-plan", missing);
    expect(missing.models).toEqual(OFFICIAL_ELECTRONHUB_CODING_PLAN_MODELS);
    expect(missing.modelContextWindows?.["glm-5.3:dev"]).toBe(262_144);
    expect(missing.noVisionModels).toContain("glm-5.3:dev");

    const explicit = providerConfigSeed(registryEntry());
    explicit.models = ["custom-kept:dev"];
    enrichProviderFromRegistry("electronhub-coding-plan", explicit);
    expect(explicit.models).toEqual(["custom-kept:dev"]);

    const customHost = {
      ...providerConfigSeed(registryEntry()),
      baseUrl: "https://custom.example/v1",
      models: ["custom-model"],
    };
    enrichProviderFromRegistry("electronhub-coding-plan", customHost);
    expect(customHost.models).toEqual(["custom-model"]);
  });

  test("routing keeps the :dev model id and hits the Electron Hub chat endpoint", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "electronhub-coding-plan",
      providers: {
        "electronhub-coding-plan": {
          adapter: "openai-chat",
          baseUrl: "https://api.electronhub.ai/v1",
          apiKey: "ek-dev-test-key",
          authMode: "key",
        },
      },
    };
    const route = routeModel(config, "electronhub-coding-plan/glm-5.3:dev");
    const request = createOpenAIChatAdapter(route.provider).buildRequest(parsed(route.modelId));
    const body = JSON.parse(request.body) as Record<string, unknown>;

    expect(route.modelId).toBe("glm-5.3:dev");
    expect(body.model).toBe("glm-5.3:dev");
    expect(request.url).toBe("https://api.electronhub.ai/v1/chat/completions");
    expect(request.headers.Authorization).toBe("Bearer ek-dev-test-key");
  });

  test("same-named custom provider keeps its own destination and credential boundary", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "electronhub-coding-plan",
      providers: {
        "electronhub-coding-plan": {
          adapter: "openai-chat",
          baseUrl: "https://custom.example/v1",
          apiKey: "custom-key",
          authMode: "key",
        },
      },
    };
    const route = routeModel(config, "electronhub-coding-plan/custom-model");
    const request = createOpenAIChatAdapter(route.provider).buildRequest(parsed(route.modelId));

    expect(route.provider.baseUrl).toBe("https://custom.example/v1");
    expect(route.provider.apiKey).toBe("custom-key");
    expect(request.url).toBe("https://custom.example/v1/chat/completions");
    expect(request.headers.Authorization).toBe("Bearer custom-key");
  });
});
