import { isValidModelDiscoveryModelId, MODEL_DISCOVERY_MAX_MODELS } from "../../providers/model-discovery-limits";
import type { CliModelConfig } from "./proto";

/**
 * Fold the Cascade roster into the model ids users actually select.
 *
 * ## The problem
 *
 * `GetCliModelCalls` reports ~209 callable entries, but most are not distinct models — they are
 * the same model at different reasoning efforts. The effort is baked into the uid
 * (`claude-opus-5-medium`, `claude-opus-5-high`), so the raw roster reads as 209 models when it is
 * really 74.
 *
 * ## The fold
 *
 * Each uid is decomposed into (base, orthogonal axes, effort rung):
 *
 *   `claude-opus-5-high`            → base `claude-opus-5`,            effort `high`
 *   `claude-opus-5-high-fast`       → base `claude-opus-5`, axis `fast`, effort `high`
 *   `swe-1-7-lightning-medium`      → base `swe-1-7`,       axis `lightning`, effort `medium`
 *   `glm-5-2-1m`                    → base `glm-5-2`,       axis `1m`,        no effort
 *   `gpt-5-6-sol-none-priority`     → base `gpt-5-6-sol`,   axis `priority`,  effort `none`
 *
 * The exposed id is base + axes (`claude-opus-5-fast`), and the effort rungs become that id's
 * ladder. Axes are NOT effort rungs: `-fast` and `-priority` select different serving tiers, `-1m`
 * a larger context window, `-thinking` a different model build. Folding them into the ladder would
 * offer a user a "fast" thinking level that does not exist.
 *
 * ## Why the wire uid is stored, never reconstructed
 *
 * The rung order is not uniform. `swe-1-7-lightning-medium` puts effort BEFORE the axis, while
 * `claude-opus-5-high-fast` puts it before the axis too — but `glm-5-2-max-1m` puts the axis LAST.
 * `claude-opus-4-6-thinking-1m` chains two axes. A `base-effort-axes` join is wrong for at least
 * one real entry (verified: `swe-1-7-lightning` + `medium` naive-joins to
 * `swe-1-7-medium-lightning`, which is NOT a roster uid). So every rung keeps the exact uid the
 * server advertised, and resolution is a map lookup.
 *
 * ## Defaults
 *
 * 39 of the 55 modern groups ship no bare uid, so selecting one at its default effort must still
 * produce a callable uid. The first rung in roster order is the server's own ordering, which puts
 * `medium` first for the Claude/GPT families — matching Devin's documented default. The ACP
 * provider reached the same conclusion for `swe-2` (`DEVIN_CLI_MODEL_DEFAULT_REASONING_EFFORTS`).
 * A bare rung, when present, always wins over the first-rung default: its presence in the roster
 * means the server considers the unsuffixed uid callable.
 */

/**
 * Reasoning-effort rungs. Order here is only for validation; a model's ladder order comes from the
 * roster, because the server's ordering is the only authority on which rung is the default.
 */
const EFFORT_WORDS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Suffixes that name a SEPARATE model identity rather than a reasoning rung.
 *
 * `fast` and `priority` are serving tiers (the `-priority` Gpt entries bill differently), `lightning`
 * is Cognition's latency-optimized build, `1m` is a long-context variant, and `thinking` is a
 * distinct build of the older Claude families. None of them can be expressed as an effort level, so
 * they stay in the exposed id.
 */
const AXIS_WORDS = ["fast", "priority", "lightning", "1m", "thinking"] as const;

const EFFORT_SET: ReadonlySet<string> = new Set(EFFORT_WORDS);
const AXIS_SET: ReadonlySet<string> = new Set(AXIS_WORDS);

/**
 * Legacy uids that use `MODEL_UPPER_SNAKE` instead of the modern hyphenated convention.
 *
 * They are real callable models (`MODEL_PRIVATE_2` is Claude Sonnet 4.5, `MODEL_GPT_5_2_LOW` is
 * GPT-5.2 Low Thinking) with no hyphenated equivalent, so dropping them would remove models the
 * account can actually use. They are passed through unfolded: their separators do not disambiguate
 * base from rung (`MODEL_CLAUDE_4_5_OPUS` has no rung at all, while `..._OPUS_THINKING` is a distinct
 * model, not a rung), so folding them would require guessing.
 */
const LEGACY_PREFIX = "MODEL_";

export interface DevinHttpModel {
  /** The selectable id: base plus orthogonal axes. */
  id: string;
  label: string;
  contextWindow: number;
  supportsImages: boolean;
  /** Ordered effort rungs, empty when the model has exactly one callable uid. */
  efforts: string[];
  /** The effort used when the caller names none. */
  defaultEffort?: string;
  /** Exact roster uid per rung; key "" is the bare uid. Always at least one entry. */
  wireUids: Record<string, string>;
}

export interface DevinRosterFold {
  models: DevinHttpModel[];
  /** Count of roster entries that were folded away, for diagnostics. */
  foldedVariants: number;
}

/** Split one trailing word off `id`, trying both separator conventions. */
function stripTrailingWord(id: string, words: ReadonlySet<string>): { base: string; word?: string } {
  for (const separator of ["_", "-"]) {
    const index = id.lastIndexOf(separator);
    if (index <= 0) continue;
    const word = id.slice(index + 1).toLowerCase();
    if (words.has(word)) return { base: id.slice(0, index), word };
  }
  return { base: id };
}

interface DecomposedUid {
  base: string;
  axes: string[];
  effort?: string;
}

/**
 * Decompose one uid.
 *
 * Axes are stripped first, outermost-last, so a chained suffix
 * (`claude-opus-4-6-thinking-1m`) unwinds right-to-left into `[thinking, 1m]`. The effort rung is
 * only stripped from what remains, which is what keeps `claude-opus-4-6`'s bare uid from being
 * mistaken for a rung and `swe-1-7-lightning-medium`'s axis from consuming the effort.
 */
export function decomposeDevinUid(uid: string): DecomposedUid {
  let rest = uid;
  const axes: string[] = [];
  for (;;) {
    const stripped = stripTrailingWord(rest, AXIS_SET);
    if (!stripped.word) break;
    axes.unshift(stripped.word);
    rest = stripped.base;
  }
  const effort = stripTrailingWord(rest, EFFORT_SET);
  return { base: effort.base, axes, effort: effort.word };
}

/** The selectable id for a decomposed uid: base plus its orthogonal axes. */
export function devinExposedModelId(decomposed: DecomposedUid): string {
  return [decomposed.base, ...decomposed.axes].join("-");
}

/**
 * Fold a live roster.
 *
 * Insertion order is preserved (the server's order), which is what makes the "first rung is the
 * default" rule deterministic. Legacy `MODEL_*` entries and entries with a malformed uid are
 * emitted as single-uid models so nothing callable is lost to a parsing rule.
 */
export function foldDevinRoster(configs: CliModelConfig[], maxModels = MODEL_DISCOVERY_MAX_MODELS): DevinRosterFold {
  const order: string[] = [];
  const byId = new Map<string, DevinHttpModel>();
  let foldedVariants = 0;

  const upsert = (id: string, config: CliModelConfig): DevinHttpModel | null => {
    if (!isValidModelDiscoveryModelId(id)) return null;
    let model = byId.get(id);
    if (!model) {
      model = {
        id,
        label: config.label || id,
        contextWindow: config.contextWindow,
        supportsImages: config.supportsImages,
        efforts: [],
        wireUids: {},
      };
      byId.set(id, model);
      order.push(id);
      return model;
    }
    // A later variant may carry the context window an earlier one omitted.
    if (!model.contextWindow && config.contextWindow) model.contextWindow = config.contextWindow;
    if (config.supportsImages) model.supportsImages = true;
    return model;
  };

  for (const config of configs) {
    if (order.length >= maxModels) break;
    const uid = config.id;
    if (!uid) continue;

    if (uid.startsWith(LEGACY_PREFIX)) {
      // Unfolded: the separator convention cannot distinguish base from rung here.
      const model = upsert(uid, config);
      if (model && !model.wireUids[""]) model.wireUids[""] = uid;
      continue;
    }

    const decomposed = decomposeDevinUid(uid);
    const exposed = devinExposedModelId(decomposed);
    const model = upsert(exposed, config);
    if (!model) continue;

    const rung = decomposed.effort ?? "";
    if (model.wireUids[rung] === undefined) {
      model.wireUids[rung] = uid;
      if (rung) model.efforts.push(rung);
      else foldedVariants += 1;
    } else {
      foldedVariants += 1;
    }
  }

  const models = order.map(id => byId.get(id)!).map(model => {
    // A bare rung wins; otherwise the server's first listed rung is the default. Only meaningful
    // when there is more than one callable uid — a single-uid model has nothing to choose.
    const hasBare = model.wireUids[""] !== undefined;
    const defaultEffort = model.efforts.length === 0
      ? undefined
      : hasBare
        ? undefined
        : model.efforts[0];
    return {
      ...model,
      ...(defaultEffort ? { defaultEffort } : {}),
    };
  });

  return { models, foldedVariants };
}

/**
 * Resolve the exact wire uid for a model at a requested effort.
 *
 * Returns undefined when the caller asked for a rung this model does not offer. Callers must fail
 * closed on undefined rather than falling back to another rung: silently downgrading
 * `claude-opus-5` from `max` to `medium` would answer a different question than the one asked.
 */
export function resolveDevinWireUid(
  model: Pick<DevinHttpModel, "wireUids" | "defaultEffort">,
  effort?: string,
): string | undefined {
  if (effort) return model.wireUids[effort];
  if (model.wireUids[""] !== undefined) return model.wireUids[""];
  if (model.defaultEffort) return model.wireUids[model.defaultEffort];
  // Single-uid models with no bare entry (a legacy MODEL_* row) keep their one uid at key "".
  return model.wireUids[""];
}
