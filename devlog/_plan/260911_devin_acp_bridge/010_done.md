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

## Post-landing live verification (2026-09-11, same day)

Installed `devin-cli` 3000.10.21 via Homebrew, logged in with a Free-plan
account, and re-ran every residual against the real agent:

1. **CLOSED.** Handshake observed live: `protocolVersion: 1`, agent
   "Devin Agent (affogato)", `promptCapabilities.image: true`,
   `authMethods: [devin-browser]`. Real `session/new` returns `modes`
   (accept-edits DEFAULT write-capable / ask / plan / bypass) and no `models`
   roster on the session response.
2. **CLOSED with a safety hardening.** Because the vendor default mode is
   write-capable, the bridge now hard-locks `session/set_mode` to `ask` before
   every prompt and fails closed (`read_only_mode_unavailable`, 502) when the
   agent does not offer it (commit d92857c70).
3. **CLOSED.** Real `models list --format json` shape is
   `{families: [{slug, variants: [{model_uid, max_context_tokens}]}]}` — the
   tolerant parser was extended to flatten it (model_uid is globally unique;
   family slug is not prepended). Ids are HYPHENATED (`swe-1-7`, not
   `swe-1.7`); the registry seed was corrected to the live spellings and
   SWE-2 (swe-2-medium/high/max, 262000 context) is the new default family.
4. **CLOSED.** Full end-to-end through the real proxy: `POST
   /v1/chat/completions` with `devin/swe-2-medium` streamed a real SWE-2
   answer ("I'm powered by SWE-2 High.") over SSE; `/api/models` shows the
   live account roster (256-model cap truncates only part of the long
   `fusion-*` combinatorial tail; every core family id survives).

New residuals: the model self-identified as "SWE-2 High" when routed to
`swe-2-medium` (unverified whether the server remaps variants for Free plans
or the model misreports); ACP `session/new` carries no `models` roster on
this version, so per-turn `session/set_model` is currently skipped when the
field is absent and the roster only feeds discovery — acceptable, but worth
re-checking on CLI upgrades.

## Account quota (2026-09-12)

The dashboard quota row now reads the Devin CLI's own cache. Discovery path:
`devin` exposes no account-balance subcommand; the seat-management
`GetUserStatus` RPC (`server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus`)
carries `plan_status.daily/weekly_quota_remaining_percent` plus reset
timestamps (confirmed by decoding the live response, captured by pointing
`api_server_url` at a local passthrough).

**CORRECTED 2026-09-12.** This section previously concluded, from the shape of
the request the CLI sends, that the RPC "is not replayable from outside: its
Authorization header is an encrypted transform of the stored key and the
request body carries a server-validated per-call nonce". The observation was
right; the inference was not. The server accepts a plain `application/proto`
request carrying the raw session token in a protobuf `Metadata` envelope — no
signature, no nonce, no credential transform. Measured: `GetUserJwt` returns
HTTP 200 with a 1821-char JWT, `GetChatMessage` streams a working completion,
`GetCliModelConfigs` returns the 209-entry roster, and `GetUserStatus` decodes
to the same plan window this cache reports. See
`_plan/260912_devin_cascade_http/000_plan.md` for the full protocol and the
`devin-http` provider that now uses it.

The cache reader stays here because the ACP bridge deliberately never handles
the credential itself (the child CLI owns the login), so reading the cache keeps
that provider's credential boundary intact — not because the RPC is unavailable.

Instead `devin-usage.ts` reads the CLI-maintained cache
(`~/.cache/devin/cli/user_status.<digest>.bin` = JSON envelope, base64
GetUserStatusResponse), inverts remaining-percent into the dashboard's
used-percent convention, and reports `fetched_at_secs` as updatedAt. Any
authenticated `devin` command refreshes the cache; an absent or corrupt one
resolves to no row, never a fabricated number.
