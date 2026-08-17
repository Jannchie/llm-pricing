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
const HAS_TIERS = new WeakMap<PriceSchedule, boolean>()

export function hasContextTiers(schedule: PriceSchedule): boolean {
  // Memoised on the schedule: this is read once per priced row to decide
  // whether prompt length belongs in a memo key, while being a pure function
  // of a table the catalogue holds for its lifetime. A weak key keeps that
  // bounded by the catalogue rather than by traffic, and — unlike a flag on
  // the object — does not mutate a table `normalizeSchedule` hands back by
  // identity.
  const known = HAS_TIERS.get(schedule)
  if (known !== undefined) {
    return known
  }
  let found = false
  for (const period of schedule.periods) {
    if (period.contextTiers && period.contextTiers.length > 0) {
      found = true
      break
    }
  }
  HAS_TIERS.set(schedule, found)
  return found
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
 * The tier cards a period could still have charged, memoised on the period —
 * empty unless the caller left the prompt length unstated.
 *
 * A row the caller has not declared per-request is priced at the base card,
 * which is the right single number — a sum cannot say whether any request
 * inside it crossed a threshold. But it is not a *certainty*, and reporting
 * `low === high === base` claims one: on a tiered model the same counts can
 * cost nearly twice as much. These are the cards those requests would have
 * paid, so the estimate can state the interval instead of hiding it.
 *
 * The base card is deliberately NOT in here. Every caller has already priced
 * it — it is either the card the resolution returned or one of the blend's
 * own parts — so including it would make each of them either recompute a
 * number they hold or trim an element by index, which is a layout of this
 * array leaking into three call sites.
 *
 * Memoised because `ratesFor`'s flat path runs once per priced row while this
 * array is a pure function of the period. Periods come from tables the
 * catalogue holds for its lifetime, so a weak key is bounded by the
 * catalogue rather than by traffic.
 */
const TIER_CARDS_BY_PERIOD = new WeakMap<PricePeriod, Rates[]>()

function tierCards(period: PricePeriod, promptTokens: number | undefined): Rates[] | undefined {
  // A stated prompt length selects one card and rules the rest out; there is
  // nothing left to bound.
  if (promptTokens !== undefined || !period.contextTiers?.length) {
    return undefined
  }
  let cards = TIER_CARDS_BY_PERIOD.get(period)
  if (!cards) {
    cards = period.contextTiers.map(tier => tier.rates)
    TIER_CARDS_BY_PERIOD.set(period, cards)
  }
  return cards
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
  // `parts` is never empty: the first period opens at -Infinity and
  // `toMs > start` was checked above, so at least one segment has span.
  return partsFor(weightedPeriods(schedule, start, toMs), promptTokens)
}

/**
 * The weighted cards a set of already-clipped segments pays.
 *
 * Split from `blendParts` so `ratesFor` can walk the periods once and feed
 * the same segments to all three things that need them — the weights, the
 * tier claim, and the bound cards. Passing the walk around rather than
 * repeating it is what actually makes them agree; two calls with matching
 * arguments only makes them agree today.
 */
function partsFor(
  segments: Array<{ period: PricePeriod, from: number, to: number }>,
  promptTokens: number | undefined,
): Array<{ rates: Rates, weight: number }> {
  const parts: Array<{ rates: Rates, weight: number }> = []
  for (const { period, from, to } of segments) {
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
   *
   * The invariant a consumer may rely on, whichever source filled it:
   * `min(cards ∪ {cost}) <= cost <= max(cards ∪ {cost})`. Note it does not
   * assume a tier is dearer than its base — two upstream listings quote one
   * that is cheaper on output, and those land on the `low` side by
   * themselves.
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
    // Ahead of everything else, because this is the hottest line in the
    // package: ~97% of models have no tiers, and for those the whole prompt
    // dimension cannot change the answer. Returning here keeps them on the
    // same two-property result they had before tiers existed.
    if (!period.contextTiers?.length) {
      return { rates: period.rates, basis: 'flat' }
    }
    const tier = contextTierFor(period, promptTokens)
    return tier
      ? { rates: tier.rates, basis: 'flat', tierAbove: tier.abovePromptTokens }
      // `cards` rather than nothing when the prompt length was never stated:
      // the base card is the estimate, but a tier was not ruled out.
      : { rates: period.rates, basis: 'flat', cards: tierCards(period, promptTokens) }
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
  // One walk, three consumers — see `partsFor`.
  const segments = weightedPeriods(schedule, blendStart(lo, hi), hi)
  const parts = partsFor(segments, promptTokens)
  const cards: Rates[] = []
  for (const part of parts) {
    // Zero-weight segments never influenced the average, so they must not
    // widen the interval either — a period the window merely touches the
    // boundary of is not a price this row could have paid.
    if (part.weight > 0) {
      cards.push(part.rates)
    }
  }
  // The two halves below are mutually exclusive by construction: a stated
  // prompt length selects one tier and leaves nothing to bound, an unstated
  // one bounds every tier and lets no card claim to be the one applied.
  let tierAbove: number | undefined
  if (promptTokens === undefined) {
    for (const { period } of segments) {
      const tiers = tierCards(period, promptTokens)
      if (tiers) {
        cards.push(...tiers)
      }
    }
  }
  else {
    tierAbove = blendedTierAbove(segments, promptTokens)
  }
  return { rates: weightedRates(parts), basis: 'blended', cards, tierAbove }
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
    cards: tierCards(period, promptTokens),
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
  promptTokens: number,
): number | undefined {
  // Reads the segments `partsFor` weighted, so the two cannot disagree about
  // which periods carried weight — a period given none cannot veto the tier.
  const first = segments[0]
  if (!first) {
    return undefined
  }
  // Seeded from the first segment rather than tracked with a flag, because
  // `undefined` is itself a legal answer ("this period has no tier") and so
  // cannot double as "nothing read yet".
  const common = contextTierFor(first.period, promptTokens)?.abovePromptTokens
  for (let i = 1; i < segments.length; i++) {
    if (contextTierFor(segments[i]!.period, promptTokens)?.abovePromptTokens !== common) {
      return undefined
    }
  }
  return common
}
