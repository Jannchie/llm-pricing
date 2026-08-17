import type { Rates } from '../types'
import type { ModelsDevCost, ModelsDevResponse } from './modelsdev'
import { closeEnough } from '../rates'
import { contextTiersFrom, isUsableCost, ratesFromCost, reasoningRatesFrom } from './modelsdev'

/**
 * The merge behind `pnpm sync`, separated from the script so it can be
 * tested without a network call.
 *
 * This builds an ARCHIVE, not a table. models.dev — like OpenRouter,
 * LiteLLM and ccusage — publishes one number per model: whatever it costs
 * today. Applied naively that re-prices history, so a vendor raising a rate
 * silently inflates last month's bill. Each sync therefore *appends* a
 * period dated today rather than overwriting.
 *
 * Append-only in both directions: a model that disappears upstream keeps
 * its whole history, because stored model strings are immortal and a row
 * that silently prices at $0 is worse than one on a stale rate.
 */

/**
 * The on-disk archive format, shared with the reader in `fallback.ts` so the
 * two cannot disagree about the tuple's arity or order. `$/MTok`.
 *
 * The trailing elements are optional and positional, so every period written
 * before a dimension existed still reads correctly: a 5-element row means "no
 * tier, no thinking rate", which is what those models were archived as. A
 * model with a thinking rate but no tiers writes `null` in the tier slot,
 * because the slots cannot be reordered without rewriting history.
 */
export type SnapshotTier = [abovePromptTokens: number, input: number, cacheWrite: number, cacheRead: number, output: number]
export type SnapshotPeriod
  = | [from: string | null, input: number, cacheWrite: number, cacheRead: number, output: number]
  | [from: string | null, input: number, cacheWrite: number, cacheRead: number, output: number, tiers: SnapshotTier[] | null]
  | [from: string | null, input: number, cacheWrite: number, cacheRead: number, output: number, tiers: SnapshotTier[] | null, reasoningOutput: number]
export type SnapshotEntry = [displayName: string, periods: SnapshotPeriod[]]
export type SnapshotModels = Record<string, SnapshotEntry>

export interface SyncResult {
  models: SnapshotModels
  added: number
  repriced: number
  /**
   * Models whose latest period gained a dimension — long-context tiers or a
   * thinking-mode rate — without any change to the rates already recorded.
   * New *information*, corrected in place rather than appended. See
   * `isDimensionBackfill`.
   */
  backfilled: number
  /** Present in the archive, no longer listed upstream. Kept. */
  retained: string[]
}

/**
 * Rates count as unchanged within `closeEnough`'s relative epsilon, rather
 * than exactly. The archive is append-only, so a spurious reprice is
 * permanent, and the snapshot already holds figures like
 * `0.010000000000000002` — an exact comparison would turn that last-bit
 * drift into a price-change record that never happened.
 */
function sameRates(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, i) => closeEnough(value, b[i]!))
}

/**
 * The rates a cost block archives as, per MTok — the four base numbers plus
 * the long-context tiers, if any.
 *
 * Written in the same shape the on-disk tuple uses so the reprice comparison
 * and the write path cannot drift: a tier that changed while the base rate
 * held steady has to read as a reprice, or the archive keeps yesterday's
 * long-context rate forever.
 */
function archivedRates(cost: ModelsDevCost): { base: ArchivedRates, tiers: SnapshotTier[], reasoningOutput: number | undefined } {
  // Both halves read through the same functions the live index uses, rather
  // than a second copy of the filtering and defaulting. The two had already
  // drifted once by construction: a rule that only the live path applied
  // would let a quote it corrects be archived uncorrected, and the archive is
  // what answers whenever the network is down.
  const base = ratesFromCost(cost, 1)
  return {
    base: flatten(base),
    tiers: (contextTiersFrom(cost, 1) ?? []).map(
      ({ abovePromptTokens, rates }): SnapshotTier => [abovePromptTokens, ...flatten(rates)],
    ),
    // Only the output rate differs in thinking mode, so one number archives it.
    reasoningOutput: reasoningRatesFrom(cost, base, 1)?.outputCostPerToken,
  }
}

/** The four rates a period tuple carries, in the order it carries them. */
type ArchivedRates = [input: number, cacheWrite: number, cacheRead: number, output: number]

/**
 * `Rates` in archive-tuple order — which is NOT the order `Rates` declares
 * them in: cache *write* comes before cache read on disk. Written once so a
 * base row and a tier row cannot encode it differently; getting it wrong in
 * one of two places would silently swap the two cache prices, and
 * `sameRates` compares the same two positions on both sides, so nothing
 * would notice.
 */
function flatten(rates: Rates): ArchivedRates {
  return [
    rates.inputCostPerToken,
    rates.cacheCreationInputCostPerToken,
    rates.cacheReadInputCostPerToken,
    rates.outputCostPerToken,
  ]
}

/** Flatten a period's rates for comparison, every dimension included. */
function comparable(period: SnapshotPeriod): number[] {
  return [
    ...period.slice(1, 5) as number[],
    ...(period[5] ?? []).flat(),
    ...(period[6] === undefined ? [] : [period[6]]),
  ]
}

/**
 * Whether this observation only *adds* tiers to a period whose base rates
 * are unchanged.
 *
 * This is not a reprice, and treating it as one does real damage. The tiers
 * did not appear today — gpt-5.5 has had its 272k rate since launch; this
 * package simply did not record tiers before. Appending a period dated today
 * would assert that every earlier row was untiered, which is false, and it
 * would hand 30-odd flat models a two-period history: they would start
 * blending across the request window and demand an hour anchor, all to
 * express a change that never happened.
 *
 * So the tiers are backfilled into the period instead — the same reasoning
 * the archive already applies to a model's first observation, which opens at
 * -infinity because "the model was priced this way before we started
 * watching". Correcting only the *latest* period keeps that honest: it is the
 * period the current quote is evidence about, and an earlier period's tier
 * is not something today's quote can speak to.
 *
 * **Available only while the archive records no tiers at all** — see
 * `archiveHasTiers`. This is the one-time cost of the archive learning a new
 * dimension, not standing behaviour: once tiers are being recorded, a tier
 * that appears is news, and backfilling it would assert a premium over
 * history that nobody was charged.
 */
function isDimensionBackfill(previous: SnapshotPeriod, next: SnapshotPeriod): boolean {
  if (!sameRates(previous.slice(1, 5) as number[], next.slice(1, 5) as number[])) {
    return false
  }
  // Every dimension the incoming observation adds must be one the archive
  // simply has no slot filled for. A dimension that *changed* is a reprice.
  const gainedTiers = !previous[5] && !!next[5]
  const gainedReasoning = previous[6] === undefined && next[6] !== undefined
  const keptTiers = sameRates((previous[5] ?? []).flat(), (next[5] ?? []).flat())
  const keptReasoning = previous[6] === next[6]
  return (gainedTiers || gainedReasoning)
    && (gainedTiers || keptTiers)
    && (gainedReasoning || keptReasoning)
}

/**
 * Whether the archive already records long-context tiers for anything.
 *
 * Decides whether a newly-seen tier reads as a gap being filled or as a
 * vendor introducing a premium — the two are indistinguishable in the data,
 * so the archive's own state is what separates them.
 */
function archiveRecords(models: SnapshotModels, slot: 5 | 6): boolean {
  return Object.values(models).some(entry => entry[1].some(period => period[slot] !== undefined))
}

export function mergeSnapshot(
  previous: SnapshotModels,
  api: ModelsDevResponse,
  providers: readonly string[],
  today: string,
): SyncResult {
  const models: SnapshotModels = { ...previous }
  const seen = new Set<string>()
  let added = 0
  let repriced = 0
  let backfilled = 0
  // Read from the incoming archive, once, so it cannot flip partway through
  // a run: the first model to gain a tier must not change how the next is
  // treated.
  // Read per dimension: tiers are already recorded, so a tier appearing now is
  // news, while a thinking rate has never been recorded and its first sighting
  // is this package learning to see it. One flag for both would have made the
  // second migration impossible.
  const mayBackfill = { 5: !archiveRecords(previous, 5), 6: !archiveRecords(previous, 6) }

  for (const provider of providers) {
    for (const [id, model] of Object.entries(api[provider]?.models ?? {})) {
      const cost = model?.cost
      if (!isUsableCost(cost)) {
        continue
      }
      const key = id.toLowerCase()
      // First provider in `providers` order wins a given bare model name.
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      // Stored as models.dev publishes them, per MTok — hence divisor 1.
      const { base, tiers, reasoningOutput } = archivedRates(cost)
      // Trailing slots are written only as far as needed, so a model with
      // neither dimension produces the same 5-element row it always has and the
      // committed archive diffs cleanly.
      const period = (reasoningOutput === undefined
        ? tiers.length > 0 ? [null, ...base, tiers] : [null, ...base]
        : [null, ...base, tiers.length > 0 ? tiers : null, reasoningOutput]) as SnapshotPeriod
      const displayName = typeof model.name === 'string' ? model.name : id

      const before = models[key]
      if (!before) {
        // First observation opens at null (-Infinity) rather than today:
        // the model was priced this way before we started watching, and
        // dating it today would leave every earlier row unpriced.
        models[key] = [displayName, [period]]
        added++
        continue
      }
      const periods = before[1]
      const latest = periods.at(-1)!
      if (sameRates(comparable(latest), comparable(period))) {
        // Unchanged. Refresh the display name only.
        models[key] = [displayName, periods]
        continue
      }
      const backfillable = (!latest[5] && !!period[5] && mayBackfill[5])
        || (latest[6] === undefined && period[6] !== undefined && mayBackfill[6])
      if (backfillable && isDimensionBackfill(latest, period)) {
        // New information about the period that already exists, not a new
        // period — see `isTierBackfill`. The effective date is left alone.
        const corrected = [latest[0], ...period.slice(1)] as SnapshotPeriod
        models[key] = [displayName, [...periods.slice(0, -1), corrected]]
        backfilled++
        continue
      }
      const dated = [today, ...period.slice(1)] as SnapshotPeriod
      // A reprice. If the latest period was recorded in this same sync (a
      // re-run on the same day), correct it in place rather than stacking
      // two periods on one date.
      models[key] = [displayName, latest[0] === today
        ? [...periods.slice(0, -1), dated]
        : [...periods, dated]]
      repriced++
    }
  }

  return {
    models,
    added,
    repriced,
    backfilled,
    retained: Object.keys(models).filter(key => !seen.has(key)),
  }
}
