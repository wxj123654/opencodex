---
title: Cycle summary
unit: 260911_devin_acp_bridge
date: 2026-09-11
status: closed
---

# 010 — Done

Written for someone who was not in the loop.

## The question and the answer

**Can self-serve users get Devin's models into OpenCodex at all?**

Yes — through the Devin CLI. The per-token `api.cognition.ai/v1` catalog landed first (402d5222e)
but its `cog_` service-user keys require Teams ($80/mo) or Enterprise, so a self-serve user could
not actually use it. This unit bridges `devin acp` — the Devin CLI's Agent Client Protocol
(JSON-RPC over stdio NDJSON) agent — as the `devin` provider, and renames the per-token catalog to
`devin-api` for Teams/Enterprise holders.

## What shipped

- `src/adapters/devin/acp.ts` — pure ACP wire surface: request builders, `session/update` →
  AdapterEvent mapping, stopReason mapping, conversation projection.
- `src/adapters/devin/transport.ts` — bidirectional NDJSON JSON-RPC connection over one child
  process, with prompt-in-flight agent-to-client requests answered fail-closed.
- `src/adapters/devin/turn.ts` — stateless single-turn orchestration (initialize → session/new →
  set_model → prompt → stream → reap) and the shared `coding-agent` profile reuse.
- `src/adapters/devin/models.ts` — `devin models list --format json` roster discovery with a
  tolerant parser (bare array / `{models}` / `{data}`, `id` or `modelId`).
- Registry: `devin` (ACP CLI, `keyOptional`), `devin-api` (per-token catalog).

## Decisions that matter beyond this unit

1. **ACP is acceptable where the vendor CLI is the only door.** 260910_cursor_acp_bridge rejected
   a Cursor ACP provider partly because Cursor-the-model already had an HTTP route. Devin has no
   self-serve HTTP route, so the agent-as-model compromise is the same one `coding-agent/`
   (qoder, codebuddy) already makes. The "model port vs agent port" objection is answered by
   honesty in the registry note and docs, not by pretending the bridge is a model.
2. **Fail-closed refusals are behavioral, not structural.** Permission requests are answered
   `cancelled`, fs/terminal callbacks get method-not-supported, and the client advertises no
   fs/terminal capabilities. Per the 260910 070 live-trace precedent, mediation points below that
   layer remain the agent's choice; the docs say so explicitly instead of claiming containment.
3. **Model selection is agent-advertised only.** `session/set_model` is sent solely when
   `session/new` returns `models`; an unadvertised routed id fails closed
   (`model_not_advertised`, HTTP 400) rather than being invented onto the wire.

## Verification

- 19 protocol/orchestration tests in `tests/providers/devin-adapter.test.ts` (scripted fake
  agent over the real transport), 5 provider-split tests in `devin-provider.test.ts`.
- `bun run typecheck` clean; parity and layout suites green with `devin-api`/`devin` registered.

## Residuals

1. Devin ACP's actual handshake has not been observed live (no CLI login on this host); the fake
   is built from the ACP v1 spec + official SDK shapes + `docs.devin.ai/cli/reference/commands`.
2. `--sandbox` enforcement is not wired; a config opt-in is a fast-follow if demanded.
3. Image content blocks are text-only in v1 prompts.
4. Session continuity (`session/load`) is deliberately out; each HTTP turn is one fresh agent
   process with replayed history.
