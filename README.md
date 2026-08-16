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

- **The model name in your database is not the name in any price list.** Agent CLIs store `claude-opus-4-7`, `claude-haiku-4-5-20251001`, `gpt-5.5(xhigh)`, `deepseek-deepseek-v4-pro`. Catalogues use `anthropic/claude-opus-4.7`. Gateways and hosted platforms add another layer on top: `anthropic.claude-opus-4-5-20250514-v1:0` (Bedrock), `claude-opus-4-5@20250514` (Vertex), `publishers/anthropic/models/...`, `z-ai/glm-4.6:nitro`, `together_ai/deepseek-ai/DeepSeek-V3`. All of it is normalized — probing exact keys only, so a bad guess misses instead of mispricing. `:free` is deliberately left unresolved rather than billed at the paid rate.
- **Cache tokens are most of the bill and are priced four different ways.** Fresh input, cache creation (5m vs 1h TTL, the latter at 2× input), and cache read all differ by up to 100×. Providers that only report `cached_input_tokens` need their cache reads derived, or ~90% of Codex input gets billed at the full prompt rate.
- **A price is a schedule, not a number.** Vendors change rates, and history must not be re-priced. DeepSeek additionally bills peak and off-peak by UTC hour. Both dimensions are modelled; models with one flat rate — nearly all of them — short-circuit and pay nothing for the machinery.
- **Catalogues quote resellers.** The same model id is listed by 15–25 providers at their own margin, some at a placeholder $0. Getting first-party rates requires deliberate provider priority.

## Data sources

Price data is **not** hand-maintained. Live catalogues are fetched at runtime, and a generated snapshot covers the offline case:

| Layer | Source | Refresh |
| --- | --- | --- |
| Overrides | hand-written, in-repo | only what no upstream publishes |
| Live catalogue | [models.dev](https://models.dev/api.json) (default), optionally [OpenRouter](https://openrouter.ai/api/v1/models) | every 24h at runtime |
| Archive | generated from models.dev by `pnpm sync` | committed; each sync appends, never overwrites |

```ts
import { modelsDevSource, openRouterSource, PricingCatalog } from 'llm-pricing'

// models.dev first, OpenRouter filling anything it does not list.
const catalog = new PricingCatalog({ sources: [modelsDevSource(), openRouterSource()] })

// Fully offline: bundled snapshot + overrides only, no network at all.
const offline = new PricingCatalog({ sources: [] })
```

Resolution order is **overrides → fast-tier derivation → live sources grafted onto the archive → archive**. A source that fails to load never takes the catalogue down; the previous load keeps serving and `state().status` degrades to `stale`.

### Why the archive is an archive

Every catalogue in existence publishes one number per model: what it costs *today*. Multiply that by last month's tokens and a vendor's price rise silently inflates last month's bill.

So `pnpm sync` **appends** rather than overwrites. A model whose price changed carries both periods, and a live quote that disagrees with the archive is grafted on as a new period starting at the archive's sync date — the last moment the old rate is known to have been correct:

```
gpt-5.5   [null → 2026-08-15]  $5.00/MTok      ← archived
          [2026-08-15 → now ]  $6.00/MTok      ← live quote, grafted on
```

Two things follow. An effective date is only as precise as your sync cadence — a change three weeks before a sync is dated at the sync. And the archive and the live source should quote on the **same basis**: with the default (both models.dev) a disagreement really is a change over time, but pointing the live source at OpenRouter while the archive came from models.dev turns every reseller-vs-first-party gap into a spurious "reprice".

### What stays hand-maintained, and why

Two things, both because no upstream publishes them at all:

1. **Peak / off-peak schedules.** DeepSeek's first-party API bills two rates depending on the UTC hour. models.dev, OpenRouter, LiteLLM and ccusage all publish exactly one number per model, with no time-window field anywhere. If you price a Chinese working day at the off-peak rate you understate it 2×.
2. **Fast / priority tier multipliers.** No catalogue lists `gpt-5.x-fast` at all, and Anthropic's fast variants disappear from catalogues when they retire upstream.

Both tables are append-only. Stored model strings are immortal: deleting a row because upstream retired the model makes its historical rows silently cost $0.

## Caching and refresh

`ensureLoaded()` is built to sit on a per-request path: it returns immediately while the catalogue is fresh (24h), de-duplicates concurrent loads, and backs off for 5 minutes after a total failure rather than putting a downed upstream's timeout in front of every request.

What it does not do on its own is survive a restart. Give it a cache and the download is shared across reboots — and across a PM2 cluster, whose workers would otherwise each pull the same 4 MB:

```ts
import { configureDefaultCatalog } from 'llm-pricing'
import { fileCache } from 'llm-pricing/node'

// Once, during startup, before anything prices anything.
configureDefaultCatalog({
  cache: fileCache(), // defaults to os.tmpdir()/llm-pricing-cache
  cacheTtlMs: 24 * 60 * 60 * 1000, // defaults to refreshMs
})
```

That configures the catalogue the top-level functions use. Construct a `PricingCatalog` directly instead when you need more than one — different sources, tenant isolation, a test double — and use its methods, which mirror the functions one for one. Calling `configureDefaultCatalog` after the default catalogue is already in use throws rather than quietly ignoring the options.

`PricingCache` is a two-method string store, so Redis, a KV namespace or a plain `Map` (`memoryCache()`) all work:

```ts
const cache = { get: key => redis.get(key), set: (key, value) => redis.set(key, value) }
```

Writes through `fileCache` are atomic, and a missing, unreadable or corrupt entry is treated as a miss. When the network is down and the cached copy has aged out, the stale copy is used anyway — last week's catalogue beats falling all the way back to the bundled archive — and `onWarn` fires.

A cache that throws — a Redis client with Redis down — is warned about and ignored: it neither prevents the fetch nor discards one that succeeded. A source that accepts the connection and then never answers is abandoned after `timeoutMs` (30s), because `ensureLoaded()` is meant to be safe in front of a request.

Being rescued that way is not success: `state().status` reports `stale` and the retry backoff engages, so a dead upstream is contacted once per `retryMs` rather than once per request. The same applies when one source of several fails — the models only it listed keep their prices from the previous load instead of vanishing.

**Force a refresh** past the freshness window, the failure backoff and the cache:

```ts
await catalog.refresh() // or: catalog.ensureLoaded({ force: true })
```

Within a process, resolved lookups are memoised per model string, and rate cards are shared by identity — a request pricing thousands of rows across a handful of models allocates one price object per card.

## Time-aware pricing

Pass `at` when you know the instant the tokens were spent, `window` when the row is a sum over a range:

```ts
catalog.estimate({ model: 'deepseek-v4-pro', at: '2026-09-01T02:00:00Z', ...tokens }) // basis: 'exact'
catalog.estimate({ model: 'deepseek-v4-pro', window: [since, until], ...tokens }) // basis: 'blended'
```

Passing neither prices at **now**, exactly as `getPriceFor(model)` does — saying nothing about time is not a request to average over all of it.

`blended` weights each rate by how much wall-clock time the window spends under it — wrong for someone who only ever works during peak hours, but bounded by `[off-peak, peak]` and honest about the fact that the time axis was aggregated away before pricing.

For SQL callers, group rows by the UTC hour so they price exactly. `PRICE_ANCHOR_COLUMN` names the column and `timeSensitiveSqlPatterns()` gives the LIKE patterns worth splitting — derived from the schedules themselves, so a vendor that gains a peak schedule updates the query automatically:

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

Every top-level function is a one-line forward to a `PricingCatalog` method, so the two columns below are the same API reached two ways. Use the functions when one catalogue per process is enough; hold an instance when it is not.

| Function | Method | Purpose |
| --- | --- | --- |
| — | `new PricingCatalog(options)` | One catalogue and its caches |
| `getDefaultCatalog()` / `configureDefaultCatalog(options)` | — | The shared instance, and its options |
| `ensurePricingLoaded()` | `.ensureLoaded()` | Load if stale; no-op while fresh |
| `refreshPricing()` | `.refresh()` | Force a reload past freshness, backoff and cache |
| `pricingState()` | `.state()` | `{ status, loadedAt, source, size }` |
| `getPriceFor(model, at?)` | `.getPrice(...)` | Resolve a model to a flat rate card |
| `estimateCostUsd(args)` | `.estimate(...)` | Token counts → `{ cost, pricing, basis }` |
| `estimateCostFromRow(row, window?, columns?)` | `.estimateFromRow(...)` | Same, from a snake_case SQL row |
| `timeSensitiveSqlPatterns()` | `.timeSensitiveSqlPatterns()` | LIKE patterns worth splitting by hour |

Standalone, no catalogue involved:

| Export | Purpose |
| --- | --- |
| `costFromRates(rates, tokens)` | Pure arithmetic |
| `pricingCandidates(model)` | The name normalization, exposed for reuse |
| `modelsDevSource()` / `openRouterSource()` | Source adapters |
| `PRICE_ANCHOR_COLUMN` / `DEFAULT_ROW_COLUMNS` | The SQL-side contract |
| `fileCache()` (`llm-pricing/node`) / `memoryCache()` | Catalogue caches |

### `llm-pricing/internal`

The pieces the package is built from — catalogue parsers (`parseModelsDev`), the raw tables (`FALLBACK`, `OVERRIDES`), rate arithmetic (`scaleRates`, `mergeLiveQuote`) and the schedule primitives (`ratesFor`, `peakMsBetween`, `blendRates`) — are exported from a separate subpath.

They are there so the package can be extended, not so it can be used. **Their signatures track whatever the internals need and can change in a minor release.** Everything on the main entry is covered by semver.

## Known limits

- **Long-context tiers are ignored.** models.dev publishes `context_over_200k` rates (often 2× list) and OpenAI charges them. Selecting between tiers needs the context length of each individual request, which aggregated usage rows no longer carry.
- **Batch, priority and committed-throughput discounts are not modelled.**
- **`reasoningOutputTokens` is informational.** Providers already fold reasoning into `output_tokens`; it is accepted and deliberately not billed twice.

## Development

```bash
pnpm install
pnpm test        # 177 tests, no network
pnpm example     # runnable tour of every feature — examples/tour.ts
pnpm sync        # append today's prices to src/catalog/snapshot.json
pnpm build
```

MIT.
