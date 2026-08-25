import type { PricePeriod, PriceSchedule, Rates } from '../types'

// ---------------------------------------------------------------------
// DeepSeek — first-party schedules that OUTRANK the OpenRouter catalogue.
// ---------------------------------------------------------------------
//
// Three independent reasons these are overrides rather than fallbacks:
//
//   1. OpenRouter's model-level `pricing` block reports whichever endpoint
//      it routes to by default. For `deepseek/deepseek-v4-pro` that is a
//      reseller at $1.168/$2.336 per MTok — 2.7x DeepSeek's own
//      $0.435/$0.87, which is only visible via
//      /api/v1/models/<id>/endpoints. Users calling the first-party API
//      (the overwhelmingly common case for a `deepseek-v4-pro` row) were
//      being priced at the reseller rate whenever OpenRouter was up.
//   2. OpenRouter publishes one number per model and has no way to
//      express a peak/off-peak schedule at all.
//   3. Its cache-read numbers are unreliable for this vendor: it quotes
//      $0.028/MTok for v4-flash, 10x DeepSeek's published $0.0028, while
//      quoting v4-pro's $0.003625 exactly right. These workloads are
//      overwhelmingly cache reads, so that one field moved 30 days of
//      measured DeepSeek spend across all users from $217 to $58.
//
// Source of truth: https://api-docs.deepseek.com/quick_start/pricing/
const DEEPSEEK_PEAK_FROM_MS = Date.UTC(2026, 7, 16, 16, 0, 0)

// 01:00-04:00 and 06:00-10:00 UTC — i.e. 09:00-12:00 / 14:00-18:00 in
// Beijing, DeepSeek's home working hours. Off-peak is everything else,
// billed at exactly half the peak rate.
const DEEPSEEK_PEAK_WINDOWS_UTC: Array<[number, number]> = [[1, 4], [6, 10]]

// From 00:00 Beijing on 2026-08-23, the peak windows apply Monday to Friday
// only: DeepSeek charges the off-peak rate around the clock at weekends.
const DEEPSEEK_WEEKEND_OFF_PEAK_FROM_MS = Date.UTC(2026, 7, 22, 16, 0, 0)

// Monday-Friday. The weekend is DeepSeek's — i.e. Beijing's — but every peak
// window falls in 01:00-10:00 UTC, which is 09:00-18:00 the *same* calendar
// day in Beijing, so the UTC weekday and the Beijing one never disagree
// anywhere the windows can apply.
const DEEPSEEK_PEAK_DAYS_UTC = [1, 2, 3, 4, 5]

// DeepSeek publishes three prices per model — cache hit, cache miss and
// output, in $/MTok. There is deliberately no cache-*write* price: writing
// the context cache is free, and the tokens that missed are billed at the
// plain input (miss) rate. So cacheCreation === input here, NOT the hit
// rate that `flatSchedule` would otherwise default it to — that default was
// under-charging DeepSeek cache creation by ~30-50x.
function deepseekRates(hitPerMTok: number, missPerMTok: number, outputPerMTok: number): Rates {
  return {
    inputCostPerToken: missPerMTok / 1e6,
    cacheCreationInputCostPerToken: missPerMTok / 1e6,
    cacheReadInputCostPerToken: hitPerMTok / 1e6,
    cachedInputCostPerToken: hitPerMTok / 1e6,
    outputCostPerToken: outputPerMTok / 1e6,
  }
}

/**
 * The two periods DeepSeek's peak schedule has had, from one pair of cards.
 *
 * The weekend period differs from the weekday-and-weekend one it replaces by
 * exactly `daysUtc`, so it is derived from it rather than restated: written
 * out twice, the six rate literals per model had nothing checking the copies
 * still agreed, and the next rate correction would have landed on one period
 * only.
 */
function deepseekPeakPeriods(offPeak: Rates, peak: Rates): PricePeriod[] {
  const weekdaysAndWeekends: PricePeriod = {
    from: DEEPSEEK_PEAK_FROM_MS,
    rates: offPeak,
    peak: { windowsUtc: DEEPSEEK_PEAK_WINDOWS_UTC, rates: peak },
  }
  return [
    weekdaysAndWeekends,
    {
      ...weekdaysAndWeekends,
      from: DEEPSEEK_WEEKEND_OFF_PEAK_FROM_MS,
      peak: { ...weekdaysAndWeekends.peak!, daysUtc: DEEPSEEK_PEAK_DAYS_UTC },
    },
  ]
}

const DEEPSEEK_SQL_MATCH = ['%deepseek%']

export const OVERRIDES: Record<string, PriceSchedule> = {
  'deepseek-v4-flash': {
    displayName: 'DeepSeek V4 Flash',
    source: 'override',
    sqlMatch: DEEPSEEK_SQL_MATCH,
    periods: [
      { from: Number.NEGATIVE_INFINITY, rates: deepseekRates(0.0028, 0.14, 0.28) },
      ...deepseekPeakPeriods(deepseekRates(0.007, 0.22, 0.66), deepseekRates(0.014, 0.44, 1.32)),
    ],
  },
  'deepseek-v4-pro': {
    displayName: 'DeepSeek V4 Pro',
    source: 'override',
    sqlMatch: DEEPSEEK_SQL_MATCH,
    periods: [
      { from: Number.NEGATIVE_INFINITY, rates: deepseekRates(0.003_625, 0.435, 0.87) },
      ...deepseekPeakPeriods(deepseekRates(0.022, 0.66, 1.98), deepseekRates(0.044, 1.32, 3.96)),
    ],
  },
}
