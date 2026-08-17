// Throughput harness for the pricing hot path: `pnpm bench`.
//
// Why this exists, and why it is shaped like this.
//
// A dozen decisions in `src/` are justified by cost per priced row — the
// `priceCards` and `lastBlend` memos, `isTimeSensitive` staying closure-free,
// reducing each row's counts once, the flat path returning before it touches
// the per-request machinery. Nothing verified any of them, so a later "harmless
// simplification" could delete one for free.
//
// What it took to learn: absolute throughput on a developer laptop is NOT
// measurable to better than about 2x. Measured here, the same function on the
// same tree across four consecutive processes ran at 86.5, 79.9, 44.5 and
// 43.0 M ops/s — thermal, not code. Anyone comparing two branches by running
// each once will read that swing as a result and act on it.
//
// So this harness does two things differently:
//
//   1. **Interleaves.** Every scenario is timed once per round, round-robin, so
//      a machine that slows down mid-run slows all of them together. The
//      fastest observed round wins, being the one least disturbed.
//   2. **Measures its own resolution.** The first pair of scenarios is the same
//      work under two names. Their ratio is 1.0 by construction, so whatever it
//      comes out as is this run's noise floor — and any difference smaller than
//      that is not a finding. Read the floor before reading anything else.
//
// Ratios between scenarios in one run are meaningful. Absolute numbers are for
// orders of magnitude only; do not paste them into a commit message.

import { estimateCostUsd, getDefaultCatalog, sumEstimates } from '../src/index'

const ROUNDS = 8
const ROWS = 200_000

const counts = {
  inputTokens: 12_345,
  cachedInputTokens: 0,
  cacheCreationInputTokens: 2000,
  cacheReadInputTokens: 8000,
  outputTokens: 900,
}

type Args = Parameters<typeof estimateCostUsd>[0]

function rows(extra: Partial<Args> & { model: string }): Args[] {
  return Array.from({ length: ROWS }, () => ({ ...counts, ...extra }))
}

// A window that spans DeepSeek's price change, so the blended path is real
// rather than a single period pretending.
const WINDOW = [Date.UTC(2026, 6, 1), Date.UTC(2026, 7, 20)] as const

const SCENARIOS: Array<{ name: string, note: string, rows: Args[] }> = [
  // The resolution probe: identical work, two names. See the header.
  { name: 'control A', note: 'noise floor probe — identical to control B', rows: rows({ model: 'claude-opus-4-7' }) },
  { name: 'control B', note: 'noise floor probe — identical to control A', rows: rows({ model: 'claude-opus-4-7' }) },

  // ~97% of models: one period, no peak, priced by neither per-request
  // dimension. The path everything else is measured against.
  { name: 'flat, untiered', note: 'the majority path; should lead', rows: rows({ model: 'claude-opus-4-7' }) },

  // Long-context tiers: undeclared pays for the bound cards, declared for
  // selection only.
  { name: 'tiered, undeclared', note: 'prices the tier cards too, for low/high', rows: rows({ model: 'gpt-5.5' }) },
  { name: 'tiered, perRequest', note: 'selects one card, bounds nothing', rows: rows({ model: 'gpt-5.5', perRequest: true }) },

  // Thinking mode, same shape.
  { name: 'thinking, perRequest', note: 'qwen-plus reasoning variant', rows: rows({ model: 'qwen-plus', reasoningOutputTokens: 400, perRequest: true }) },

  // Time-sensitive paths. `at` resolves exactly; a window blends and must hit
  // the single-slot `lastBlend` memo on every row after the first.
  { name: 'exact instant', note: 'peak schedule, anchored to an hour', rows: rows({ model: 'deepseek-v4-pro', at: Date.UTC(2026, 7, 1, 3) }) },
  { name: 'blended, memo hit', note: 'one window for every row', rows: rows({ model: 'deepseek-v4-pro', window: WINDOW }) },

  // The same blend with a prompt length that differs per row, which is what
  // makes the memo miss — this is the pair that says the memo is working.
  {
    name: 'blended, memo miss',
    note: 'per-row prompt length defeats lastBlend',
    rows: Array.from({ length: ROWS }, (_, i) => ({
      ...counts,
      model: 'deepseek-v4-pro',
      window: WINDOW,
      perRequest: true,
      promptTokens: 1000 + i,
    })),
  },

  // An unresolvable name: the whole pipeline minus pricing, so the gap between
  // this and `flat, untiered` is what resolution plus arithmetic costs.
  { name: 'unpriced model', note: 'resolution miss, memoised', rows: rows({ model: 'no-such-model-anywhere' }) },
]

function timeRows(input: Args[]): number {
  const start = process.hrtime.bigint()
  // Folded through `sumEstimates` rather than summed by hand: that is how a
  // caller actually consumes these, and it exercises the card grouping.
  const total = sumEstimates(input.map(row => estimateCostUsd(row)))
  const ms = Number(process.hrtime.bigint() - start) / 1e6
  // Keep the result observable so nothing above can be optimised away.
  if (!Number.isFinite(total.cost)) {
    throw new TypeError('non-finite total')
  }
  return ms
}

const catalog = getDefaultCatalog()
await catalog.ensureLoaded()
console.log(`catalogue: ${JSON.stringify(catalog.state())}`)
console.log(`${SCENARIOS.length} scenarios x ${ROUNDS} interleaved rounds x ${ROWS.toLocaleString()} rows\n`)

const best = new Map<string, number>()
const worst = new Map<string, number>()
for (let round = 0; round < ROUNDS; round++) {
  for (const scenario of SCENARIOS) {
    const ms = timeRows(scenario.rows)
    best.set(scenario.name, Math.min(best.get(scenario.name) ?? Infinity, ms))
    worst.set(scenario.name, Math.max(worst.get(scenario.name) ?? 0, ms))
  }
}

const rate = (name: string): number => ROWS / best.get(name)! / 1000
const reference = rate('flat, untiered')

// The floor first, because it decides what the rest of the table can claim.
const floor = Math.abs(rate('control A') / rate('control B') - 1)
console.log(`resolution: ${(floor * 100).toFixed(1)}% — identical work under two names differed by this much.`)
console.log(`            Differences below it are noise, not findings.\n`)

console.log(`${'scenario'.padEnd(22)}${'M rows/s'.padStart(10)}${'vs flat'.padStart(10)}${'spread'.padStart(9)}  note`)
for (const { name, note } of SCENARIOS) {
  const mrs = rate(name)
  const spread = worst.get(name)! / best.get(name)!
  console.log(
    `${name.padEnd(22)}${mrs.toFixed(2).padStart(10)}${`${(mrs / reference).toFixed(2)}x`.padStart(10)}`
    + `${`${spread.toFixed(1)}x`.padStart(9)}  ${note}`,
  )
}

// `spread` is per scenario across rounds: a value far above 1 means the machine
// moved under it, and its number is worth less than the others'.
console.log(`\nRatios are comparable within this run only. A spread far above 1.0x`)
console.log(`means the machine moved mid-run — rerun on an idle machine.`)
