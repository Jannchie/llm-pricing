import type { PriceSchedule, Rates } from '../src/types'
import { describe, expect, it } from 'vitest'
import {
  blendRates,
  isPeakHour,
  isTimeSensitive,
  peakMsBetween,
  periodAt,
  ratesAt,
  ratesFor,
  toMs,
} from '../src/schedule'
import { DAY_MS, HOUR_MS } from '../src/types'

function rates(n: number): Rates {
  return {
    inputCostPerToken: n,
    cacheCreationInputCostPerToken: n,
    cacheReadInputCostPerToken: n,
    cachedInputCostPerToken: n,
    outputCostPerToken: n,
  }
}

const WINDOWS: Array<[number, number]> = [[1, 4], [6, 10]]
const CUTOVER = Date.UTC(2026, 7, 16, 16, 0, 0)

const scheduled: PriceSchedule = {
  source: 'override',
  periods: [
    { from: Number.NEGATIVE_INFINITY, rates: rates(1) },
    { from: CUTOVER, rates: rates(10), peak: { windowsUtc: WINDOWS, rates: rates(20) } },
  ],
}

const flat: PriceSchedule = {
  source: 'fallback',
  periods: [{ from: Number.NEGATIVE_INFINITY, rates: rates(3) }],
}

describe('toms', () => {
  it('accepts numbers, dates and iso strings', () => {
    expect(toMs(123)).toBe(123)
    expect(toMs(new Date(456))).toBe(456)
    expect(toMs('2026-08-16T16:00:00Z')).toBe(CUTOVER)
  })

  it('returns null for anything unusable', () => {
    expect(toMs(null)).toBeNull()
    expect(toMs(undefined)).toBeNull()
    expect(toMs('not a date')).toBeNull()
    expect(toMs(Number.NaN)).toBeNull()
  })
})

describe('istimesensitive', () => {
  it('is false for a single flat period', () => {
    expect(isTimeSensitive(flat)).toBe(false)
  })

  it('is true with multiple periods', () => {
    expect(isTimeSensitive(scheduled)).toBe(true)
  })

  it('is true for a single period carrying a peak window', () => {
    expect(isTimeSensitive({
      source: 'override',
      periods: [{ from: Number.NEGATIVE_INFINITY, rates: rates(1), peak: { windowsUtc: WINDOWS, rates: rates(2) } }],
    })).toBe(true)
  })
})

describe('periodat', () => {
  it('never re-prices history across an effective date', () => {
    expect(periodAt(scheduled, CUTOVER - 1).rates.inputCostPerToken).toBe(1)
    expect(periodAt(scheduled, CUTOVER).rates.inputCostPerToken).toBe(10)
  })

  it('falls back to the first period before any start', () => {
    expect(periodAt(scheduled, Number.NEGATIVE_INFINITY).rates.inputCostPerToken).toBe(1)
  })
})

describe('ispeakhour', () => {
  it.each([
    [0, false],
    [1, true],
    [3, true],
    [4, false],
    [5, false],
    [6, true],
    [9, true],
    [10, false],
    [23, false],
  ])('hour %i -> %s', (hour, expected) => {
    expect(isPeakHour(WINDOWS, Date.UTC(2026, 8, 1, hour, 30))).toBe(expected)
  })

  it('is half-open at the window edges', () => {
    expect(isPeakHour([[1, 2]], Date.UTC(2026, 8, 1, 1, 0))).toBe(true)
    expect(isPeakHour([[1, 2]], Date.UTC(2026, 8, 1, 2, 0))).toBe(false)
  })

  it('handles pre-epoch timestamps without going negative', () => {
    expect(isPeakHour(WINDOWS, Date.UTC(1969, 11, 31, 2, 0))).toBe(true)
    expect(isPeakHour(WINDOWS, Date.UTC(1969, 11, 31, 5, 0))).toBe(false)
  })
})

describe('ratesat', () => {
  it('charges the peak card only inside a peak hour of the active period', () => {
    expect(ratesAt(scheduled, Date.UTC(2026, 8, 1, 2)).inputCostPerToken).toBe(20)
    expect(ratesAt(scheduled, Date.UTC(2026, 8, 1, 5)).inputCostPerToken).toBe(10)
    // Same hour of day, but before the cutover: the old flat rate applies.
    expect(ratesAt(scheduled, Date.UTC(2026, 6, 1, 2)).inputCostPerToken).toBe(1)
  })
})

// Independent implementation of peakMsBetween: walk the range hour by hour.
function brute(windows: Array<[number, number]>, from: number, to: number): number {
  let total = 0
  for (let t = from; t < to; t += HOUR_MS) {
    if (isPeakHour(windows, t)) {
      total += HOUR_MS
    }
  }
  return total
}

describe('peakmsbetween', () => {
  it('matches an hour-by-hour walk over a month', () => {
    const from = Date.UTC(2026, 7, 1)
    const to = Date.UTC(2026, 8, 1)
    expect(peakMsBetween(WINDOWS, from, to)).toBe(brute(WINDOWS, from, to))
  })

  it('matches an hour-by-hour walk on a ragged range', () => {
    const from = Date.UTC(2026, 7, 3, 7)
    const to = Date.UTC(2026, 7, 19, 2)
    expect(peakMsBetween(WINDOWS, from, to)).toBe(brute(WINDOWS, from, to))
  })

  it('counts 7 peak hours per whole day', () => {
    const from = Date.UTC(2026, 7, 1)
    expect(peakMsBetween(WINDOWS, from, from + DAY_MS)).toBe(7 * HOUR_MS)
  })

  it('is zero for an empty range', () => {
    const t = Date.UTC(2026, 7, 1, 2)
    expect(peakMsBetween(WINDOWS, t, t)).toBe(0)
  })

  it('works across the epoch boundary', () => {
    const from = Date.UTC(1969, 11, 30)
    const to = Date.UTC(1970, 0, 2)
    expect(peakMsBetween(WINDOWS, from, to)).toBe(brute(WINDOWS, from, to))
  })
})

describe('blendrates', () => {
  it('stays inside [off-peak, peak] for a post-cutover window', () => {
    const from = Date.UTC(2026, 8, 1)
    const to = Date.UTC(2026, 9, 1)
    const blended = blendRates(scheduled, from, to).inputCostPerToken
    expect(blended).toBeGreaterThan(10)
    expect(blended).toBeLessThan(20)
  })

  it('weights peak and off-peak by wall-clock time', () => {
    const from = Date.UTC(2026, 8, 1)
    const to = Date.UTC(2026, 8, 2)
    // 7 peak hours at 20, 17 off-peak hours at 10.
    expect(blendRates(scheduled, from, to).inputCostPerToken)
      .toBeCloseTo((7 * 20 + 17 * 10) / 24, 10)
  })

  it('spans an effective date proportionally', () => {
    // Exactly one pre-cutover day at 1, then one post-cutover day whose
    // own blend is the 7/17 split above.
    const from = CUTOVER - DAY_MS
    const to = CUTOVER + DAY_MS
    const postDay = peakMsBetween(WINDOWS, CUTOVER, to)
    const expected = (DAY_MS * 1 + postDay * 20 + (DAY_MS - postDay) * 10) / (2 * DAY_MS)
    expect(blendRates(scheduled, from, to).inputCostPerToken).toBeCloseTo(expected, 10)
  })

  it('caps an unbounded window at a year of lookback', () => {
    const to = Date.UTC(2026, 8, 1)
    expect(blendRates(scheduled, Number.NEGATIVE_INFINITY, to).inputCostPerToken)
      .toBeCloseTo(blendRates(scheduled, to - 365 * DAY_MS, to).inputCostPerToken, 10)
  })

  it('degrades to a point rate for an empty window', () => {
    const t = Date.UTC(2026, 6, 1)
    expect(blendRates(scheduled, t, t).inputCostPerToken).toBe(1)
  })
})

describe('ratesfor', () => {
  it('short-circuits flat schedules regardless of time', () => {
    const result = ratesFor(flat, Date.UTC(2026, 8, 1, 2), undefined)
    expect(result.basis).toBe('flat')
    expect(result.rates.inputCostPerToken).toBe(3)
  })

  it('prices exactly when an instant is known', () => {
    const result = ratesFor(scheduled, Date.UTC(2026, 8, 1, 2), undefined)
    expect(result.basis).toBe('exact')
    expect(result.rates.inputCostPerToken).toBe(20)
  })

  it('blends across a window when the instant is unknown', () => {
    const result = ratesFor(scheduled, undefined, [Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 2)])
    expect(result.basis).toBe('blended')
    expect(result.rates.inputCostPerToken).toBeCloseTo((7 * 20 + 17 * 10) / 24, 10)
  })

  it('uses the injected clock as the open end of a window', () => {
    const now = Date.UTC(2026, 8, 2)
    const result = ratesFor(scheduled, undefined, [Date.UTC(2026, 8, 1), null], now)
    expect(result.rates.inputCostPerToken).toBeCloseTo((7 * 20 + 17 * 10) / 24, 10)
  })
})
