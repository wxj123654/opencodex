/**
 * Static seed for the `windsurf-api` provider (WindsurfAPI reverse proxy).
 *
 * Generated from the live `GET /v1/models` roster on 2026-09-16: 158 wire ids folded to
 * selectable models. The endpoint is OpenAI Chat Completions compatible, but the reasoning
 * effort is baked into the model id (`claude-opus-5-high`, `gpt-5-6-sol-none-priority`), so the
 * fold mirrors `devin-http`: base + orthogonal axes (`-fast`, `-priority`, `-lightning`, `-1m`,
 * `-thinking`) is the selectable id, and the effort rung becomes that id's ladder.
 * `WINDSURF_API_MODEL_WIRE_UIDS` is the authoritative rung→wire-id map; resolution lives in
 * `src/adapters/windsurf-api.ts`.
 *
 * Legacy `MODEL_*` uids are folded where the `_label` field makes the mapping unambiguous
 * (`MODEL_PRIVATE_12..15` → `gpt-5.1` rungs, `MODEL_GOOGLE_GEMINI_3_0_FLASH_*` →
 * `gemini-3.0-flash` rungs); the rest stay unfolded because their separators cannot
 * distinguish base from rung.
 */
export const WINDSURF_API_MODELS = [
  "claude-5-fable",
  "claude-fable-5-1",
  "claude-opus-4-6-1m",
  "claude-opus-4-6-thinking-1m",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-4-8-fast",
  "claude-opus-4.6",
  "claude-opus-4.6-thinking",
  "claude-opus-5",
  "claude-opus-5-fast",
  "claude-sonnet-4-6",
  "claude-sonnet-4.6",
  "claude-sonnet-4.6-1m",
  "claude-sonnet-4.6-thinking-1m",
  "claude-sonnet-5",
  "gemini-3.0-flash",
  "gemini-3.1-pro",
  "glm-5.2",
  "gpt-5-3-codex-priority",
  "gpt-5-4-priority",
  "gpt-5-5-priority",
  "gpt-5-6-luna-priority",
  "gpt-5-6-sol-priority",
  "gpt-5-6-terra-priority",
  "gpt-5.2",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-6-astra",
  "gpt-6-astra-priority",
  "swe-1-6",
  "swe-1-6-fast",
  "swe-1-6-slow",
  "swe-1-7",
  "swe-1-7-lightning",
  "swe-2",
  // Legacy-convention ids folded to friendly names (labels verified on the live roster).
  "claude-haiku-4.5",
  "claude-sonnet-4.5",
  "claude-sonnet-4.5-thinking",
  "claude-opus-4.5",
  "claude-opus-4.5-thinking",
  "gpt-4.1",
  "gpt-5.1",
] as const;

export const WINDSURF_API_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-5-fable": 1000000,
  "claude-fable-5-1": 1000000,
  "claude-opus-4-6-1m": 1000000,
  "claude-opus-4-6-thinking-1m": 1000000,
  "claude-opus-4-7": 1000000,
  "claude-opus-4-8": 1000000,
  "claude-opus-4-8-fast": 1000000,
  "claude-opus-4.6": 200000,
  "claude-opus-4.6-thinking": 200000,
  "claude-opus-5": 1000000,
  "claude-opus-5-fast": 1000000,
  "claude-sonnet-4-6": 200000,
  "claude-sonnet-4.6": 200000,
  "claude-sonnet-4.6-1m": 1000000,
  "claude-sonnet-4.6-thinking-1m": 1000000,
  "claude-sonnet-5": 1000000,
  "gemini-3.0-flash": 1048576,
  "gemini-3.1-pro": 1048576,
  "glm-5.2": 200000,
  "gpt-5-3-codex-priority": 400000,
  "gpt-5-4-priority": 272000,
  "gpt-5-5-priority": 272000,
  "gpt-5-6-luna-priority": 1000000,
  "gpt-5-6-sol-priority": 1000000,
  "gpt-5-6-terra-priority": 1000000,
  "gpt-5.2": 384000,
  "gpt-5.3-codex": 400000,
  "gpt-5.4": 272000,
  "gpt-5.4-mini": 400000,
  "gpt-5.5": 272000,
  "gpt-5.6-luna": 1000000,
  "gpt-5.6-sol": 1000000,
  "gpt-5.6-terra": 1000000,
  "gpt-6-astra": 1000000,
  "gpt-6-astra-priority": 1000000,
  "swe-1-6": 200000,
  "swe-1-6-fast": 200000,
  "swe-1-6-slow": 200000,
  "swe-1-7": 262000,
  "swe-1-7-lightning": 202752,
  "swe-2": 262000,
  "claude-haiku-4.5": 200000,
  "claude-sonnet-4.5": 200000,
  "claude-sonnet-4.5-thinking": 200000,
  "claude-opus-4.5": 200000,
  "claude-opus-4.5-thinking": 200000,
  "gpt-4.1": 1047576,
  "gpt-5.1": 272000,
};

export const WINDSURF_API_MODEL_REASONING_EFFORTS: Record<string, string[]> = {
  "claude-5-fable": ["low", "medium", "high", "xhigh", "max"],
  "claude-fable-5-1": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-7": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8-fast": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-5-fast": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
  "gemini-3.0-flash": ["minimal", "low", "high"],
  "gemini-3.1-pro": ["low", "high"],
  "gpt-5-3-codex-priority": ["low", "medium", "high", "xhigh"],
  "gpt-5-4-priority": ["none", "low", "medium", "high", "xhigh"],
  "gpt-5-5-priority": ["none", "low", "medium", "high", "xhigh"],
  "gpt-5-6-luna-priority": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-5-6-sol-priority": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-5-6-terra-priority": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-5.2": ["low", "medium", "high", "xhigh"],
  "gpt-5.3-codex": ["low", "high", "xhigh"],
  "gpt-5.4": ["none", "low", "medium", "high", "xhigh"],
  "gpt-5.4-mini": ["low", "medium", "high", "xhigh"],
  "gpt-5.5": ["none", "medium", "high", "xhigh"],
  "gpt-5.6-luna": ["none", "low", "high", "xhigh"],
  "gpt-5.6-sol": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-terra": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-6-astra": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6-astra-priority": ["low", "medium", "high", "xhigh", "max"],
  "swe-1-7": ["medium"],
  "swe-1-7-lightning": ["medium"],
  "swe-2": ["medium", "high", "max"],
  "gpt-5.1": ["none", "low", "medium", "high"],
};

// A bare rung (wireUids[""]) always wins as the default; entries here are only for models
// whose family ships no bare uid, and the value is the first rung in roster order — the
// server's own ordering, matching the devin-http fold convention.
export const WINDSURF_API_MODEL_DEFAULT_REASONING_EFFORTS: Record<string, string> = {
  "claude-5-fable": "low",
  "claude-fable-5-1": "medium",
  "claude-opus-4-7": "medium",
  "claude-opus-4-8": "low",
  "claude-opus-4-8-fast": "low",
  "claude-opus-5": "low",
  "claude-opus-5-fast": "low",
  "claude-sonnet-5": "low",
  "gemini-3.1-pro": "low",
  "gpt-5-3-codex-priority": "low",
  "gpt-5-4-priority": "none",
  "gpt-5-5-priority": "none",
  "gpt-5-6-luna-priority": "none",
  "gpt-5-6-sol-priority": "none",
  "gpt-5-6-terra-priority": "none",
  "gpt-5.4": "none",
  "gpt-5.4-mini": "low",
  "gpt-5.6-sol": "medium",
  "gpt-5.6-terra": "none",
  "gpt-6-astra": "low",
  "gpt-6-astra-priority": "low",
  "swe-2": "high",
  "gpt-5.1": "none",
};

/**
 * Exact wire id per rung; key "" is the bare id. Never reconstructed: the rung order is not
 * uniform across families (`swe-1-7-lightning-medium` puts the axis before the rung).
 */
export const WINDSURF_API_MODEL_WIRE_UIDS: Record<string, Record<string, string>> = {
  "claude-5-fable": {
    low: "claude-5-fable-low", medium: "claude-5-fable-medium", high: "claude-5-fable-high",
    xhigh: "claude-5-fable-xhigh", max: "claude-5-fable-max",
  },
  "claude-fable-5-1": {
    low: "claude-fable-5-1-low", medium: "claude-fable-5-1-medium", high: "claude-fable-5-1-high",
    xhigh: "claude-fable-5-1-xhigh", max: "claude-fable-5-1-max",
  },
  "claude-opus-4-6-1m": { "": "claude-opus-4-6-1m" },
  "claude-opus-4-6-thinking-1m": { "": "claude-opus-4-6-thinking-1m" },
  "claude-opus-4-7": {
    low: "claude-opus-4-7-low", medium: "claude-opus-4-7-medium", high: "claude-opus-4-7-high",
    xhigh: "claude-opus-4-7-xhigh", max: "claude-opus-4-7-max",
  },
  "claude-opus-4-8": {
    low: "claude-opus-4-8-low", medium: "claude-opus-4-8-medium", high: "claude-opus-4-8-high",
    xhigh: "claude-opus-4-8-xhigh", max: "claude-opus-4-8-max",
  },
  "claude-opus-4-8-fast": {
    low: "claude-opus-4-8-low-fast", medium: "claude-opus-4-8-medium-fast",
    high: "claude-opus-4-8-high-fast", xhigh: "claude-opus-4-8-xhigh-fast",
    max: "claude-opus-4-8-max-fast",
  },
  "claude-opus-4.6": { "": "claude-opus-4.6" },
  "claude-opus-4.6-thinking": { "": "claude-opus-4.6-thinking" },
  "claude-opus-5": {
    low: "claude-opus-5-low", medium: "claude-opus-5-medium", high: "claude-opus-5-high",
    xhigh: "claude-opus-5-xhigh", max: "claude-opus-5-max",
  },
  "claude-opus-5-fast": {
    low: "claude-opus-5-low-fast", medium: "claude-opus-5-medium-fast",
    high: "claude-opus-5-high-fast", xhigh: "claude-opus-5-xhigh-fast",
    max: "claude-opus-5-max-fast",
  },
  "claude-sonnet-4-6": { "": "claude-sonnet-4-6" },
  "claude-sonnet-4.6": { "": "claude-sonnet-4.6" },
  "claude-sonnet-4.6-1m": { "": "claude-sonnet-4.6-1m" },
  "claude-sonnet-4.6-thinking-1m": { "": "claude-sonnet-4.6-thinking-1m" },
  "claude-sonnet-5": {
    low: "claude-sonnet-5-low", medium: "claude-sonnet-5-medium", high: "claude-sonnet-5-high",
    xhigh: "claude-sonnet-5-xhigh", max: "claude-sonnet-5-max",
  },
  "gemini-3.0-flash": {
    "": "gemini-3.0-flash",
    minimal: "MODEL_GOOGLE_GEMINI_3_0_FLASH_MINIMAL",
    low: "MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW",
    high: "MODEL_GOOGLE_GEMINI_3_0_FLASH_HIGH",
  },
  "gemini-3.1-pro": { low: "gemini-3.1-pro-low", high: "gemini-3.1-pro-high" },
  "glm-5.2": { "": "glm-5.2" },
  "gpt-5-3-codex-priority": {
    low: "gpt-5-3-codex-low-priority", medium: "gpt-5-3-codex-medium-priority",
    high: "gpt-5-3-codex-high-priority", xhigh: "gpt-5-3-codex-xhigh-priority",
  },
  "gpt-5-4-priority": {
    none: "gpt-5-4-none-priority", low: "gpt-5-4-low-priority", medium: "gpt-5-4-medium-priority",
    high: "gpt-5-4-high-priority", xhigh: "gpt-5-4-xhigh-priority",
  },
  "gpt-5-5-priority": {
    none: "gpt-5-5-none-priority", low: "gpt-5-5-low-priority", medium: "gpt-5-5-medium-priority",
    high: "gpt-5-5-high-priority", xhigh: "gpt-5-5-xhigh-priority",
  },
  "gpt-5-6-luna-priority": {
    none: "gpt-5-6-luna-none-priority", low: "gpt-5-6-luna-low-priority",
    medium: "gpt-5-6-luna-medium-priority", high: "gpt-5-6-luna-high-priority",
    xhigh: "gpt-5-6-luna-xhigh-priority", max: "gpt-5-6-luna-max-priority",
  },
  "gpt-5-6-sol-priority": {
    none: "gpt-5-6-sol-none-priority", low: "gpt-5-6-sol-low-priority",
    medium: "gpt-5-6-sol-medium-priority", high: "gpt-5-6-sol-high-priority",
    xhigh: "gpt-5-6-sol-xhigh-priority", max: "gpt-5-6-sol-max-priority",
  },
  "gpt-5-6-terra-priority": {
    none: "gpt-5-6-terra-none-priority", low: "gpt-5-6-terra-low-priority",
    medium: "gpt-5-6-terra-medium-priority", high: "gpt-5-6-terra-high-priority",
    xhigh: "gpt-5-6-terra-xhigh-priority", max: "gpt-5-6-terra-max-priority",
  },
  "gpt-5.2": {
    "": "gpt-5.2",
    low: "gpt-5.2-low", medium: "MODEL_GPT_5_2_MEDIUM", high: "gpt-5.2-high", xhigh: "gpt-5.2-xhigh",
  },
  "gpt-5.3-codex": {
    "": "gpt-5.3-codex",
    low: "gpt-5.3-codex-low", high: "gpt-5.3-codex-high", xhigh: "gpt-5.3-codex-xhigh",
  },
  "gpt-5.4": {
    none: "gpt-5.4-none", low: "gpt-5.4-low", medium: "gpt-5.4-medium",
    high: "gpt-5.4-high", xhigh: "gpt-5.4-xhigh",
  },
  "gpt-5.4-mini": {
    low: "gpt-5.4-mini-low", medium: "gpt-5.4-mini-medium",
    high: "gpt-5.4-mini-high", xhigh: "gpt-5.4-mini-xhigh",
  },
  "gpt-5.5": {
    "": "gpt-5.5",
    none: "gpt-5.5-none", medium: "gpt-5.5-medium", high: "gpt-5.5-high", xhigh: "gpt-5.5-xhigh",
  },
  "gpt-5.6-luna": {
    "": "gpt-5.6-luna",
    none: "gpt-5.6-luna-none", low: "gpt-5.6-luna-low",
    high: "gpt-5.6-luna-high", xhigh: "gpt-5.6-luna-xhigh",
  },
  "gpt-5.6-sol": {
    none: "gpt-5.6-sol-none", low: "gpt-5.6-sol-low", medium: "gpt-5.6-sol-medium",
    high: "gpt-5.6-sol-high", xhigh: "gpt-5.6-sol-xhigh", max: "gpt-5.6-sol-max",
  },
  "gpt-5.6-terra": {
    none: "gpt-5.6-terra-none", low: "gpt-5.6-terra-low", medium: "gpt-5.6-terra-medium",
    high: "gpt-5.6-terra-high", xhigh: "gpt-5.6-terra-xhigh", max: "gpt-5.6-terra-max",
  },
  "gpt-6-astra": {
    low: "gpt-6-astra-low", medium: "gpt-6-astra-medium", high: "gpt-6-astra-high",
    xhigh: "gpt-6-astra-xhigh", max: "gpt-6-astra-max",
  },
  "gpt-6-astra-priority": {
    low: "gpt-6-astra-low-priority", medium: "gpt-6-astra-medium-priority",
    high: "gpt-6-astra-high-priority", xhigh: "gpt-6-astra-xhigh-priority",
    max: "gpt-6-astra-max-priority",
  },
  "swe-1-6": { "": "swe-1-6" },
  "swe-1-6-fast": { "": "swe-1-6-fast" },
  "swe-1-6-slow": { "": "swe-1-6-slow" },
  "swe-1-7": { "": "swe-1-7", medium: "swe-1-7-medium" },
  "swe-1-7-lightning": { "": "swe-1-7-lightning", medium: "swe-1-7-lightning-medium" },
  "swe-2": { medium: "swe-2-medium", high: "swe-2-high", max: "swe-2-max" },
  "claude-haiku-4.5": { "": "MODEL_PRIVATE_11" },
  "claude-sonnet-4.5": { "": "MODEL_PRIVATE_2" },
  "claude-sonnet-4.5-thinking": { "": "MODEL_PRIVATE_3" },
  "claude-opus-4.5": { "": "MODEL_CLAUDE_4_5_OPUS" },
  "claude-opus-4.5-thinking": { "": "MODEL_CLAUDE_4_5_OPUS_THINKING" },
  "gpt-4.1": { "": "MODEL_CHAT_GPT_4_1_2025_04_14" },
  "gpt-5.1": {
    none: "MODEL_PRIVATE_12", low: "MODEL_PRIVATE_13",
    medium: "MODEL_PRIVATE_14", high: "MODEL_PRIVATE_15",
  },
};

/** Picker labels for ids whose wire name does not read as a model name. */
export const WINDSURF_API_MODEL_DISPLAY_NAMES: Record<string, string> = {
  "claude-haiku-4.5": "Claude Haiku 4.5",
  "claude-sonnet-4.5": "Claude Sonnet 4.5",
  "claude-sonnet-4.5-thinking": "Claude Sonnet 4.5 Thinking",
  "claude-opus-4.5": "Claude Opus 4.5",
  "claude-opus-4.5-thinking": "Claude Opus 4.5 Thinking",
  "gpt-4.1": "GPT-4.1",
  "gpt-5.1": "GPT-5.1",
};

/** Every roster entry advertises `supports_images: true`. */
export const WINDSURF_API_MODEL_INPUT_MODALITIES: Record<string, string[]> =
  Object.fromEntries(WINDSURF_API_MODELS.map(id => [id, ["text", "image"]]));
