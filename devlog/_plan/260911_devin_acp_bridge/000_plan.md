---
title: Devin ACP bridge provider
unit: 260911_devin_acp_bridge
class: C2 (implementation with a written safety boundary)
date: 2026-09-11
status: plan
---

# 000 — Plan

## Context

`devin` first landed as a key-auth `openai-chat` entry fronting
`api.cognition.ai/v1` (402d5222e). That endpoint is provisioned per customer
(LiteLLM: "Cognition provisions API endpoints per customer today"), so a
self-serve user cannot obtain a `cog_` service-user key without a Teams
($80/mo) or Enterprise plan. The autonomous session API at `api.devin.ai` is an
ACU-billed cloud agent with no chat-completions shape.

The self-serve path is the Devin CLI (`curl -fsSL https://cli.devin.ai/install.sh
| bash`): `devin auth login` works on the **Free** plan, credentials persist in
`credentials.toml` and never expire by default, and `devin acp` exposes the CLI
as a standard Agent Client Protocol (ACP) agent over stdio NDJSON JSON-RPC.
`devin models list --format json` is the entitlement-aware model roster.

## Relationship to 260910_cursor_acp_bridge

That unit rejected a Cursor ACP provider. The rejection rested on three legs;
only two survive here, and the third is why Devin is different:

1. **"ProviderAdapter is a model port; ACP delivers an agent."** True and
   accepted here too — the devin entry is a *text/reasoning channel through a
   vendor agent*, the same honest compromise as `coding-agent/` (qoder,
   codebuddy), whose CLIs are likewise the only self-serve transport to those
   vendors' models. The difference is that Cursor had an existing HTTP model
   route, so ACP was a lateral product swap; **Devin has none**. For a
   self-serve user the vendor agent is the only door to the model.
2. **"ACP mediation points are discretionary"** (070_live_trace: Cursor edited
   a file with zero permission requests). True of the protocol and cannot be
   fixed from our side. Mitigations implemented below are fail-closed but
   admittedly behavioral, not structural: no `fs`/`terminal` client
   capabilities at `initialize`, `session/request_permission` always answered
   `{outcome: "cancelled"}`, `fs/*` and `terminal/*` agent-to-client requests
   answered with JSON-RPC errors. The residual risk — the agent acting locally
   below the mediation layer — is documented in the registry note rather than
   pretended away.
3. **"Unmeasured demand."** Reversed: the demand is this unit's origin.

## Design decisions

- **Stateless single-turn.** Each HTTP turn spawns one `devin acp` process:
  `initialize` (protocolVersion 1, clientCapabilities without fs/terminal) →
  `session/new` (cwd = os.tmpdir(), `mcpServers: []`) → `session/set_model`
  when the agent advertises models → `session/prompt` with the projected
  conversation as one text block → stream `session/update` → map `stopReason`
  → reap. No session continuity across turns; opencodex replays history
  (Strategy C projection, `coding-agent/protocol.ts`), Codex keeps tool and
  session ownership.
- **Model selection is agent-advertised only.** `session/set_model` is sent
  solely when `session/new` returns `models`; the routed model id must match an
  advertised `modelId`, otherwise the turn fails closed instead of sending an
  invented id.
- **Model discovery** reuses the qoder pattern: a dedicated
  `devin models list --format json` child process with bounded output and a
  tolerant parser; failure degrades to the static seed.
- **Credential is optional.** `apiKey` (DEVIN_API_KEY / WINDSURF_API_KEY
  compatible) is layered when present; absence relies on the local
  `devin auth login` cache. This is why the registry entry carries
  `keyOptional: true`, unlike qoder/codebuddy.
- **No ACP `authenticate` flow in v1.** An unauthenticated agent process exits
  early; its stderr becomes an explicit "run devin auth login" error.
- **Usage is estimated.** ACP reports no token counts.

## Out of scope (v1)

- `--sandbox` enforcement (OS seatbelt/bwrap availability varies; a config opt-in
  is a fast-follow if measured demand exists).
- Image content blocks over ACP prompt (text-only v1).
- Session continuity / `session/load` (stateless v1).
