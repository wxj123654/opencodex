---
title: Devin Cascade HTTP provider
unit: 260912_devin_cascade_http
class: C2 (implementation that reverses a previously-recorded feasibility verdict)
date: 2026-09-12
status: plan
---

# 000 — Plan

## Context

Two Devin entries already existed:

- `devin` (260911_devin_acp_bridge) bridges the vendor CLI over ACP. It is a
  text/reasoning channel, not a model contract: the CLI's agent keeps its own
  tools and ignores the tools Codex declares. Its value is containment — no
  `fs`/`terminal` capabilities, every `session/request_permission` declined,
  sessions locked to the read-only `ask` mode.
- `devin-api` fronts `api.cognition.ai/v1`, the per-token OpenAI-compatible
  endpoint, which needs a Teams/Enterprise service-user key.

The ACP bridge's roster is Cognition's own SWE line (`swe-2`, `swe-1-7`,
`swe-1-7-lightning`, `swe-1-6`) because that is what `devin acp` advertises.

## Correcting a wrong feasibility verdict

`260911_devin_acp_bridge/010_done.md` recorded, under "Account quota":

> The CLI does NOT make that RPC replayable from outside: its Authorization
> header is an encrypted transform of the stored key and the request body
> carries a server-validated per-call nonce, so opencodex does not probe on its
> own.

**That observation was correct and the inference drawn from it was not.** What
was measured is the shape of the request the CLI *sends*. What was never tested
is what the server *requires*. Measured 2026-09-12:

```
POST https://server.codeium.com/exa.auth_pb.AuthService/GetUserJwt
content-type: application/proto
connect-protocol-version: 1
<body: 92-byte hand-encoded protobuf Metadata in field 1>

-> HTTP 200, 1824 bytes, field 1 = a 1821-char user JWT
```

No signature, no nonce, no credential transform, no client fingerprint beyond
the `Metadata` identity fields the encoder always sends. The session token from
`~/.local/share/devin/credentials.toml` (`windsurf_api_key`, 189 chars,
`devin-session-token$` prefix) is accepted verbatim. The same envelope then
carries `GetChatMessage` (streaming chat), `GetCliModelConfigs` (the roster),
and `GetUserStatus` (quota). A live `GetUserStatus` response decoded to the
identical plan window the CLI cache reports (100%/100% daily/weekly, matching
reset timestamps), which is what makes the quota reader trustworthy.

The lesson worth carrying forward: "the official client does X" and "the server
requires X" are different claims, and only the second one gates a design.

## What this unit adds

A third entry, `devin-http`, that speaks the Cascade Connect API directly. It is
a **real model contract** — verified live that a client-declared tool reaches
the model and its `tool_calls` come back for Codex to execute, with
`finish_reason: tool_calls` and correct arguments.

The three entries are intentionally coexisting, not a migration:

| | `devin` (ACP) | `devin-http` | `devin-api` |
|---|---|---|---|
| transport | `devin acp` child process | connectrpc/HTTP | OpenAI-compatible HTTP |
| credential | CLI login (opaque to us) | CLI login or explicit key | `cog_` service-user key |
| models | 4 (SWE family) | 74 selectable, folded from 209 | 3 |
| tools | ignored (agent owns them) | full model contract | full model contract |
| containment | fail-closed read-only | none (no local agent to contain) | none |
| per-turn cost | process spawn + handshake | one RPC | one request |

The trade is capability for containment, and it is a real trade in both
directions: a user who wants "Devin can never touch my workspace" should use
`devin`; a user who wants the account's whole model roster with tool support
should use `devin-http`.

## Design decisions

### Reuse the reference implementation, attribute it

`github.com/CaiJingLong/devin-gateway` (MIT) reached the same protocol shapes
independently. Its encoder/decoder scaffolding was adapted with attribution in
the module header and `CREDITS.md`; the roster parser, the response decoders,
and the adapter are ours. The alternative — writing the codec from scratch to
avoid the attribution — would have produced a near-identical file with no
review benefit.

### Fold the roster; store the wire uid, never reconstruct it

209 roster entries are 74 selectable models: effort is a suffix on the uid
(`claude-opus-5-high`), and `-fast`/`-priority`/`-lightning`/`-1m`/`-thinking`
are orthogonal axes that name a *different serving tier or build*, not a
reasoning rung.

Folding by string surgery would be wrong. `swe-1-7-lightning-medium` is the
`medium` rung of `swe-1-7-lightning`, and a naive `base-effort-axes` join
produces `swe-1-7-medium-lightning`, which is not a roster uid. So every rung
stores the exact uid the server advertised, and resolution is a map lookup.
Ladder order follows roster order because the server's ordering is the only
authority on which rung is the default.

### Resolve bare ids through the seed

`claude-opus-5` and `swe-2` are not callable — the server answers
`permission_denied`, because those families ship no bare uid. An absent effort
must therefore resolve to the seed's default rung, not to the bare base id.

### Leave the wiring unchanged

`260911` states its safety boundary in prose and enforces it in code
(`devin/turn.ts`). This unit adds a second provider and touches none of it: the
ACP bridge's capabilities, refusals, and mode lock are untouched, and the new
entry carries its own honesty note in the registry.

## Live measurements

All from the Free plan on 2026-09-12, devin 3000.10.21.

- Roster: 209 uids → 74 selectable (55 hyphen-form bases + 19 legacy
  `MODEL_*`). 67 of 74 accept images.
- `swe-1-7-lightning` returns `"pong"` in ~1.2 s.
- **Tool calls arrive in two shapes**, chosen by the model:

  ```
  swe-1-7-lightning (complete):
    frame: id="functions.get_weather:0" name="get_weather" args="{\"city\": \"Tokyo\"}"

  swe-2-high (fragmented):
    frame A: id="get_weather_0" name="get_weather" args=""      <- opens the call
    frame B: id=""             name=""             args="{"     <- appends
    frame C: id=""             name=""             args="\"city\": \""
    ...  frames with an EMPTY id/name are argument fragments
  ```

  Handling only the complete shape emits N empty-named bogus calls for every
  fragmented turn. This was found by running the adapter against the live
  service after the unit tests passed — the unit tests had been written from the
  first observation and encoded the same wrong assumption.

- **Usage frames are mostly zeroed.** Nearly every frame carries a usage message
  and all but the last are `0`; the reader takes the last NON-ZERO frame.
- **8 of 74 models are Local-only.** Sweeping every exposed model: 66 callable,
  8 answer `permission_denied: This model is only in Devin Local` — every rung of
  `gpt-5-6-sol`, `gpt-5-6-luna`, `gpt-5-6-terra`, `gpt-6-astra`, and their
  `-priority` tiers. The CLI calls them fine, which is the giveaway: it is a
  local process with the Cascade local runtime, and a cloud HTTP call has no path
  to a locally-served model.

  **The roster carries no discriminator.** Verified field by field: every scalar
  and nested field on the blocked entries also appears on callable models. The
  `f10 == 2` serving-pool marker looked like one until `gpt-5-4`/`gpt-5-5`
  turned out to share it while remaining callable. They are therefore NOT
  filtered — the property can differ per plan and CLI version, and silently
  dropping models a paid account could call is worse than passing through the
  server's own explicit message.

## Bugs found and fixed

1. **`ProtoDecoder.skip()` dropped bytes on length-delimited fields.**
   `this.pos += Number(this.readVarint())` reads `this.pos` before the
   right-hand side runs, so the advance `readVarint` makes on `this.pos` is
   discarded — the cursor lands short by the length varint's own width. A
   1-byte length misparses by one byte, which is enough to decode a bogus tag
   (`Unknown protobuf wire type: 6`). Inherited from the vendored reference
   implementation. Regression test: `devin-http-proto.test.ts` ("skipping a
   length-delimited field advances by the LENGTH varint plus the payload").

2. **Fragmented tool calls** (above). Found by live verification, not by tests.

3. **`resolveWireUid` discarded the default-effort map,** so `swe-2` sent the
   bare uid the server rejects. Found by a unit test.

4. **The catalog gather never consulted the CLI credential** (found 2026-09-13
   from a report that every `devin-http` switch was disabled with "initial
   discovery pending"). The chat path resolves this provider's zero-configuration
   credential through `resolveDevinToken` — `provider.apiKey`, then the CLI's
   `credentials.toml`. The catalog's shared `resolveModelsAuthToken` knows only
   `provider.apiKey` and the OAuth stores, and the devin-http branch bailed out on
   a missing `apiKey` before calling discovery at all. So an unconfigured
   provider (the documented setup: `keyOptional: true`, no pasted key) degraded
   on every gather, even with a working login on disk.

   The user-visible failure was not the model list, which still rendered from the
   static seed. A degraded outcome is never authoritative, and
   `reconcileInitialModelSelections` decides only for authoritative providers —
   so `initialModelSelection` stayed `pending` forever. `listManagementModelRows`
   turns a pending registration into `disabled: true` on every row plus
   `initialSelectionPending: true`, and the visibility API answers 409
   (`initial_model_selection_pending`) to any switch, with "Refresh the model list
   and retry" — which could never help, because the degradation was permanent.

   The ACP entry this one replaced did not have the bug: its branch called the
   CLI-backed discovery without inspecting `apiKey`. The `if (!apiKey)` guard
   arrived with the HTTP rewrite.

   Fix: fall back to `readDevinTokenFromDisk()` in the devin-http branch only, so
   both paths resolve the credential from the same places. Regression test:
   `devin-http-catalog-credential.test.ts` (red before the fix: the discovery
   stub received `undefined` instead of the stored credential).

## Residuals

- The wire is private and undocumented. Endpoints and field numbers were read
  off the live service; a server-side change breaks this adapter with a decode
  error or an `invalid_argument`, not a version message.
- `-priority`/`-fast` tiers are exposed as separate models because they are
  separate uids, but whether they bill differently on every plan is unverified.
- Remote-URL images are dropped rather than fetched. Only inline data URLs carry
  bytes, and an adapter must not make an implicit outbound fetch.
- No `cascadeId` reuse across turns: every turn is stateless, so the server's
  prompt cache is only warm within a turn's own frames. Reusing the id would add
  a second continuation axis alongside Responses `previous_response_id`, and the
  two could disagree about what history the model saw.
- The ACP entry's `session/new` carries no model roster on devin 3000.10.21, so
  `session/set_model` is skipped when the field is absent (recorded in
  `260911/010_done.md`). Unrelated to this unit; noted because the two units
  share a vendor.

## Tests

- `tests/providers/devin-http-proto.test.ts` — 30: codec round-trips pinned to
  observed field numbers, the `skip()` regression, both Connect frame shapes,
  roster decode.
- `tests/providers/devin-http-roster.test.ts` — 25: uid decomposition for every
  axis/effort arrangement, ladder assembly, wire-uid resolution, and seed
  consistency invariants (every wire uid decomposes back to the id it is filed
  under).
- `tests/providers/devin-http-adapter.test.ts` — 58: credential precedence,
  request projection, completion configuration, both tool-call delivery shapes,
  usage selection, terminal discipline, abort, and the adapter surface.
  The two credential cases that assert on "nothing on disk" isolate HOME/APPDATA
  first: `resolveDevinToken` reads the CLI's real `credentials.toml` as its
  zero-configuration fallback, so an unisolated assertion passes or fails
  depending on whether the machine running it has run `devin auth login`.
- `tests/providers/devin-http-catalog-credential.test.ts` — 3: the catalog
  gather resolves the same CLI credential the chat path does. Registered
  without `provider.apiKey`, the catalog used to degrade on every gather
  because the shared `resolveModelsAuthToken` knows only `provider.apiKey` and
  the OAuth stores. A degraded gather is never authoritative, and
  `reconcileInitialModelSelections` decides only for authoritative providers —
  so `initialModelSelection` stayed `pending` forever and `listManagementModelRows`
  disabled every switch for the provider with no way out. Pins the credential
  source, the explicit-key precedence, and the still-degraded no-credential path.
- Registry-wide conformance: the adapter participates in
  `tests/adapters/adapter-tool-conformance.test.ts` through a new wire driver,
  so its tool catalog, `tool_choice: none` behavior, and continuation replay are
  held to the same standard as every other routed adapter.
