import { afterEach, describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { gatherRoutedModels } from "../../src/codex/catalog";
import { clearModelCache } from "../../src/codex/model-cache";
import { buildInitProviders } from "../../src/cli/init";
import { buildModelsRequest } from "../../src/oauth";
import { KEY_LOGIN_PROVIDERS, validateApiKey } from "../../src/oauth/key-providers";
import {
  deriveInitProviders,
  deriveProviderPresets,
  providerConfigSeed,
} from "../../src/providers/derive";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { routeModel } from "../../src/router";
import type { OcxConfig } from "../../src/types";
import { withStubbedProviderFetch } from "../helpers/catalog-provider-fetch";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("devin");
});

function devinEntry() {
  const entry = PROVIDER_REGISTRY.find(row => row.id === "devin");
  if (!entry) throw new Error("missing devin registry entry");
  return entry;
}

function devinConfig(overrides: Partial<OcxConfig["providers"][string]> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "devin",
    providers: {
      devin: {
        adapter: "openai-chat",
        baseUrl: "https://api.cognition.ai/v1",
        authMode: "key",
        apiKey: "cog-test-key",
        liveModels: true,
        ...overrides,
      },
    },
  };
}

describe("Devin (Cognition) provider", () => {
  test("registry entry fronts the OpenAI-compatible SWE catalog, not the session API", () => {
    expect(devinEntry()).toMatchObject({
      id: "devin",
      label: "Devin (Cognition)",
      adapter: "openai-chat",
      baseUrl: "https://api.cognition.ai/v1",
      authKind: "key",
      defaultModel: "swe-1.7",
      liveModels: true,
    });
    expect(devinEntry().models).toEqual(["swe-1.7", "swe-1.7-lightning", "swe-1.6"]);
    expect(devinEntry().modelContextWindows).toEqual({
      "swe-1.7": 262_144,
      "swe-1.7-lightning": 262_144,
    });
    // No verified reasoning_effort contract yet: the entry must not advertise an
    // effort ladder the chat API has not been probed for.
    expect(devinEntry().reasoningEfforts).toBeUndefined();
    expect(devinEntry().modelReasoningEfforts).toBeUndefined();
    expect(devinEntry().note).toContain("api.devin.ai");
    expect(devinEntry().note).toContain("service user");
  });

  test("derives key-login, init, and dashboard presets from the registry row", () => {
    expect(KEY_LOGIN_PROVIDERS.devin).toMatchObject({
      label: "Devin (Cognition)",
      adapter: "openai-chat",
      baseUrl: "https://api.cognition.ai/v1",
      dashboardUrl: "https://app.devin.ai",
      liveModels: true,
      defaultModel: "swe-1.7",
    });
    expect(buildInitProviders()).toEqual(deriveInitProviders());
    expect(buildInitProviders().find(row => row.id === "devin")).toMatchObject({
      kind: "key",
      adapter: "openai-chat",
      baseUrl: "https://api.cognition.ai/v1",
    });
    expect(deriveProviderPresets().find(row => row.id === "devin")).toMatchObject({
      auth: "key",
      dashboardUrl: "https://app.devin.ai",
    });

    const seed = providerConfigSeed(devinEntry());
    expect(seed).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://api.cognition.ai/v1",
      authMode: "key",
      liveModels: true,
      defaultModel: "swe-1.7",
    });
    expect(seed.models).toEqual(["swe-1.7", "swe-1.7-lightning", "swe-1.6"]);
  });

  test("lists and validates models through the Bearer-authenticated /models endpoint", async () => {
    const request = buildModelsRequest(
      devinConfig().providers.devin!,
      "cog-model-list-key",
      "devin",
    );
    expect(request).toEqual({
      url: "https://api.cognition.ai/v1/models",
      headers: { Authorization: "Bearer cog-model-list-key" },
    });

    globalThis.fetch = (async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer cog-validation-key");
      expect(init?.redirect).toBe("error");
      return new Response(JSON.stringify({ data: [{ id: "swe-1.7" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    expect(await validateApiKey(
      "devin",
      KEY_LOGIN_PROVIDERS.devin!,
      "cog-validation-key",
    )).toBe(true);
  });

  test("routes chat completions to the Cognition host with Bearer auth", () => {
    const route = routeModel(devinConfig(), "devin/swe-1.7");
    expect(route.modelId).toBe("swe-1.7");
    expect(route.provider.adapter).toBe("openai-chat");
    expect(route.provider.baseUrl).toBe("https://api.cognition.ai/v1");

    const request = createOpenAIChatAdapter(route.provider).buildRequest({
      modelId: route.modelId,
      context: {
        messages: [{ role: "user", content: "ping", timestamp: 0 }],
        tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }],
      },
      stream: true,
      options: {},
    });
    const body = JSON.parse(String(request.body)) as Record<string, unknown>;

    expect(request.url).toBe("https://api.cognition.ai/v1/chat/completions");
    expect(request.headers.Authorization).toBe("Bearer cog-test-key");
    expect(body.model).toBe("swe-1.7");
    expect(body.stream).toBe(true);
  });

  test("live discovery failure keeps the static seed routable", async () => {
    globalThis.fetch = (async () => new Response("upstream unavailable", { status: 503 })) as typeof fetch;

    const config = withStubbedProviderFetch(devinConfig());
    const models = (await gatherRoutedModels(config)).filter(row => row.provider === "devin");
    expect(models.map(row => row.id).sort()).toEqual(["swe-1.6", "swe-1.7", "swe-1.7-lightning"]);
    expect(routeModel(config, "devin/swe-1.7").modelId).toBe("swe-1.7");
  });
});
