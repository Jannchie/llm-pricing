# llm-pricing

Turn a stored model name and a pile of token counts into a USD number you can defend.

```bash
npm install llm-pricing   # or: pnpm add llm-pricing
```

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
- **Cache tokens are most of the bill and are priced four different ways.** Fresh input, cache creation (5m vs 1h TTL, the latter at 2× input), and cache read all differ by up to 100×. Providers that only report `cached_input_tokens` need their cache reads derived, or ~90% of Codex input gets billed at the full prompt rate. Worse, whether those counts sit *inside* `inputTokens` or *beside* it is a property of whoever wrote the row rather than of the vendor — and guessing wrong bills every cached token at the full input rate, a ~10× overcharge. See [Token shapes](#token-shapes).
- **A price is a schedule, not a number.** Vendors change rates, and history must not be re-priced. DeepSeek additionally bills peak and off-peak by UTC hour, a request whose prompt clears 272k pays double for its whole length, and Alibaba charges a request that reasoned over 3× as much per output token. All four dimensions are modelled; models with one flat rate — nearly all of them — short-circuit and pay nothing for the machinery. See [Long-context tiers](#long-context-tiers) and [Thinking mode](#thinking-mode).
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

## Token shapes

Two of the counts you pass are ambiguous, and neither vendor docs nor the model id resolve them — the answer belongs to whatever wrote the row.

| Flag | Default | Meaning of the default | Cost of guessing wrong |
| --- | --- | --- | --- |
| `inputIncludesCache` | `true` | `inputTokens` is the total, cache counts included | reading a total as siblings bills cached tokens at the full input rate (~10×); the reverse only drops the fresh part (a fraction of a percent) |
| `reasoningIncludedInOutput` | `true` | reasoning is already inside `outputTokens` | billing it again double-charges every thinking turn; ignoring it where it sits outside drops real spend |

Both default to the convention of the two largest producers, and to the direction that fails cheaply. Anthropic's API reports fresh input alone (`false`), while a collector normalising several vendors into one schema usually stores the total (`true`) — so this travels with your pipeline, not with the model.

`reasoningIncludedInOutput` additionally is not constant *within* a producer: real stores contain both conventions from one source, one model and one day. Rows carrying `total_tokens` should pass `inferShape` and let each row's own total settle it, which is exact whenever reasoning is non-zero.

```ts
estimateCostFromRow(row, {
  shape: { inputIncludesCache: false }, // what your collector does
  inferShape: true, // ...corrected per row where the total proves otherwise
})
```

## Long-context tiers

A request whose **prompt** crosses a threshold is billed dearer for its whole length: `gpt-5.5` doubles input and takes output to 1.5× above 272k, Gemini 2.5 Pro does the same above 200k, and Vertex's Claude listings above 200k. 30 models in the bundled archive carry one.

Selecting a tier needs the length of *one request*, and a summed row has destroyed exactly that — ten 30k requests plus one 500k request add up to the same input as eleven 70k requests, and only the first set contains a row that crossed 272k. Dividing by a request count does not recover it either; an average is not a distribution. So the tier is opt-in, per call:

```ts
// A row that is one request — an agent CLI's message log, a request-level API table.
estimateCostUsd({ model: 'gpt-5.5', perRequest: true, ...tokens })
estimateCostFromRow(row, { perRequest: true })

// Aggregated by day/model/user: stays on the base card. This is the default.
estimateCostUsd({ model: 'gpt-5.5', ...tokens })
```

The threshold is measured on the prompt — fresh input plus cache reads plus cache writes, which is what `promptTokensBilled(tokens)` returns. Output tokens never count toward crossing it but are billed at the tier's output rate once it is crossed, which is what the vendors' ">200K prompt" wording means. Rows that store the context length directly can pass `promptTokens` (or set the `prompt_tokens` column) and skip the derivation.

Which card was applied is visible rather than folded away: `pricing.contextTierAbove` carries the threshold, and `sumEstimates` keys on it, so a workload whose long requests crossed a threshold reports two entries in `total.cards` instead of one averaged rate.

Leaving `perRequest` off keeps an aggregated row on the base card, which undercharges the rare long request rather than overcharging every short one — **and says so**. `cost` is the base-card figure, while `high` is what the same counts would come to at the dearest tier the row cannot rule out:

```ts
const { cost, low, high } = estimateCostUsd({ model: 'gpt-5.5', inputTokens: 3e6, cachedInputTokens: 0, outputTokens: 2e5 })
// cost $21.00, low $21.00, high $39.00 — "at least $21, and up to $39 if these were long requests"
```

Declaring the grain closes the interval to a point, so `high / cost` on a total is a direct measure of how much a store would gain by passing `perRequest`.

**Tiers are historical too.** Anthropic's own >200k premium — $6/$22.50 on Sonnet 4/4.5 against a $3/$15 list — existed until 2026-03-13 and was then withdrawn; every current first-party Claude model prices the full 1M window flat. That is why a tier lives inside a `PricePeriod` rather than beside the schedule: a model has to be able to carry one for its old periods and none for its new ones. The archive backfilled the tiers it learned about into their existing periods rather than dating them at the sync, since those rates were in force before this package recorded them — a one-time migration, after which a newly-appearing tier reads as a vendor introducing a premium and gets its own period.

## Thinking mode

Alibaba charges a request that reasoned at a dearer card, for its **whole response**: `qwen-plus` bills output at $1.2/MTok normally and $4/MTok in thinking mode, under a column its own [pricing table](https://www.alibabacloud.com/help/zh/model-studio/model-pricing) heads 思维链+回答 — "chain of thought AND answer". So it is not a price for reasoning tokens; it replaces the card. 9 models in the bundled archive carry one.

It rides the same `perRequest` gate as a long-context tier, for the same reason — a sum of thinking and non-thinking requests cannot be attributed to either card — and the signal is the row's own reasoning count:

```ts
// Thinking is detected from `reasoningOutputTokens > 0`, on either side of
// `reasoningIncludedInOutput`. Nothing to declare beyond the grain.
estimateCostUsd({ model: 'qwen-plus', perRequest: true, reasoningOutputTokens: 15_000, ...tokens })

// Aggregated: base card, with `high` reporting what thinking would have cost.
estimateCostUsd({ model: 'qwen-plus', ...tokens })

// What a thinking request would be charged, for display:
getPriceFor('qwen-plus', undefined, { usedReasoning: true })
```

`pricing.reasoningMode` says which card applied, and `sumEstimates` keys on it, so a workload mixing thinking and non-thinking requests reports two entries in `total.cards` rather than one averaged rate.

**It composes with a context tier rather than competing with one.** The variant hangs off each *card*, not off the period, so a tier carries its own thinking rate — which is what Alibaba's Beijing table actually publishes (a 128k–256k prompt costs $2.868/MTok of output normally and $3.441 thinking). No upstream model states both today, but the shape holds the vendor's truth rather than upstream's current view of it.

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
  const { cost, basis } = estimateCostFromRow(row, { window: [since, until] })
}
```

Pass `shape` and `inferShape` here too — see [Token shapes](#token-shapes).

## API

Five entry points cover essentially every use:

| Function | Purpose |
| --- | --- |
| `ensurePricingLoaded()` | Load the catalogue if stale; no-op while fresh. Safe per request. |
| `estimateCostUsd(args)` | Token counts → `{ cost, low, high, pricing, basis, tokens }` |
| `estimateCostFromRow(row, options?)` | The same, straight off a snake_case SQL row |
| `sumEstimates(estimates)` | Fold many into a total that keeps provenance |
| `getPriceFor(model, at?, facts?)` | Just the rate card, no token counts |

<details>
<summary>Everything else</summary>

Each top-level function is a one-line forward to a `PricingCatalog` method — the same API reached two ways. Use the functions when one catalogue per process is enough; hold an instance when it is not (different sources, tenant isolation, a test double).

| Function | Method | Purpose |
| --- | --- | --- |
| — | `new PricingCatalog(options)` | One catalogue and its caches |
| `getDefaultCatalog()` / `configureDefaultCatalog(options)` | — | The shared instance, and its options |
| `refreshPricing()` | `.refresh()` | Force a reload past freshness, backoff and cache |
| `pricingState()` | `.state()` | `{ status, loadedAt, source, size }` |
| `timeSensitiveSqlPatterns()` | `.timeSensitiveSqlPatterns()` | LIKE patterns worth splitting by hour |

Standalone, no catalogue involved:

| Export | Purpose |
| --- | --- |
| `costFromRates(rates, tokens)` / `tokensBilled(tokens)` / `promptTokensBilled(tokens)` | Pure arithmetic |
| `pricingCandidates(model)` | The name normalization, exposed for reuse |
| `modelsDevSource()` / `openRouterSource()` | Source adapters |
| `PRICE_ANCHOR_COLUMN` / `DEFAULT_ROW_COLUMNS` | The SQL-side contract |
| `inferTokenShape(row, columns?)` | Recover `reasoningIncludedInOutput` from a row's own total |
| `fileCache()` (`llm-pricing/node`) / `memoryCache()` | Catalogue caches |

### `llm-pricing/internal`

The pieces the package is built from — catalogue parsers (`parseModelsDev`), the raw tables (`FALLBACK`, `OVERRIDES`), rate arithmetic (`scaleRates`, `mergeLiveQuote`) and the schedule primitives (`ratesFor`, `peakMsBetween`, `blendRates`) — are exported from a separate subpath.

They are there so the package can be extended, not so it can be used. **Their signatures track whatever the internals need and can change in a minor release.** Everything on the main entry is covered by semver.

The schedule primitives accept only a `NormalizedSchedule` — what `normalizeSchedule` returns. They run once per priced row and so validate nothing themselves; the brand is what makes "already checked" a fact the compiler enforces rather than a convention. A schedule that reaches them unvalidated can crash (a history not reaching back to `-Infinity` leaves `blendRates` with nothing to average) or silently answer from the wrong era.

</details>

## Adding up

Cost is the only part of an estimate that adds. The card that priced it, how that card was arrived at, and whether the model was known at all do not — so a caller folding rows with `+=` loses all three at the first `+`, and the accumulator they write instead usually keeps the *last* card it saw and calls it the model's price. That is true only when every row of a model shares one card, which is exactly false for the models this package works hardest on: a DeepSeek model spanning peak and off-peak has two, a factor of two apart.

```ts
import { sumEstimates } from 'llm-pricing'

const total = sumEstimates(rows.map(row => estimateCostFromRow(row, options)))

total.cost // what to display
total.high // ...and total.low: the interval it could actually be
total.unpriced.tokens // usage this total is reporting as $0
total.byBasis.blended // the share an hour-grouped query would sharpen
total.cards // every rate that contributed, with how much each did
```

`low`/`high` are on each estimate too, and are real prices rather than an error bar — every one of them is a card the row could actually have been charged at. Two things open the interval: a blend across a price change or a peak boundary, and an undeclared prompt length on a model that prices by one. Everything else has all three equal, so a total only shows a range when something in it genuinely has one.

`unpriced` is the counterweight to `cost: 0`. An unknown model contributes nothing to the total and the total still looks complete; this is how much usage that zero is standing in for.

## Known limits

- **Long-context tiers need `perRequest`.** They are modelled and priced (see [Long-context tiers](#long-context-tiers)), but only for rows the caller declares to be a single request. An aggregated row cannot say whether any individual request crossed a threshold, so it stays on the base card — and reports `high` as what the tier would have cost, rather than claiming the base rate was certainly charged.
- **A withdrawn tier is only archived from the day it was noticed.** Anthropic's pre-2026-03-13 >200k premium on Sonnet 4/4.5 is not in the archive: upstream publishes today's prices, and when a premium is withdrawn the tier disappears from the feed along with its history. Pricing those rows correctly needs a hand-written override with the right effective window.
- **A per-reasoning-token rate is not applied.** Perplexity's `sonar-deep-research` bills reasoning tokens at $3/MTok *in addition to* $8/MTok of output, and that fifth priced quantity is not modelled — those tokens are billed at the output rate instead. Alibaba's thinking pricing is a different thing and *is* modelled; see [Thinking mode](#thinking-mode).
- **Alibaba's own context tiers are missing upstream.** Its published table puts `qwen-plus` on tiers (Singapore above 256K; Beijing at 128K/256K/1M, where the output rate jumps 10× at the first step), but models.dev publishes no `cost.tiers` for any first-party Alibaba model — while resellers such as OpenRouter and DeepInfra publish them for the same models. Since first-party listings win the bare-name index, long qwen requests are priced at the short-request rate. Correcting it needs a hand-written override per model and region.
- **Batch, priority and committed-throughput discounts are not modelled.** Nor is the 1.1× `inference_geo: "us"` / regional-endpoint multiplier. Upstream has no price for any of them: models.dev's `service_tier: "priority"` appears only as a request-body hint under `experimental.modes`, with no rate attached, which is why the fast/priority multipliers are hand-maintained (see [What stays hand-maintained](#what-stays-hand-maintained-and-why)).
- **A blend weights by wall-clock time, not by usage.** Rows summed over a window no longer say which hours their tokens were spent in, so `blended` assumes they were spread evenly. Measured against a real store's DeepSeek traffic, 27.45% of tokens landed in peak hours against the 29.17% a uniform day implies — a 1.35% overstatement there, but the bound is the full [off-peak, peak] interval, which `low`/`high` now report rather than leave implicit. Group by UTC hour to remove the assumption entirely.
- **Token nesting cannot be inferred from the model.** Which counts contain which is a property of the producer, and for reasoning not even a constant one. `inferShape` recovers the output side from a row's own total; the input side is genuinely unrecoverable and has to be declared. See [Token shapes](#token-shapes).

## Development

```bash
pnpm install
pnpm test        # the whole suite, no network
pnpm example     # runnable tour of every feature — examples/tour.ts
pnpm sync        # append today's prices to src/catalog/snapshot.json
pnpm build
```

[MIT](./LICENSE) · [GitHub](https://github.com/Jannchie/llm-pricing) · [npm](https://www.npmjs.com/package/llm-pricing)
