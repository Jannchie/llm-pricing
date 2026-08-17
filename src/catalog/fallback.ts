import type { ContextTier, PricePeriod, PriceSchedule, Rates } from '../types'
import type { SnapshotEntry, SnapshotPeriod, SnapshotTier } from './sync'
import { scaleRates } from '../rates'

import snapshot from './snapshot.json'

// The offline price archive, used when no remote source is reachable or
// none of them lists a model.
//
// Its rows are NOT hand-maintained: `snapshot.json` is generated from
// models.dev by `pnpm sync`, filtered to first-party providers so a bare
// model name resolves to the rate a user calling the vendor directly would
// pay. Each sync appends a period rather than overwriting, so a vendor
// raising its rate does not re-price last month — see the script header.
//
// What IS hand-maintained here is the one thing no upstream publishes: the
// fast/priority tier multipliers below.

// The JSON's inferred type cannot express fixed-arity tuples; the shape is
// guaranteed by the generator instead.
const SNAPSHOT_MODELS = snapshot.models as unknown as Record<string, SnapshotEntry>

/** When the bundled archive was last refreshed (YYYY-MM-DD). */
export const SNAPSHOT_SYNCED_AT: string = snapshot.syncedAt

/**
 * The archive's last observation, as epoch ms. Anything a live source
 * reports is newer than this and must not be applied before it — see
 * `mergeLiveQuote`.
 */
export const SNAPSHOT_SYNCED_AT_MS: number = Date.parse(`${snapshot.syncedAt}T00:00:00Z`)

function toRates(input: number, cacheWrite: number, cacheRead: number, output: number): Rates {
  return {
    inputCostPerToken: input / 1e6,
    cacheCreationInputCostPerToken: cacheWrite / 1e6,
    cacheReadInputCostPerToken: cacheRead / 1e6,
    cachedInputCostPerToken: cacheRead / 1e6,
    outputCostPerToken: output / 1e6,
  }
}

function toTier([above, input, cacheWrite, cacheRead, output]: SnapshotTier): ContextTier {
  return { abovePromptTokens: above, rates: toRates(input, cacheWrite, cacheRead, output) }
}

function toPeriod([from, input, cacheWrite, cacheRead, output, tiers, reasoningOutput]: SnapshotPeriod): PricePeriod {
  const rates = toRates(input, cacheWrite, cacheRead, output)
  return {
    from: from === null ? Number.NEGATIVE_INFINITY : Date.parse(`${from}T00:00:00Z`),
    rates,
    // Both absent on every period archived before the dimension was recorded,
    // which is the honest reading: those rows were observed as one flat rate.
    contextTiers: tiers?.map(toTier) ?? undefined,
    reasoningRates: reasoningOutput === undefined
      ? undefined
      : { ...rates, outputCostPerToken: reasoningOutput / 1e6 },
  }
}

const FALLBACK: Record<string, PriceSchedule> = {}

for (const [id, [displayName, periods]] of Object.entries(SNAPSHOT_MODELS)) {
  FALLBACK[id] = {
    displayName,
    source: 'fallback',
    periods: periods.map(toPeriod),
    // A model that has actually been repriced needs its rows split by hour
    // for exact pricing; one that never has stays flat and costs the query
    // layer nothing. Deriving the pattern here rather than listing it keeps
    // the SQL side in step with the archive automatically.
    //
    // `_` is a single-character wildcard in LIKE, so an id containing one
    // over-matches. That only costs a few extra correctly-priced rows —
    // the same trade the vendor-wide patterns in overrides.ts make.
    sqlMatch: periods.length > 1 ? [`%${id}%`] : undefined,
  }
}

// Fast / priority inference variants.
//
// No catalogue publishes these: OpenRouter lists no `gpt-5.x-fast` model at
// all, models.dev has no fast tier, and Anthropic's fast variants vanish
// from catalogues when they retire upstream. So the multipliers live here,
// applied to whatever base model the archive provides — including its
// history, so a fast variant of a repriced model keeps the schedule.
//
// The multiplier is NOT constant: Opus 4.6/4.7 x6 ($30/$150), Opus 4.8 x2
// ($10/$50, Anthropic's published fast-mode rate), gpt-5.5 x2.5, gpt-5.4 /
// gpt-5.3-codex x2. Opus 5 follows 4.8; the rest of the Codex tiers use x2
// as the house default, since upstream has not published a rate for them.
// Sonnet and Haiku have no fast variant — do not synthesize one.
//
// Append-only, like the archive: never drop a row because upstream retired
// the model, or its historical rows silently price at $0.
const FAST_MULTIPLIERS: Array<[multiplier: number, baseIds: string[]]> = [
  [6, ['claude-opus-4-6', 'claude-opus-4-7']],
  [2, ['claude-opus-4-8', 'claude-opus-5']],
  [2.5, ['gpt-5.5']],
  [2, [
    'gpt-5',
    'gpt-5-codex',
    'gpt-5.1',
    'gpt-5.1-codex',
    'gpt-5.1-codex-max',
    'gpt-5.1-codex-mini',
    'gpt-5.2-codex',
    'gpt-5.3-codex',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.6-sol',
    'gpt-5.6-luna',
    'gpt-5.6-terra',
  ]],
]

// Long-context tiers that no catalogue publishes, as a multiple of whatever
// the model's own card resolves to.
//
// Alibaba is the gap this fills. Its published table puts `qwen-plus` on tiers
// — above 256K a Singapore request pays $1.2/$3.6 against a $0.4/$1.2 list,
// and $12 rather than $4 for thinking output — but models.dev publishes no
// `cost.tiers` for any first-party Alibaba model, while resellers publish them
// for the same models. First-party listings win the bare-name index, so
// without this a 300k-token qwen-plus request prices at the short-request rate.
//
// Two deliberate choices, both the opposite of how an upstream-published tier
// is handled:
//
//   - **A multiple, not a card.** `ContextTier` carries absolute rates because
//     upstream ratios are not uniform. A hand-maintained entry has the reverse
//     problem: absolute numbers would put every row of the model on a base
//     price this file has to keep current, to fix the rare long request. Every
//     rate in Alibaba's own table moves by exactly 3x at the boundary, so the
//     multiple states the tier without owning the base — the same reasoning
//     `FAST_MULTIPLIERS` applies.
//   - **Only when the resolved schedule has none of its own.** The moment
//     upstream publishes what it is missing, this table steps aside rather
//     than overriding fresher data with an older assumption.
//
// Keyed by catalogue id, matched against the same candidates a lookup expands.
const CONTEXT_TIER_MULTIPLIERS: Record<string, Array<[abovePromptTokens: number, multiplier: number]>> = {
  // https://www.alibabacloud.com/help/zh/model-studio/model-pricing —
  // Singapore. Beijing (`alibaba-cn`) tiers at 128K/256K/1M and does NOT move
  // uniformly, so it is deliberately not expressed here; a bare `qwen-plus`
  // resolves to the Singapore listing.
  'qwen-plus': [[256_000, 3]],
}

/**
 * `<id>-fast` -> the base id and its multiplier.
 *
 * Fast variants are derived when a model is *resolved*, not baked into the
 * table, for two reasons. The multiplier then applies to whatever the base
 * currently resolves to — including a live reprice — and it beats the
 * reseller quotes that litter these ids upstream: no vendor publishes a
 * first-party `-fast` model, so aggregators fill the gap with routers
 * marking the real rate up 20%.
 */
const FAST_BY_ID: Record<string, { base: string, multiplier: number }> = {}

for (const [multiplier, baseIds] of FAST_MULTIPLIERS) {
  for (const id of baseIds) {
    FAST_BY_ID[`${id}-fast`] = { base: id, multiplier }
  }
}

/**
 * Attach the hand-maintained long-context tiers for `id`, if there are any and
 * the schedule does not already price by prompt size.
 *
 * Derived per period, so a model with price history gets a tier scaled from
 * each era's own card rather than from today's — and returned by identity when
 * there is nothing to add, which is every model but the handful listed above.
 */
export function withDerivedContextTiers(id: string, schedule: PriceSchedule): PriceSchedule {
  const multipliers = CONTEXT_TIER_MULTIPLIERS[id]
  // Tiers specifically, not `pricesByRequest`: qwen-plus carries a thinking
  // card, so asking whether the schedule prices by *any* per-request dimension
  // would answer yes and this table would never apply.
  if (!multipliers || schedule.periods.some(period => period.contextTiers?.length)) {
    return schedule
  }
  return {
    ...schedule,
    periods: schedule.periods.map(period => ({
      ...period,
      contextTiers: multipliers.map(([abovePromptTokens, multiplier]) => ({
        abovePromptTokens,
        rates: scaleRates(period.rates, multiplier),
        // The thinking variant scales with everything else: Alibaba's own table
        // takes thinking output from $4 to $12 across the same boundary.
        reasoningRates: period.reasoningRates && scaleRates(period.reasoningRates, multiplier),
      })),
    })),
  }
}

export { CONTEXT_TIER_MULTIPLIERS, FALLBACK, FAST_BY_ID, FAST_MULTIPLIERS }

export { scaleSchedule } from '../rates'
