import type { ContextTier, NormalizedSchedule, PriceBasis, PricePeriod, PriceSchedule, Rates, TimeInput } from './types'
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

/**
 * Whether any period of this schedule prices by prompt size at all.
 *
 * Lets callers that memoise a resolution leave prompt length out of their
 * key for the ~97% of models with no tiers, where it cannot change the
 * answer.
 */
export function hasContextTiers(schedule: PriceSchedule): boolean {
  for (const period of schedule.periods) {
    if (period.contextTiers && period.contextTiers.length > 0) {
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

/**
 * The tier a prompt of `promptTokens` falls in, or null for the base card.
 *
 * `undefined` promptTokens means the caller did not state that this row is
 * one request, so no tier can be selected — see `EstimateArgs.perRequest`.
 * Ascending order is a `normalizeSchedule` invariant, so the last match is
 * the highest one cleared.
 */
export function contextTierFor(period: PricePeriod, promptTokens: number | undefined): ContextTier | null {
  if (promptTokens === undefined || !period.contextTiers) {
    return null
  }
  let hit: ContextTier | null = null
  for (const tier of period.contextTiers) {
    if (promptTokens > tier.abovePromptTokens) {
      hit = tier
    }
    else {
      break
    }
  }
  return hit
}

/**
 * The one card a period resolves to: peak window first, then prompt size.
 *
 * The two never co-occur (`normalizeSchedule` enforces it), so this is a
 * pair of independent branches rather than a matrix.
 */
function cardFor(period: PricePeriod, atMs: number | undefined, promptTokens: number | undefined): Rates {
  if (atMs !== undefined && period.peak && isPeakHour(period.peak.windowsUtc, atMs)) {
    return period.peak.rates
  }
  return contextTierFor(period, promptTokens)?.rates ?? period.rates
}

/** Exact rate card at one instant. */
export function ratesAt(schedule: NormalizedSchedule, atMs: number, promptTokens?: number): Rates {
  return cardFor(periodAt(schedule, atMs), atMs, promptTokens)
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
 * The effective start of a blend window. An unbounded (all-time) one would
 * give ancient rates unbounded weight; a year of lookback is enough for any
 * live schedule.
 */
function blendStart(fromMs: number, toMs: number): number {
  return Number.isFinite(fromMs) ? fromMs : toMs - 365 * DAY_MS
}

/**
 * The periods a window draws on, each clipped to it.
 *
 * Shared by everything that reasons about a blend — the rate parts, the tier
 * claim, the bound cards. Three independent walks of the same overlap
 * arithmetic were three chances to disagree about which periods a window
 * actually touched, and a disagreement there is silent: the blend would
 * average one set of periods while the tier claim spoke for another.
 */
function weightedPeriods(
  schedule: NormalizedSchedule,
  startMs: number,
  toMs: number,
): Array<{ period: PricePeriod, from: number, to: number }> {
  const out: Array<{ period: PricePeriod, from: number, to: number }> = []
  const periods = schedule.periods
  for (let i = 0; i < periods.length; i++) {
    const period = periods[i]!
    const next = periods[i + 1]
    const from = Math.max(startMs, period.from)
    const to = Math.min(toMs, next ? next.from : Number.POSITIVE_INFINITY)
    if (to > from) {
      out.push({ period, from, to })
    }
  }
  return out
}

/**
 * Bound cards for a period whose prompt length was never stated, memoised on
 * the period.
 *
 * A row the caller has not declared per-request is priced at the base card,
 * which is the right single number — a sum cannot say whether any request
 * inside it crossed a threshold. But it is not a *certainty*, and reporting
 * `low === high === base` claims one: on a tiered model the same counts can
 * cost nearly twice as much. These are the cards those requests would have
 * paid, so the estimate can state the interval instead of hiding it.
 *
 * Memoised because `ratesFor`'s flat path runs once per priced row while this
 * array is a pure function of the period. Periods come from tables the
 * catalogue holds for its lifetime, so a weak key is bounded by the
 * catalogue rather than by traffic.
 */
const BOUNDS_BY_PERIOD = new WeakMap<PricePeriod, Rates[]>()

function tierBounds(period: PricePeriod, promptTokens: number | undefined): Rates[] | undefined {
  // A stated prompt length selects one card and rules the rest out; there is
  // nothing left to bound.
  if (promptTokens !== undefined || !period.contextTiers) {
    return undefined
  }
  let bounds = BOUNDS_BY_PERIOD.get(period)
  if (!bounds) {
    bounds = [period.rates, ...period.contextTiers.map(tier => tier.rates)]
    BOUNDS_BY_PERIOD.set(period, bounds)
  }
  return bounds
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
  promptTokens?: number,
): Array<{ rates: Rates, weight: number }> {
  const start = blendStart(fromMs, toMs)
  if (!(toMs > start)) {
    return [{ rates: ratesAt(schedule, start, promptTokens), weight: 1 }]
  }
  const parts: Array<{ rates: Rates, weight: number }> = []
  for (const { period, from, to } of weightedPeriods(schedule, start, toMs)) {
    const span = to - from
    if (period.peak) {
      const peakMs = peakMsBetween(period.peak.windowsUtc, from, to)
      parts.push({ rates: period.peak.rates, weight: peakMs }, { rates: period.rates, weight: span - peakMs })
    }
    else {
      // A period with tiers has no peak, so its whole span pays whichever
      // single card the prompt selects.
      parts.push({ rates: contextTierFor(period, promptTokens)?.rates ?? period.rates, weight: span })
    }
  }
  // `parts` is never empty: the first period opens at -Infinity and
  // `toMs > start` was checked above, so at least one segment has span.
  return parts
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
export function blendRates(schedule: NormalizedSchedule, fromMs: number, toMs: number, promptTokens?: number): Rates {
  return weightedRates(blendParts(schedule, fromMs, toMs, promptTokens))
}

/**
 * A schedule resolved to one rate card, with how that was arrived at.
 *
 * Named because three places hold it: `ratesFor` returns it, and the
 * catalogue both stores and returns it.
 */
export interface ResolvedRates {
  rates: Rates
  basis: PriceBasis
  /**
   * The distinct cards this cost could have been charged at — the material
   * for a cost interval, not a claim that any of them was applied.
   *
   * Two things put a card in here. A blend averaged it (the peak and
   * off-peak ends of a window), or the caller left the prompt length
   * unstated on a model that prices by it, so a long request inside the row
   * would have paid a tier — see `tierBounds`.
   *
   * Absent when the resolution really did have exactly one possible card,
   * which is nearly every row.
   */
  cards?: Rates[]
  /**
   * The long-context threshold this resolution crossed, when it crossed
   * one. On a blend, set only when every segment that carried weight landed
   * in the same tier — otherwise the averaged card belongs to no single
   * tier and claiming one would be a lie about which rate was applied.
   */
  tierAbove?: number
}

/**
 * Resolve a schedule to the one flat rate card that applies, either at an
 * instant (`at`) or averaged across a window. Both are ignored for models
 * with a flat schedule, which is nearly all of them.
 */
export function ratesFor(
  schedule: NormalizedSchedule,
  at: TimeInput,
  window: readonly [TimeInput, TimeInput] | undefined,
  now: number = Date.now(),
  promptTokens?: number,
): ResolvedRates {
  if (!isTimeSensitive(schedule)) {
    // Flat in time, which is nearly every model — but not necessarily flat
    // in prompt size, so the tier still has to be selected here. `basis`
    // stays 'flat': it describes how the *time* axis was resolved, and a
    // tiered flat schedule is still exact rather than averaged.
    const period = schedule.periods[0]!
    const tier = contextTierFor(period, promptTokens)
    return tier
      ? { rates: tier.rates, basis: 'flat', tierAbove: tier.abovePromptTokens }
      // `cards` rather than nothing when the prompt length was never stated:
      // the base card is the estimate, but a tier was not ruled out.
      : { rates: period.rates, basis: 'flat', cards: tierBounds(period, promptTokens) }
  }
  const atMs = toMs(at)
  if (atMs !== null) {
    return exactAt(schedule, atMs, promptTokens)
  }
  const from = window ? toMs(window[0]) : null
  const until = window ? toMs(window[1]) : null
  // Saying nothing about time is not the same as asking for an unbounded
  // window. A caller who supplied neither gets the rate in force now — the
  // same answer `getPrice(model)` gives — instead of an average over the
  // last 365 days, which under-charges any model whose price has since
  // risen and made the two entry points disagree on the same row.
  if (from === null && until === null) {
    return exactAt(schedule, now, promptTokens)
  }
  const begin = from ?? Number.NEGATIVE_INFINITY
  const end = until ?? now
  // A window is an interval, not an ordered pair of arguments. Reversed, it
  // still names the same interval; zero-width, it names an instant and
  // there is nothing to average.
  if (begin === end) {
    return exactAt(schedule, begin, promptTokens)
  }
  // A window is an interval, not an ordered pair, so normalise it before
  // blending rather than duplicating the call.
  const [lo, hi] = begin > end ? [end, begin] : [begin, end]
  const parts = blendParts(schedule, lo, hi, promptTokens)
  const segments = weightedPeriods(schedule, blendStart(lo, hi), hi)
  return {
    rates: weightedRates(parts),
    basis: 'blended',
    cards: [
      // Zero-weight segments never influenced the average, so they must not
      // widen the interval either — a period the window merely touches the
      // boundary of is not a price this row could have paid.
      ...parts.filter(part => part.weight > 0).map(part => part.rates),
      // ...and, when the prompt length was never stated, the tiers of every
      // period the window did draw on.
      ...segments.flatMap(({ period }) => tierBounds(period, promptTokens)?.slice(1) ?? []),
    ],
    tierAbove: blendedTierAbove(segments, promptTokens),
  }
}

/** The one card in force at an instant, plus which tier produced it. */
function exactAt(schedule: NormalizedSchedule, atMs: number, promptTokens: number | undefined): ResolvedRates {
  const period = periodAt(schedule, atMs)
  return {
    rates: cardFor(period, atMs, promptTokens),
    basis: 'exact',
    tierAbove: contextTierFor(period, promptTokens)?.abovePromptTokens,
    // Knowing *when* the tokens were spent says nothing about how long the
    // prompt was, so an exact instant bounds its tiers exactly as a flat
    // schedule does.
    cards: tierBounds(period, promptTokens),
  }
}

/**
 * The tier a blended card can honestly claim: the common one, or none.
 *
 * A window spanning the day Anthropic withdrew its >200k premium averages a
 * tiered period with an untiered one, and the result is neither. Reporting
 * the tier there would name a rate the row did not pay.
 */
function blendedTierAbove(
  segments: Array<{ period: PricePeriod }>,
  promptTokens: number | undefined,
): number | undefined {
  if (promptTokens === undefined) {
    return undefined
  }
  let common: number | undefined
  let first = true
  // Reads the segments `blendParts` weighted, so the two cannot disagree
  // about which periods carried weight — a period given none cannot veto
  // the tier.
  for (const { period } of segments) {
    const tier = contextTierFor(period, promptTokens)?.abovePromptTokens
    if (first) {
      common = tier
      first = false
    }
    else if (common !== tier) {
      return undefined
    }
  }
  return common
}
