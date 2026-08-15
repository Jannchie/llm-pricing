import type { PriceSchedule, Rates } from './types'
import { RATE_KEYS } from './types'

export function scaleRates(rates: Rates, multiplier: number): Rates {
  const out = {} as Rates
  for (const key of RATE_KEYS) {
    out[key] = rates[key] * multiplier
  }
  return out
}

export function weightedRates(parts: Array<{ rates: Rates, weight: number }>): Rates {
  let total = 0
  for (const part of parts) {
    total += part.weight
  }
  if (total <= 0) {
    return parts[0]!.rates
  }
  const out = {} as Rates
  for (const key of RATE_KEYS) {
    let acc = 0
    for (const { rates, weight } of parts) {
      acc += rates[key] * (weight / total)
    }
    out[key] = acc
  }
  return out
}

/**
 * A single timeless rate card, expressed as a one-period schedule.
 *
 * `cacheCreation` defaults to the cached-read rate — correct for vendors
 * that do not price cache writes separately, and the historical behaviour
 * of this table. Pass it explicitly for Anthropic-style pricing where a
 * cache write costs ~1.25x input.
 */
export function flatSchedule(
  displayName: string,
  input: number,
  cachedRead: number,
  output: number,
  cacheCreation = cachedRead,
  source: PriceSchedule['source'] = 'fallback',
): PriceSchedule {
  return {
    displayName,
    source,
    periods: [{
      from: Number.NEGATIVE_INFINITY,
      rates: {
        inputCostPerToken: input,
        cacheCreationInputCostPerToken: cacheCreation,
        cacheReadInputCostPerToken: cachedRead,
        cachedInputCostPerToken: cachedRead,
        outputCostPerToken: output,
      },
    }],
  }
}

/**
 * Whether two rate cards quote the same price, within the rounding noise of
 * a unit conversion (per-MTok archives vs per-token catalogue strings).
 */
export function ratesEqual(a: Rates, b: Rates): boolean {
  for (const key of RATE_KEYS) {
    const scale = Math.max(Math.abs(a[key]), Math.abs(b[key]))
    if (Math.abs(a[key] - b[key]) > scale * 1e-9) {
      return false
    }
  }
  return true
}

/**
 * Apply a live catalogue quote on top of an archived price history.
 *
 * Every upstream catalogue publishes one number per model: what it costs
 * right now. Taking that at face value re-prices history — a vendor raising a
 * rate silently inflates last month's bill. So the live quote is grafted on
 * as the newest period instead of replacing the schedule, leaving older
 * periods on the rates the archive recorded for them.
 *
 * `observedFromMs` is the moment the archive was last known to be accurate
 * (its sync date). The real change happened somewhere between then and now;
 * dating it at the sync is the conservative end of that interval, and it is
 * the only end we have evidence for.
 */
export function mergeLiveQuote(
  archive: PriceSchedule | null,
  live: PriceSchedule,
  observedFromMs: number,
  sqlMatch?: string[],
): PriceSchedule {
  if (!archive) {
    return live
  }
  const latest = archive.periods.at(-1)!
  if (ratesEqual(latest.rates, live.periods.at(-1)!.rates)) {
    // The catalogue confirms what the archive already knew. Keep the
    // history, but credit the live source — it is what was consulted.
    return { ...archive, displayName: live.displayName ?? archive.displayName, source: live.source }
  }
  const liveRates = live.periods.at(-1)!.rates
  const periods = observedFromMs > latest.from
    ? [...archive.periods, { from: observedFromMs, rates: liveRates }]
    // The archive's own last observation is no older than our evidence, so
    // there is no interval to attribute the old rate to: correct it.
    : [...archive.periods.slice(0, -1), { from: latest.from, rates: liveRates }]
  return {
    displayName: live.displayName ?? archive.displayName,
    source: live.source,
    periods,
    sqlMatch: periods.length > 1 ? (archive.sqlMatch ?? sqlMatch) : undefined,
  }
}

/**
 * Scale every period of a schedule, peak included, so a derived variant
 * (e.g. a fast tier) keeps its schedule instead of flattening.
 */
export function scaleSchedule(base: PriceSchedule, multiplier: number, displayNameSuffix?: string): PriceSchedule {
  return {
    displayName: base.displayName && displayNameSuffix
      ? `${base.displayName} ${displayNameSuffix}`
      : base.displayName,
    source: base.source,
    sqlMatch: base.sqlMatch,
    periods: base.periods.map(period => ({
      from: period.from,
      rates: scaleRates(period.rates, multiplier),
      peak: period.peak
        ? { windowsUtc: period.peak.windowsUtc, rates: scaleRates(period.peak.rates, multiplier) }
        : undefined,
    })),
  }
}
