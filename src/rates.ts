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
