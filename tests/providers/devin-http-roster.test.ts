import { describe, expect, test } from "bun:test";
import {
  decomposeDevinUid,
  devinExposedModelId,
  foldDevinRoster,
  resolveDevinWireUid,
} from "../../src/adapters/devin-http/roster";
import type { CliModelConfig } from "../../src/adapters/devin-http/proto";
import {
  DEVIN_HTTP_MODELS,
  DEVIN_HTTP_MODEL_DEFAULT_REASONING_EFFORTS,
  DEVIN_HTTP_MODEL_REASONING_EFFORTS,
  DEVIN_HTTP_MODEL_WIRE_UIDS,
} from "../../src/providers/devin-http-models";

/**
 * Roster fold coverage.
 *
 * The fold is where a wrong answer is quiet: a mis-split uid still produces a plausible model id and
 * a plausible ladder, and the mistake only surfaces as a 4xx from the server for the one rung that
 * resolves to a uid the roster never advertised. These tests therefore pin the exact wire uid per
 * rung, not just the shape of the exposed list.
 */

function config(id: string, extra: Partial<CliModelConfig> = {}): CliModelConfig {
  return {
    id,
    label: id,
    contextWindow: 262_000,
    supportsImages: false,
    supportsThinking: true,
    ...extra,
  };
}

describe("devin-http uid decomposition", () => {
  test("a trailing effort word becomes the rung and stays out of the exposed id", () => {
    expect(decomposeDevinUid("claude-opus-5-high")).toEqual({ base: "claude-opus-5", axes: [], effort: "high" });
    expect(devinExposedModelId(decomposeDevinUid("claude-opus-5-high"))).toBe("claude-opus-5");
  });

  test("an orthogonal axis becomes part of the exposed id, never a rung", () => {
    // `-fast` selects a different serving tier, so offering it as a "fast" thinking level would be
    // a request for a model that does not exist.
    expect(decomposeDevinUid("claude-opus-5-high-fast")).toEqual({
      base: "claude-opus-5",
      axes: ["fast"],
      effort: "high",
    });
    expect(devinExposedModelId(decomposeDevinUid("claude-opus-5-high-fast"))).toBe("claude-opus-5-fast");
  });

  test("a bare axis suffix stays in the exposed id with no rung", () => {
    expect(decomposeDevinUid("glm-5-2-1m")).toEqual({ base: "glm-5-2", axes: ["1m"], effort: undefined });
    expect(decomposeDevinUid("swe-1-6-fast")).toEqual({ base: "swe-1-6", axes: ["fast"], effort: undefined });
  });

  test("chained axes unwind right-to-left", () => {
    expect(decomposeDevinUid("claude-opus-4-6-thinking-1m")).toEqual({
      base: "claude-opus-4-6",
      axes: ["thinking", "1m"],
      effort: undefined,
    });
  });

  test("an axis before an effort still lands on the axis's exposed model", () => {
    // `swe-1-7-lightning-medium` is the `medium` rung of the `swe-1-7-lightning` model, not the
    // `lightning` axis of `swe-1-7`. Which reading the decomposition takes does not matter for the
    // exposed id — `base + axes` concatenates either way — but it DOES matter for where the rung is
    // filed, and a `base-effort-axes` string join would produce `swe-1-7-medium-lightning`, a uid
    // the roster never advertises. That is why the wire uid is stored rather than reconstructed.
    const decomposed = decomposeDevinUid("swe-1-7-lightning-medium");
    expect(decomposed.effort).toBe("medium");
    expect(devinExposedModelId(decomposed)).toBe("swe-1-7-lightning");

    // The naive join the comment warns about, for contrast.
    expect(["swe-1-7", decomposed.effort, ...decomposed.axes].filter(Boolean).join("-")).toContain("swe-1-7-medium");
  });

  test("a uid with no recognizable suffix is its own base", () => {
    expect(decomposeDevinUid("kimi-k2-6")).toEqual({ base: "kimi-k2-6", axes: [], effort: undefined });
    expect(decomposeDevinUid("MODEL_PRIVATE_2")).toEqual({ base: "MODEL_PRIVATE_2", axes: [], effort: undefined });
  });
});

describe("devin-http roster folding", () => {
  test("variants of one base collapse into a single exposed model with a ladder", () => {
    const folded = foldDevinRoster([
      config("claude-opus-5-medium"),
      config("claude-opus-5-high"),
      config("claude-opus-5-max"),
    ]);
    expect(folded.models).toHaveLength(1);
    expect(folded.models[0]!.id).toBe("claude-opus-5");
    expect(folded.models[0]!.efforts).toEqual(["medium", "high", "max"]);
    expect(folded.models[0]!.wireUids).toEqual({
      medium: "claude-opus-5-medium",
      high: "claude-opus-5-high",
      max: "claude-opus-5-max",
    });
  });

  test("ladder order follows roster order, so the server decides the default rung", () => {
    // Roster order is the only authority on which rung is the default; sorting alphabetically would
    // silently make `high` the default for a family whose own order says `medium`.
    const folded = foldDevinRoster([config("m-high"), config("m-medium"), config("m-low")]);
    expect(folded.models[0]!.efforts).toEqual(["high", "medium", "low"]);
    expect(folded.models[0]!.defaultEffort).toBe("high");
  });

  test("a bare uid wins as the default over any rung", () => {
    const folded = foldDevinRoster([config("m-medium"), config("m")]);
    expect(folded.models[0]!.wireUids[""]).toBe("m");
    // A present bare uid means the unsuffixed uid is itself callable, so there is no default rung.
    expect(folded.models[0]!.defaultEffort).toBeUndefined();
    expect(resolveDevinWireUid(folded.models[0]!, undefined)).toBe("m");
  });

  test("an axis family becomes its own exposed model with its own ladder", () => {
    const folded = foldDevinRoster([
      config("claude-opus-5-high"),
      config("claude-opus-5-high-fast"),
      config("claude-opus-5-low-fast"),
    ]);
    const byId = Object.fromEntries(folded.models.map(m => [m.id, m]));
    expect(Object.keys(byId).sort()).toEqual(["claude-opus-5", "claude-opus-5-fast"]);
    expect(byId["claude-opus-5"]!.efforts).toEqual(["high"]);
    expect(byId["claude-opus-5-fast"]!.efforts).toEqual(["high", "low"]);
    expect(byId["claude-opus-5-fast"]!.wireUids).toEqual({
      high: "claude-opus-5-high-fast",
      low: "claude-opus-5-low-fast",
    });
  });

  test("legacy MODEL_ uids pass through unfolded as single-uid models", () => {
    // Their separators cannot distinguish base from rung, so folding them would be a guess.
    const folded = foldDevinRoster([config("MODEL_PRIVATE_2"), config("MODEL_GPT_5_2_LOW")]);
    expect(folded.models.map(m => m.id)).toEqual(["MODEL_PRIVATE_2", "MODEL_GPT_5_2_LOW"]);
    expect(folded.models[0]!.efforts).toEqual([]);
    expect(folded.models[0]!.wireUids).toEqual({ "": "MODEL_PRIVATE_2" });
  });

  test("insertion order is preserved so the catalog is stable across calls", () => {
    const input = [config("z-high"), config("a-high"), config("m-high")];
    expect(foldDevinRoster(input).models.map(m => m.id)).toEqual(["z", "a", "m"]);
    expect(foldDevinRoster(input).models.map(m => m.id)).toEqual(["z", "a", "m"]);
  });

  test("a later variant contributes a context window an earlier one omitted", () => {
    const folded = foldDevinRoster([
      config("m-medium", { contextWindow: 0 }),
      config("m-high", { contextWindow: 1_000_000 }),
    ]);
    expect(folded.models[0]!.contextWindow).toBe(1_000_000);
  });

  test("image support is the union across a model's rungs", () => {
    const folded = foldDevinRoster([
      config("m-medium", { supportsImages: false }),
      config("m-high", { supportsImages: true }),
    ]);
    expect(folded.models[0]!.supportsImages).toBe(true);
  });

  test("a duplicate rung keeps the first uid and counts as folded", () => {
    const folded = foldDevinRoster([config("m-high"), config("m-high")]);
    expect(folded.models[0]!.wireUids.high).toBe("m-high");
    expect(folded.foldedVariants).toBe(1);
  });

  test("an invalid uid is dropped rather than published as an unselectable model id", () => {
    const folded = foldDevinRoster([
      config("good-model"),
      config("bad\nmodel"),
      config(" bad-model "),
      config(""),
    ]);
    expect(folded.models.map(m => m.id)).toEqual(["good-model"]);
  });

  test("the model count ceiling is respected", () => {
    const many = Array.from({ length: 10 }, (_, i) => config(`model-${i}`));
    expect(foldDevinRoster(many, 3).models).toHaveLength(3);
  });

  test("an empty roster folds to an empty list, not a seed", () => {
    expect(foldDevinRoster([])).toEqual({ models: [], foldedVariants: 0 });
  });
});

describe("devin-http wire uid resolution", () => {
  const model = {
    wireUids: { "": "m", medium: "m-medium", high: "m-high" } as Record<string, string>,
    defaultEffort: undefined,
  };

  test("an explicit effort resolves to its exact uid", () => {
    expect(resolveDevinWireUid(model, "high")).toBe("m-high");
  });

  test("a rung the model does not offer fails closed instead of downgrading", () => {
    // Answering `max` with a `medium` call would be a different question than the one asked.
    expect(resolveDevinWireUid(model, "max")).toBeUndefined();
  });

  test("no effort prefers the bare uid, then the default rung, then the sole uid", () => {
    expect(resolveDevinWireUid(model, undefined)).toBe("m");
    expect(resolveDevinWireUid({ wireUids: { medium: "m-medium" }, defaultEffort: "medium" }, undefined)).toBe("m-medium");
    expect(resolveDevinWireUid({ wireUids: { "": "only" } }, undefined)).toBe("only");
  });
});

describe("devin-http registry seed consistency", () => {
  test("every seeded model has a wire-uid map and every map key is a rung or the bare uid", () => {
    for (const id of DEVIN_HTTP_MODELS) {
      const rungs = DEVIN_HTTP_MODEL_WIRE_UIDS[id];
      expect(rungs, `missing wire uids for ${id}`).toBeDefined();
      expect(Object.keys(rungs!).length, `empty wire uid map for ${id}`).toBeGreaterThan(0);
      const ladder = DEVIN_HTTP_MODEL_REASONING_EFFORTS[id] ?? [];
      // The map may carry the bare rung too, so it is the superset.
      for (const rung of Object.keys(rungs!)) {
        if (rung === "") continue;
        expect(ladder, `${id} lacks a ladder entry for rung ${rung}`).toContain(rung);
      }
    }
  });

  test("every ladder rung resolves to a wire uid and every default is on its own ladder", () => {
    for (const [id, ladder] of Object.entries(DEVIN_HTTP_MODEL_REASONING_EFFORTS)) {
      const rungs = DEVIN_HTTP_MODEL_WIRE_UIDS[id]!;
      for (const rung of ladder) {
        expect(rungs[rung], `${id} rung ${rung} has no wire uid`).toBeDefined();
      }
      const fallback = DEVIN_HTTP_MODEL_DEFAULT_REASONING_EFFORTS[id];
      if (fallback !== undefined) {
        expect(ladder, `${id} default ${fallback} is not on its ladder`).toContain(fallback);
        // A default only exists when the model ships no bare uid.
        expect(rungs[""], `${id} has a bare uid so it needs no default rung`).toBeUndefined();
      }
    }
  });

  test("every wire uid decomposes back to the exposed id it is registered under", () => {
    // This is the invariant that keeps the fold and the map from drifting apart: a uid filed under
    // the wrong exposed id would offer its rung on the wrong model.
    for (const [id, rungs] of Object.entries(DEVIN_HTTP_MODEL_WIRE_UIDS)) {
      if (id.startsWith("MODEL_")) continue;
      for (const uid of Object.values(rungs)) {
        expect(devinExposedModelId(decomposeDevinUid(uid)), `uid ${uid} is filed under ${id}`).toBe(id);
      }
    }
  });

  test("the seed carries no duplicate model ids", () => {
    expect(new Set(DEVIN_HTTP_MODELS).size).toBe(DEVIN_HTTP_MODELS.length);
  });
});
