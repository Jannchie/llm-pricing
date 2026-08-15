# llm-pricing

Turn a stored model name and a pile of token counts into a USD number you can defend.

```ts
import { ensurePricingLoaded, estimateCostUsd } from 'llm-pricing'

await ensurePricingLoaded() // fetch the live catalogue once per 24h

estimateCostUsd({
  model: 'claude-opus-4-7-20260115', // whatever your logs actually stored
  inputTokens: 120_000,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 8000,
  cacheReadInputTokens: 96_000,
  outputTokens: 4500,
})
// { cost: 0.2905, pricing: { displayName: 'Claude Opus 4.7', source: 'modelsdev', ... }, basis: 'flat' }
```

## Why this exists

Multiplying tokens by a price is easy. Everything around it is not:

- **The model name in your database is not the name in any price list.** Agent CLIs store `claude-opus-4-7`, `claude-haiku-4-5-20251001`, `gpt-5.5(xhigh)`, `deepseek-deepseek-v4-pro`. Catalogues use `anthropic/claude-opus-4.7`. This package normalizes across dashes vs dots, release tags, reasoning-effort parentheticals, and dash-joined vendor prefixes — probing exact keys only, so a bad guess misses instead of mispricing.
- **Cache tokens are most of the bill and are priced four different ways.** Fresh input, cache creation (5m vs 1h TTL, the latter at 2× input), and cache read all differ by up to 100×. Providers that only report `cached_input_tokens` need their cache reads derived, or ~90% of Codex input gets billed at the full prompt rate.
- **A price is a schedule, not a number.** Vendors change rates, and history must not be re-priced. DeepSeek additionally bills peak and off-peak by UTC hour. Both dimensions are modelled; models with one flat rate — nearly all of them — short-circuit and pay nothing for the machinery.
- **Catalogues quote resellers.** The same model id is listed by 15–25 providers at their own margin, some at a placeholder $0. Getting first-party rates requires deliberate provider priority.

## Data sources

Price data is **not** hand-maintained. Live catalogues are fetched at runtime, and a generated snapshot covers the offline case:

| Layer | Source | Refresh |
| --- | --- | --- |
| Overrides | hand-written, in-repo | only what no upstream publishes |
| Live catalogue | [models.dev](https://models.dev/api.json) (default), optionally [OpenRouter](https://openrouter.ai/api/v1/models) | every 24h at runtime |
| Snapshot | generated from models.dev by `pnpm sync` | committed; refresh when you feel like it |

```ts
import { modelsDevSource, openRouterSource, PricingCatalog } from 'llm-pricing'

// models.dev first, OpenRouter filling anything it does not list.
const catalog = new PricingCatalog({ sources: [modelsDevSource(), openRouterSource()] })

// Fully offline: bundled snapshot + overrides only, no network at all.
const offline = new PricingCatalog({ sources: [] })
```

Resolution order is always **overrides → sources in order → snapshot**. A source that fails to load never takes the catalogue down; the previous load keeps serving and `state().status` degrades to `stale`.

### What stays hand-maintained, and why

Two things, both because no upstream publishes them at all:

1. **Peak / off-peak schedules.** DeepSeek's first-party API bills two rates depending on the UTC hour. models.dev, OpenRouter, LiteLLM and ccusage all publish exactly one number per model, with no time-window field anywhere. If you price a Chinese working day at the off-peak rate you understate it 2×.
2. **Fast / priority tier multipliers.** No catalogue lists `gpt-5.x-fast` at all, and Anthropic's fast variants disappear from catalogues when they retire upstream.

Both tables are append-only. Stored model strings are immortal: deleting a row because upstream retired the model makes its historical rows silently cost $0.

## Time-aware pricing

Pass `at` when you know the instant the tokens were spent, `window` when the row is a sum over a range:

```ts
catalog.estimate({ model: 'deepseek-v4-pro', at: '2026-09-01T02:00:00Z', ...tokens }) // basis: 'exact'
catalog.estimate({ model: 'deepseek-v4-pro', window: [since, until], ...tokens }) // basis: 'blended'
```

`blended` weights each rate by how much wall-clock time the window spends under it — wrong for someone who only ever works during peak hours, but bounded by `[off-peak, peak]` and honest about the fact that the time axis was aggregated away before pricing.

For SQL callers, group rows by the UTC hour so they price exactly. `PRICE_ANCHOR_COLUMN` names the column and `catalog.timeSensitiveSqlPatterns` gives the LIKE patterns worth splitting — derived from the schedules themselves, so a vendor that gains a peak schedule updates the query automatically:

```sql
case when lower(coalesce(model, '')) like '%deepseek%'
     then (floor(extract(epoch from ts) / 3600) * 3600)::bigint
end as price_hour_epoch
```

Every model with a flat price anchors to `NULL`, so those rows collapse back into one group and the query returns exactly as many rows as it did before. Use `extract(epoch from ...)` rather than `date_trunc`, whose result depends on the session TimeZone — the wrong frame for a billing window.

Then price rows straight off the driver output:

```ts
import { estimateCostFromRow } from 'llm-pricing'

for (const row of rows) {
  const { cost, basis } = estimateCostFromRow(row, [since, until])
}
```

## API

| Export | Purpose |
| --- | --- |
| `PricingCatalog` | Instance holding one catalogue + its caches |
| `defaultCatalog` | Process-wide instance for servers that want one shared cache |
| `ensurePricingLoaded()` / `pricingState()` | Load / inspect the default catalogue |
| `getPriceFor(model, at?)` | Resolve a model to a flat rate card |
| `estimateCostUsd(args)` | Token counts → `{ cost, pricing, basis }` |
| `estimateCostFromRow(row, window?)` | Same, from a snake_case SQL row |
| `costFromRates(rates, tokens)` | Pure arithmetic, no catalogue involved |
| `pricingCandidates(model)` | The normalization, exposed for reuse |
| `modelsDevSource()` / `openRouterSource()` | Source adapters |
| `PRICE_ANCHOR_COLUMN` / `timeSensitiveSqlPatterns()` | The SQL-side contract |

## Known limits

- **Long-context tiers are ignored.** models.dev publishes `context_over_200k` rates (often 2× list) and OpenAI charges them. Selecting between tiers needs the context length of each individual request, which aggregated usage rows no longer carry.
- **Batch, priority and committed-throughput discounts are not modelled.**
- **`reasoningOutputTokens` is informational.** Providers already fold reasoning into `output_tokens`; it is accepted and deliberately not billed twice.

## Development

```bash
pnpm install
pnpm test        # 98 tests, no network
pnpm sync        # refresh src/catalog/snapshot.json from models.dev
pnpm build
```

MIT.
