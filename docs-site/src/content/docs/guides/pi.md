---
title: Pi
description: Use any routed model from Pi — ocx export writes a custom provider block for Pi's models.json, wired to the running proxy.
---

Pi reads its providers from a single global JSON file rather than environment variables, so
opencodex does not launch it. Instead, `ocx export` serializes the `opencodex` provider block —
base URL, model list, and the env reference Pi interpolates — and you merge it into your own
config.

## Quickstart

Start the proxy, then print the config:

```bash
ocx start
ocx export --client pi
```

The output leads with the JSON, then prints the destination path, the merge warning, the env
export line, and how many models carry authoritative context limits.

```json
{
  "providers": {
    "opencodex": {
      "baseUrl": "http://127.0.0.1:10100/v1",
      "api": "openai-completions",
      "apiKey": "$OPENCODEX_API_KEY",
      "compat": { "supportsDeveloperRole": false },
      "models": [
        {
          "id": "anthropic/claude-opus-5",
          "name": "Claude Opus 5 (anthropic)",
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 200000,
          "maxTokens": 32000
        }
      ]
    }
  }
}
```

The provider-level `compat.supportsDeveloperRole: false` matters once a model carries
`reasoning: true`: pi then defaults to OpenAI's `developer` role, and upstream acceptance of
that role is uneven behind the proxy — z.ai's glm-5.3-flash answers it with
`400 Incorrect role information` while glm-5.3 accepts it. Pinning the portable `system`
role costs nothing on the endpoints that do accept `developer` and unbreaks the ones that
don't.

Model ids are the proxy's canonical selectors, so routed models appear as `provider/model`
(`anthropic/claude-opus-5`) and native OpenAI slugs stay unprefixed (`gpt-5.6-sol`). The `name`
suffix — `(anthropic)`, `(native)`, `(routed)` — is what makes two same-named models from
different upstreams distinguishable in Pi's picker.

## Where it goes

Pi's global model config is:

```text
~/.pi/agent/models.json
```

:::caution[Merge, never replace]
`ocx export` never writes that file. Merge the `providers.opencodex` block into it — replacing the
file destroys every other provider you have configured there. `--out` exists for a scratch path
and refuses to overwrite an existing file without `--force`:

```bash
ocx export --client pi --out ~/opencodex-pi-models.json
ocx export --client pi --json > ~/opencodex-pi-models.json   # or redirect the byte-exact JSON
```
:::

The exported block is a static snapshot, not a live view. Re-run `ocx export` after adding a
provider or changing model visibility, and merge the new block over the old one.

## The admission key

Two different keys are easy to confuse here, and only the first one appears in this file:

| Key | What it is | Where it lives |
| --- | --- | --- |
| Proxy admission key | opencodex's own credential, generated on the dashboard's **API** tab | referenced by `apiKey` as `$OPENCODEX_API_KEY`; the value stays in your environment |
| Provider key | your Anthropic / OpenAI / OpenRouter key | opencodex's own config, per [Providers](/guides/providers/) |

The exported config carries only the reference, never a secret. Pi interpolates a bare `$NAME`, so
the variable is:

```bash
export OPENCODEX_API_KEY=<your key>
```

That name is Pi's alone. opencode uses a different variable
(`OPENCODEX_OPENCODE_API_KEY`, in `{env:…}` form) — see the [opencode guide](/guides/opencode/).

**A loopback proxy needs no key at all.** opencodex binds `127.0.0.1` by default and authenticates
nothing there, so the `$OPENCODEX_API_KEY` reference is inert and you can leave the variable unset.
It matters only when `hostname` is set beyond loopback, which is also the case where the proxy
refuses to start without a token — see [Remote access](/reference/configuration/#remote-access).

## Model metadata

`contextWindow` and `maxTokens` are emitted only when the catalog reports an authoritative context
window. When it does not, both fields are omitted for that model and Pi applies its own defaults;
`ocx export` prints how many rows fell into that case.

`maxTokens` is a schema-satisfying budget of `32000`, clamped down to the context window so a
small-context model is never given more output than context. It is not a claim about any specific
model's true maximum.

Every row carries an explicit zero `cost`. opencodex has no price data for routed models, and
omitting the field is worse than emitting zeros: pi fills in a default cost only for models it
loads from models.json itself, while extensions that re-register providers — notably
pi-setup-custom-providers, which re-registers every provider in the file — pass the rows through
pi's extension path with no default. The first successful stream then crashes calculating usage
cost with `Cannot read properties of undefined (reading 'tiers')`. For a local proxy, zero is
also the truthful number: the proxy meters upstream, not pi.

`reasoning` is the other field with a history: it used to be absent because Pi stores a boolean
while the catalog carries an effort ladder, and mapping one onto the other used to be a guess. Since the
catalog's ladder is the proxy's own statement about whether a model accepts reasoning parameters
(adapters honor `reasoning_effort`), an export row with a **non-empty** ladder now emits
`"reasoning": true`, and a row without one (or with an explicitly empty ladder) stays
reasoning-free. Pi then offers its effort control for exactly the models opencodex will accept it
on. The export also emits a `thinkingLevelMap` that hides every pi level with no declared target
(`null`), so pi never offers — and never sends — an effort the ladder does not contain. One
fallback keeps the model usable: when `ultra` is declared without `max`, pi's `max` level maps
to `ultra` (still a ladder member).
If you need a different mapping, hand-edit `thinkingLevelMap` afterward as documented by Pi.

Treat `reasoning` as Pi-UI metadata: it is derived from the catalog ladder, not proof that the
upstream natively supports a reasoning parameter. What the proxy actually sends for a given
`reasoning_effort` value depends on the provider's adapter and model — it may pass the value
through, translate it (wire aliases), clamp it to the configured ladder, emulate it, or omit it
entirely (e.g. `noReasoningModels`). The boolean only controls whether Pi offers the control at
all.

## Schema status

:::note[Verified against a real install]
This shape has been exercised against a real `~/.pi/agent/models.json` on pi 0.84.3 (2026-08),
including the interaction that shaped the zero `cost` above: pi-setup-custom-providers
re-registers every provider in the file, pi applies no default cost on that path, and rows
without a `cost` crashed pi's usage accounting on the first successful stream. `reasoning`,
`thinkingLevelMap`, and the level-hiding `null` entries all behaved as documented on that
install. If a newer pi or extension changes this, please
[open an issue](https://github.com/lidge-jun/opencodex/issues) with what pi reported.
:::

## Requirements

A running opencodex proxy (`ocx start`) and Pi installed. `ocx export` reads the live catalog
through the proxy's management API, so a config can never be emitted with an empty model list.
