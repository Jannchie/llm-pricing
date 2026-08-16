/* eslint-disable no-console */
// A tour of everything llm-pricing does, from one-liner to full pipeline.
// Run it with: pnpm example
//
// Nothing here needs network access except the sections marked LIVE.

import {
  costFromRates,
  estimateCostFromRow,
  getPriceFor,
  modelsDevSource,
  openRouterSource,
  PRICE_ANCHOR_COLUMN,
  pricingCandidates,
  PricingCatalog,
  SNAPSHOT_SYNCED_AT,
} from '../src/index'
// `flatSchedule` is a building block, not part of the public API.
import { flatSchedule } from '../src/internal'

const usd = (n: number): string => `$${n.toFixed(4)}`
const section = (title: string): void => console.log(`\n\u001B[1m── ${title}\u001B[0m`)

// ---------------------------------------------------------------------
section('1. The one-liner')
// ---------------------------------------------------------------------
// Offline: the bundled archive is enough. No await, no setup.

console.log(getPriceFor('claude-opus-5'))
// -> { inputCostPerToken: 5e-6, ..., displayName: 'Claude Opus 5', source: 'fallback' }

// ---------------------------------------------------------------------
section('2. Pricing one turn')
// ---------------------------------------------------------------------

const offline = new PricingCatalog({ sources: [] })

const turn = offline.estimate({
  model: 'claude-opus-5',
  inputTokens: 120_000,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 8000,
  cacheReadInputTokens: 96_000,
  outputTokens: 4500,
})
console.log(`cost ${usd(turn.cost)}  basis=${turn.basis}  via ${turn.pricing?.source}`)

// The same tokens billed naively at the input rate would be 5x this —
// 96k of that input was a cache read at 1/10th the price.
console.log(`naive input-rate-only: ${usd(120_000 * 5e-6 + 4500 * 25e-6)}`)

// ---------------------------------------------------------------------
section('3. Names your database actually stores')
// ---------------------------------------------------------------------
// All of these resolve to the same rate card.

for (const stored of [
  'claude-opus-5',
  'anthropic/claude-opus-5',
  'claude-opus-4-7-20260115', // release-tagged
  'gpt-5.5(xhigh)', // Codex effort suffix
  'openai-gpt-5.6-sol', // dash-joined vendor
]) {
  const price = getPriceFor(stored)
  console.log(`${stored.padEnd(28)} -> ${price ? `${price.displayName} @ $${(price.inputCostPerToken * 1e6).toFixed(2)}/MTok` : 'UNPRICED'}`)
}

// Peek at how it got there.
console.log('\ncandidates for "gpt-5.5(xhigh)":', pricingCandidates('gpt-5.5(xhigh)').slice(0, 6), '…')

// ---------------------------------------------------------------------
section('4. Cache TTL splits (Anthropic 1h writes cost 2x input)')
// ---------------------------------------------------------------------

const base = {
  model: 'claude-opus-5',
  inputTokens: 50_000,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 50_000,
  outputTokens: 0,
}
console.log(`all 5m writes: ${usd(offline.estimate(base).cost)}`)
console.log(`all 1h writes: ${usd(offline.estimate({ ...base, cacheCreation1hInputTokens: 50_000 }).cost)}`)

// ---------------------------------------------------------------------
section('5. Fast / priority tiers')
// ---------------------------------------------------------------------
// Derived from the base model, because no vendor publishes a first-party
// `-fast` listing and aggregators fill the gap with marked-up routers.

for (const id of ['claude-opus-4-7-fast', 'claude-opus-5-fast', 'gpt-5.5-fast']) {
  const price = getPriceFor(id)!
  const baseId = id.replace(/-fast$/, '')
  console.log(`${id.padEnd(22)} $${(price.inputCostPerToken * 1e6).toFixed(2)}/MTok  = ${(price.inputCostPerToken / getPriceFor(baseId)!.inputCostPerToken).toFixed(1)}x ${baseId}`)
}

// ---------------------------------------------------------------------
section('6. Peak / off-peak (DeepSeek bills by UTC hour)')
// ---------------------------------------------------------------------
// 01:00-04:00 and 06:00-10:00 UTC are peak — DeepSeek's Beijing working
// hours. No catalogue anywhere publishes this, so it lives in overrides.

const tokens = { inputTokens: 1e6, cachedInputTokens: 0, outputTokens: 0 }
for (const hour of [0, 2, 5, 8, 12]) {
  const at = Date.UTC(2026, 8, 1, hour)
  const { cost, basis } = offline.estimate({ model: 'deepseek-v4-flash', ...tokens, at })
  console.log(`  ${String(hour).padStart(2, '0')}:00 UTC  ${usd(cost)} / MTok  (${basis})`)
}

// No timestamp? The schedule is blended across the request window by
// wall-clock time — bounded by [off-peak, peak] and honest about it.
const blended = offline.estimate({
  model: 'deepseek-v4-flash',
  ...tokens,
  window: [Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 2)],
})
console.log(`  whole day  ${usd(blended.cost)} / MTok  (${blended.basis})`)

// ---------------------------------------------------------------------
section('7. Effective dates — history is never re-priced')
// ---------------------------------------------------------------------
// DeepSeek raised every rate at 2026-08-16 16:00 UTC. Rows from before
// that keep the old price forever.

for (const day of ['2026-08-01', '2026-09-01']) {
  const at = `${day}T12:00:00Z`
  console.log(`  ${day}  ${usd(offline.estimate({ model: 'deepseek-v4-pro', ...tokens, at }).cost)} / MTok`)
}

// ---------------------------------------------------------------------
section('8. Pricing SQL rows straight off the driver')
// ---------------------------------------------------------------------
// `price_hour_epoch` is emitted by your query (see README) and lets a row
// price at the exact hour its tokens were spent.

const rows = [
  { model: 'claude-opus-5', input_tokens: 120_000, cached_input_tokens: 0, cache_read_input_tokens: 96_000, cache_creation_input_tokens: 8000, output_tokens: 4500, [PRICE_ANCHOR_COLUMN]: null },
  { model: 'deepseek-v4-flash', input_tokens: 2_000_000, cached_input_tokens: 0, output_tokens: 50_000, [PRICE_ANCHOR_COLUMN]: Date.UTC(2026, 8, 1, 2) / 1000 },
  { model: 'deepseek-v4-flash', input_tokens: 2_000_000, cached_input_tokens: 0, output_tokens: 50_000, [PRICE_ANCHOR_COLUMN]: Date.UTC(2026, 8, 1, 12) / 1000 },
]
const window = [Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 30)] as const
let total = 0
for (const row of rows) {
  const { cost, basis } = estimateCostFromRow(row, window)
  total += cost
  console.log(`  ${String(row.model).padEnd(20)} ${usd(cost)}  (${basis})`)
}
console.log(`  total ${usd(total)}`)

// The two DeepSeek rows are identical apart from the hour, and differ 2x.
// That only works because the query grouped by the UTC hour — ask the
// catalogue which models are worth splitting:
console.log('  split these in SQL:', offline.timeSensitiveSqlPatterns())

// ---------------------------------------------------------------------
section('9. Your own prices')
// ---------------------------------------------------------------------
// A negotiated rate, a self-hosted model, an internal chargeback number.

const custom = new PricingCatalog({
  sources: [],
  overrides: {
    // $0.90/MTok in, $2.70/MTok out, cache read 10%, cache write = input.
    'acme-internal-7b': flatSchedule('Acme Internal 7B', 0.9e-6, 0.09e-6, 2.7e-6, 0.9e-6, 'override'),
  },
})
console.log(usd(custom.estimate({ model: 'acme-internal-7b', inputTokens: 1e6, cachedInputTokens: 0, outputTokens: 1e6 }).cost))

// Or skip the catalogue entirely — the arithmetic is exported on its own.
console.log(usd(costFromRates(
  { inputCostPerToken: 1e-6, cacheCreationInputCostPerToken: 1.25e-6, cacheReadInputCostPerToken: 1e-7, cachedInputCostPerToken: 1e-7, outputCostPerToken: 5e-6 },
  { inputTokens: 1e6, cachedInputTokens: 0, outputTokens: 1e5 },
)))

// ---------------------------------------------------------------------
section('10. LIVE — going online')
// ---------------------------------------------------------------------

const live = new PricingCatalog({
  sources: [modelsDevSource(), openRouterSource()],
  refreshMs: 6 * 60 * 60 * 1000,
  onWarn: (message, error) => console.warn('  pricing degraded:', message, error),
})

console.time('  load')
await live.ensureLoaded() // call this per request; it no-ops while fresh
console.timeEnd('  load')
console.log(' ', live.state())
console.log(`  archive bundled at ${SNAPSHOT_SYNCED_AT}; live quotes apply only after that date`)

for (const id of ['claude-opus-5', 'glm-5', 'kimi-k2-thinking', 'gemini-3-pro']) {
  const price = live.getPrice(id)
  console.log(`  ${id.padEnd(20)} ${price ? `$${(price.inputCostPerToken * 1e6).toFixed(3)}/$${(price.outputCostPerToken * 1e6).toFixed(3)} per MTok  [${price.source}]` : 'UNPRICED'}`)
}

// A model the live catalogue prices differently from the bundled archive
// becomes a two-period schedule rather than a retroactive reprice.
const repriced = live.timeSensitiveSqlPatterns().filter(p => !p.includes('deepseek'))
console.log(`  repriced since the archive was cut: ${repriced.length} models`)
