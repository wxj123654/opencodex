import { describe, expect, test } from "bun:test";
import type { OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { createWindsurfApiAdapter, resolveWindsurfApiWireModel } from "../../src/adapters/windsurf-api";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import {
  WINDSURF_API_MODEL_DEFAULT_REASONING_EFFORTS,
  WINDSURF_API_MODEL_REASONING_EFFORTS,
  WINDSURF_API_MODEL_WIRE_UIDS,
  WINDSURF_API_MODELS,
} from "../../src/providers/windsurf-api-models";

/**
 * The adapter is a thin wrapper over openai-chat: the behavior worth pinning is the
 * effort→wire-id resolution and the body rewrite (model field swapped, reasoning fields
 * stripped), not the chat serialization the inner adapter already covers.
 */

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "windsurf-api",
    baseUrl: "http://101.43.72.126:3003/v1",
    apiKey: "test-key",
    ...overrides,
  } as OcxProviderConfig;
}

function request(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return {
    modelId: "claude-opus-5",
    stream: true,
    options: {},
    context: {
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
    },
    ...overrides,
  } as OcxParsedRequest;
}

async function buildBody(parsed: OcxParsedRequest, prov = provider()): Promise<Record<string, unknown>> {
  const adapter = createWindsurfApiAdapter(prov);
  const request = await adapter.buildRequest(parsed, { headers: new Headers() } as never);
  return JSON.parse(request.body) as Record<string, unknown>;
}

describe("windsurf-api wire model resolution", () => {
  test("an explicit effort resolves to the exact roster uid", () => {
    expect(resolveWindsurfApiWireModel("claude-opus-5", "high")).toBe("claude-opus-5-high");
    expect(resolveWindsurfApiWireModel("claude-opus-5", "max")).toBe("claude-opus-5-max");
  });

  test("speed axes stay in the selectable id and compose with the rung", () => {
    expect(resolveWindsurfApiWireModel("claude-opus-5-fast", "high")).toBe("claude-opus-5-high-fast");
    expect(resolveWindsurfApiWireModel("gpt-5-6-sol-priority", "none")).toBe("gpt-5-6-sol-none-priority");
  });

  test("a bare uid wins over the default rung when the family ships one", () => {
    expect(resolveWindsurfApiWireModel("gpt-5.5")).toBe("gpt-5.5");
    expect(resolveWindsurfApiWireModel("swe-1-7")).toBe("swe-1-7");
    expect(resolveWindsurfApiWireModel("gemini-3.0-flash")).toBe("gemini-3.0-flash");
  });

  test("a family with no bare uid falls back to the seeded default rung", () => {
    // `swe-2` ships no bare uid; sending it verbatim would be an upstream error, so the
    // default rung must be threaded through (same failure mode as devin-http).
    expect(resolveWindsurfApiWireModel("swe-2")).toBe("swe-2-high");
    expect(resolveWindsurfApiWireModel("claude-opus-5")).toBe("claude-opus-5-low");
    expect(resolveWindsurfApiWireModel("gpt-5.4")).toBe("gpt-5.4-none");
  });

  test("legacy MODEL_* rungs resolve through the folded ladder", () => {
    expect(resolveWindsurfApiWireModel("gpt-5.1", "high")).toBe("MODEL_PRIVATE_15");
    expect(resolveWindsurfApiWireModel("gpt-5.1", "none")).toBe("MODEL_PRIVATE_12");
    expect(resolveWindsurfApiWireModel("gemini-3.0-flash", "minimal")).toBe("MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL");
    expect(resolveWindsurfApiWireModel("gpt-5.2", "medium")).toBe("MODEL_GPT_5_2_MEDIUM");
  });

  test("an effort above the ladder clamps at-or-below, never above", () => {
    // gpt-5.3-codex has no medium rung: medium clamps to low, matching the Codex ladder rule.
    expect(resolveWindsurfApiWireModel("gpt-5.3-codex", "medium")).toBe("gpt-5.3-codex-low");
    expect(resolveWindsurfApiWireModel("gemini-3.1-pro", "max")).toBe("gemini-3.1-pro-high");
  });

  test("an unknown model id passes through verbatim so the server answers", () => {
    expect(resolveWindsurfApiWireModel("some-new-model")).toBe("some-new-model");
    expect(resolveWindsurfApiWireModel("some-new-model", "high")).toBe("some-new-model-high");
  });
});

describe("windsurf-api request rewrite", () => {
  test("body.model becomes the wire id and reasoning fields are stripped", async () => {
    const body = await buildBody(request({ options: { reasoning: "high" } }));
    expect(body.model).toBe("claude-opus-5-high");
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
  });

  test("no requested effort still sends a callable wire id", async () => {
    const body = await buildBody(request({ modelId: "swe-2" }));
    expect(body.model).toBe("swe-2-high");
  });

  test("the reasoning log is cleared because no reasoning field reaches the wire", async () => {
    const adapter = createWindsurfApiAdapter(provider());
    const built = await adapter.buildRequest(
      request({ options: { reasoning: "high" } }),
      { headers: new Headers() } as never,
    );
    expect(built.reasoningLog).toBeUndefined();
  });

  test("the adapter reports its own name while inheriting the openai-chat contract", () => {
    const adapter = createWindsurfApiAdapter(provider());
    expect(adapter.name).toBe("windsurf-api");
  });
});

describe("windsurf-api seed integrity", () => {
  test("every seeded model has at least one wire uid", () => {
    for (const id of WINDSURF_API_MODELS) {
      const rungs = WINDSURF_API_MODEL_WIRE_UIDS[id];
      expect(rungs, `missing wire uids for ${id}`).toBeDefined();
      expect(Object.keys(rungs).length).toBeGreaterThan(0);
    }
  });

  test("every ladder rung has a wire uid and every default is on the ladder", () => {
    for (const [id, efforts] of Object.entries(WINDSURF_API_MODEL_REASONING_EFFORTS)) {
      const rungs = WINDSURF_API_MODEL_WIRE_UIDS[id];
      for (const effort of efforts) {
        expect(rungs[effort], `${id} rung ${effort} has no wire uid`).toBeDefined();
      }
    }
    for (const [id, effort] of Object.entries(WINDSURF_API_MODEL_DEFAULT_REASONING_EFFORTS)) {
      expect(WINDSURF_API_MODEL_REASONING_EFFORTS[id], `${id} default ${effort} not on ladder`).toContain(effort);
      // A default is only meaningful when no bare uid exists.
      expect(WINDSURF_API_MODEL_WIRE_UIDS[id][""], `${id} has a bare uid and a default`).toBeUndefined();
    }
  });

  test("the registry entry wires the seed and the adapter", () => {
    const entry = getProviderRegistryEntry("windsurf-api");
    expect(entry).toBeDefined();
    expect(entry!.adapter).toBe("windsurf-api");
    expect(entry!.models).toEqual([...WINDSURF_API_MODELS]);
    expect(entry!.modelReasoningEfforts).toBe(WINDSURF_API_MODEL_REASONING_EFFORTS);
    expect(entry!.modelDefaultReasoningEfforts).toBe(WINDSURF_API_MODEL_DEFAULT_REASONING_EFFORTS);
  });
});
