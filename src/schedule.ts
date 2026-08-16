import type { NormalizedSchedule, PriceBasis, PricePeriod, PriceSchedule, Rates, TimeInput } from './types'
import { weightedRates } from './rates'
import { DAY_MS, HOUR_MS } from './types'

export function toMs(value: TimeInput): number | null {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  const ms = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/**
 * A schedule is time-sensitive when *when* the tokens were spent changes
 * what they cost: more than one effective period, or any peak window.
 *
 * Called once per priced row, so it stays allocation-free (no closure).
 */
export function isTimeSensitive(schedule: PriceSchedule): boolean {
  if (schedule.periods.length > 1) {
    return true
  }
  for (const period of schedule.periods) {
    if (period.peak) {
      return true
    }
  }
  return false
}

export function periodAt(schedule: NormalizedSchedule, atMs: number): PricePeriod {
  let current = schedule.periods[0]!
  for (const period of schedule.periods) {
    if (period.from <= atMs) {
      current = period
    }
    else {
      break
    }
  }
  return current
}

export function isPeakHour(windows: Array<[number, number]>, atMs: number): boolean {
  // Epoch ms floors to UTC midnight without any timezone lookup, which is
  // exactly what the windows are defined against.
  const hour = Math.floor((atMs - Math.floor(atMs / DAY_MS) * DAY_MS) / HOUR_MS)
  return windows.some(([start, end]) => hour >= start && hour < end)
}

/** Exact rate card at one instant. */
export function ratesAt(schedule: NormalizedSchedule, atMs: number): Rates {
  const period = periodAt(schedule, atMs)
  if (period.peak && isPeakHour(period.peak.windowsUtc, atMs)) {
    return period.peak.rates
  }
  return period.rates
}

/**
 * Milliseconds of one daily UTC window that fall in [epoch, x). Closed
 * form: whole elapsed days each contribute the window's full length, and
 * the partial last day contributes however much of it has elapsed.
 */
function dailyWindowMsUpTo(x: number, startMs: number, lengthMs: number): number {
  const days = Math.floor(x / DAY_MS)
  const intoDay = x - days * DAY_MS
  return days * lengthMs + Math.min(Math.max(intoDay - startMs, 0), lengthMs)
}

/**
 * Milliseconds of [from, to) that land inside a daily UTC peak window.
 *
 * O(windows) — differencing the two prefix sums beats walking the range a
 * day at a time, which cost ~730 iterations for a year-long window.
 */
export function peakMsBetween(windows: Array<[number, number]>, fromMs: number, toMs: number): number {
  let total = 0
  for (const [start, end] of windows) {
    const startMs = start * HOUR_MS
    const lengthMs = (end - start) * HOUR_MS
    total += dailyWindowMsUpTo(toMs, startMs, lengthMs) - dailyWindowMsUpTo(fromMs, startMs, lengthMs)
  }
  return total
}

/**
 * Degraded path: the row is a sum over a whole window, so we no longer know
 * which hours its tokens were spent in. Blend the schedule across the
 * window by wall-clock time — i.e. assume usage is spread evenly. That is
 * wrong for a user who only ever codes during peak hours, but it is
 * bounded (never outside [off-peak, peak]) and it is the honest answer when
 * the time axis has already been aggregated away. Callers that *do* have a
 * timestamp pass `at` instead and get the exact rate.
 */
/**
 * The rate cards a blend draws on, with the wall-clock weight each carries.
 *
 * Separate from `blendRates` because the weighted average throws away the
 * one thing that says how rough it is: the cards it averaged. Keeping them
 * is what lets an estimate report the interval its true cost must lie in.
 */
export function blendParts(
  schedule: NormalizedSchedule,
  fromMs: number,
  toMs: number,
): Array<{ rates: Rates, weight: number }> {
  // An unbounded (all-time) window would give ancient rates unbounded
  // weight; a year of lookback is enough for any live schedule.
  const start = Number.isFinite(fromMs) ? fromMs : toMs - 365 * DAY_MS
  if (!(toMs > start)) {
    return [{ rates: ratesAt(schedule, start), weight: 1 }]
  }
  const parts: Array<{ rates: Rates, weight: number }> = []
  const periods = schedule.periods
  for (let i = 0; i < periods.length; i++) {
    const period = periods[i]!
    const next = periods[i + 1]
    const segStart = Math.max(start, period.from)
    const segEnd = Math.min(toMs, next ? next.from : Number.POSITIVE_INFINITY)
    if (!(segEnd > segStart)) {
      continue
    }
    const span = segEnd - segStart
    if (period.peak) {
      const peakMs = peakMsBetween(period.peak.windowsUtc, segStart, segEnd)
      parts.push({ rates: period.peak.rates, weight: peakMs }, { rates: period.rates, weight: span - peakMs })
    }
    else {
      parts.push({ rates: period.rates, weight: span })
    }
  }
  // `parts` is never empty: the first period opens at -Infinity and
  // `toMs > start` was checked above, so at least one segment has span.
  return parts
}

export function blendRates(schedule: NormalizedSchedule, fromMs: number, toMs: number): Rates {
  return weightedRates(blendParts(schedule, fromMs, toMs))
}

/**
 * Resolve a schedule to the one flat rate card that applies, either at an
 * instant (`at`) or averaged across a window. Both are ignored for models
 * with a flat schedule, which is nearly all of them.
 *
 * `cards` is populated only for a blend, and holds the distinct cards that
 * went into it — the material for a cost interval. Every other path priced
 * against exactly one card and has nothing to bound.
 */
export function ratesFor(
  schedule: NormalizedSchedule,
  at: TimeInput,
  window: readonly [TimeInput, TimeInput] | undefined,
  now: number = Date.now(),
): { rates: Rates, basis: PriceBasis, cards?: Rates[] } {
  if (!isTimeSensitive(schedule)) {
    return { rates: schedule.periods[0]!.rates, basis: 'flat' }
  }
  const atMs = toMs(at)
  if (atMs !== null) {
    return { rates: ratesAt(schedule, atMs), basis: 'exact' }
  }
  const from = window ? toMs(window[0]) : null
  const until = window ? toMs(window[1]) : null
  // Saying nothing about time is not the same as asking for an unbounded
  // window. A caller who supplied neither gets the rate in force now — the
  // same answer `getPrice(model)` gives — instead of an average over the
  // last 365 days, which under-charges any model whose price has since
  // risen and made the two entry points disagree on the same row.
  if (from === null && until === null) {
    return { rates: ratesAt(schedule, now), basis: 'exact' }
  }
  const begin = from ?? Number.NEGATIVE_INFINITY
  const end = until ?? now
  // A window is an interval, not an ordered pair of arguments. Reversed, it
  // still names the same interval; zero-width, it names an instant and
  // there is nothing to average.
  if (begin === end) {
    return { rates: ratesAt(schedule, begin), basis: 'exact' }
  }
  // A window is an interval, not an ordered pair, so normalise it before
  // blending rather than duplicating the call.
  const [lo, hi] = begin > end ? [end, begin] : [begin, end]
  const parts = blendParts(schedule, lo, hi)
  return {
    rates: weightedRates(parts),
    basis: 'blended',
    // Zero-weight segments never influenced the average, so they must not
    // widen the interval either — a period the window merely touches the
    // boundary of is not a price this row could have paid.
    cards: parts.filter(part => part.weight > 0).map(part => part.rates),
  }
}
