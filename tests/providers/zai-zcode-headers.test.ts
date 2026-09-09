import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { providerConfigSeed } from "../../src/providers/derive";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { routedProviderConfig } from "../../src/router";
import { buildModelsRequest } from "../../src/oauth";
import type { OcxParsedRequest, OcxProviderConfig } from "../../src/types";

const ZCP_DESTINATION = "https://api.z.ai/api/coding/paas/v4";
const BIGMODEL_DESTINATION = "https://open.bigmodel.cn/api/coding/paas/v4";

function minimalRequest(model = "glm-5.3"): OcxParsedRequest {
  return {
    modelId: model,
    stream: false,
    context: { messages: [{ role: "user", content: "hi" }], tools: [] },
    options: {},
  };
}

describe("Z.AI GLM Coding Plan ZCode client identity", () => {
  const zai = PROVIDER_REGISTRY.find(e => e.id === "zai");
  const bigmodel = PROVIDER_REGISTRY.find(e => e.id === "zhipu-bigmodel-coding");

  test("the zai and bigmodel-coding rows apply the ZCode desktop identity", () => {
    expect(zai?.staticHeaders?.["User-Agent"]).toBe("ZCode/3.11.2");
    expect(zai?.staticHeaders?.["X-ZCode-App-Version"]).toBe("3.11.2");
    expect(zai?.staticHeaders?.["X-ZCode-Agent"]).toBe("glm");
    expect(zai?.staticHeaders?.["X-Title"]).toBe("Z Code@electron");
    expect(zai?.staticHeaders?.["HTTP-Referer"]).toBe("https://zcode.z.ai/");
    expect(zai?.staticHeaders?.["X-Release-Channel"]).toBe("production");
    expect(zai?.staticHeaders?.["X-Platform"]).toBe("win32-x64");
    expect(zai?.staticHeaders?.["X-Os-Category"]).toBe("windows");
    expect(zai?.staticHeaders?.["X-Client-Language"]).toBe("zh-CN");
    expect(zai?.staticHeaders?.["X-Client-Timezone"]).toBe("Asia/Shanghai");

    expect(bigmodel?.staticHeaders?.["User-Agent"]).toBe("ZCode/3.11.2");
    expect(bigmodel?.staticHeaders?.["X-ZCode-Agent"]).toBe("glm");
  });

  test("no credential is smuggled through the identity headers", () => {
    expect(zai?.staticHeaders?.["Authorization"]).toBeUndefined();
    expect(zai?.staticHeaders?.["x-api-key"]).toBeUndefined();
    expect(zai?.staticHeaders?.["api-key"]).toBeUndefined();
  });

  test("providerConfigSeed propagates the ZCode identity headers", () => {
    expect(providerConfigSeed(zai!).headers?.["User-Agent"]).toBe("ZCode/3.11.2");
    expect(providerConfigSeed(zai!).headers?.["X-ZCode-Agent"]).toBe("glm");
    expect(providerConfigSeed(bigmodel!).headers?.["User-Agent"]).toBe("ZCode/3.11.2");
  });

  test("a config saved without headers gains the full registry set at route time", () => {
    const persisted = (baseUrl: string): OcxProviderConfig => ({
      adapter: "openai-chat",
      baseUrl,
      authKind: "key",
    });
    const routedZai = routedProviderConfig("zai", persisted(ZCP_DESTINATION));
    expect(routedZai.headers?.["User-Agent"]).toBe("ZCode/3.11.2");
    expect(routedZai.headers?.["X-ZCode-Agent"]).toBe("glm");

    const routedBigmodel = routedProviderConfig("zhipu-bigmodel-coding", persisted(BIGMODEL_DESTINATION));
    expect(routedBigmodel.headers?.["User-Agent"]).toBe("ZCode/3.11.2");
    expect(routedBigmodel.headers?.["X-ZCode-Agent"]).toBe("glm");
  });

  test("the merged headers reach the wire on inference", () => {
    const routed = routedProviderConfig("zai", providerConfigSeed(zai!));
    const adapter = createOpenAIChatAdapter({
      ...routed,
      apiKey: "test-key",
      keyOptional: true,
    });
    const req = adapter.buildRequest(minimalRequest());
    const headers = req.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("ZCode/3.11.2");
    expect(headers["X-ZCode-Agent"]).toBe("glm");
    expect(req.url).toBe(`${ZCP_DESTINATION}/chat/completions`);
  });

  test("a user override wins and is not duplicated", () => {
    const routed = routedProviderConfig("zai", {
      adapter: "openai-chat",
      baseUrl: ZCP_DESTINATION,
      authKind: "key",
      headers: { "user-agent": "custom-agent" },
    });
    const uaKeys = Object.keys(routed.headers ?? {}).filter(k => k.toLowerCase() === "user-agent");
    expect(uaKeys).toEqual(["user-agent"]);
    expect(routed.headers?.["user-agent"]).toBe("custom-agent");
    expect(new Headers(routed.headers as Record<string, string>).get("user-agent")).toBe("custom-agent");
    // Names the user did not claim are still filled.
    expect(routed.headers?.["X-ZCode-Agent"]).toBe("glm");
  });

  test("model discovery carries the same ZCode fingerprint", () => {
    const req = buildModelsRequest(
      { adapter: "openai-chat", baseUrl: ZCP_DESTINATION, authKind: "key" },
      undefined,
      "zai",
    );
    expect(req.headers["User-Agent"]).toBe("ZCode/3.11.2");
    expect(req.headers["X-ZCode-Agent"]).toBe("glm");
  });
});
