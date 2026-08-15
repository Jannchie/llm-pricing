import type { PriceSchedule, Rates } from '../types'

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

const DEEPSEEK_SQL_MATCH = ['%deepseek%']

export const OVERRIDES: Record<string, PriceSchedule> = {
  'deepseek-v4-flash': {
    displayName: 'DeepSeek V4 Flash',
    source: 'override',
    sqlMatch: DEEPSEEK_SQL_MATCH,
    periods: [
      { from: Number.NEGATIVE_INFINITY, rates: deepseekRates(0.0028, 0.14, 0.28) },
      {
        from: DEEPSEEK_PEAK_FROM_MS,
        rates: deepseekRates(0.007, 0.22, 0.66),
        peak: { windowsUtc: DEEPSEEK_PEAK_WINDOWS_UTC, rates: deepseekRates(0.014, 0.44, 1.32) },
      },
    ],
  },
  'deepseek-v4-pro': {
    displayName: 'DeepSeek V4 Pro',
    source: 'override',
    sqlMatch: DEEPSEEK_SQL_MATCH,
    periods: [
      { from: Number.NEGATIVE_INFINITY, rates: deepseekRates(0.003_625, 0.435, 0.87) },
      {
        from: DEEPSEEK_PEAK_FROM_MS,
        rates: deepseekRates(0.022, 0.66, 1.98),
        peak: { windowsUtc: DEEPSEEK_PEAK_WINDOWS_UTC, rates: deepseekRates(0.044, 1.32, 3.96) },
      },
    ],
  },
}
