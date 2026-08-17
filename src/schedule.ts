import type { ContextTier, NormalizedSchedule, PriceBasis, PricePeriod, PriceSchedule, RateCard, Rates, TimeInput } from './types'
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
 * What the caller has told us about the *single request* a row describes.
 *
 * Two of the four pricing dimensions are per-request rather than per-moment —
 * how long the prompt was, and whether the request reasoned — and neither can
 * be recovered from a sum. They travel together because they are answers to
 * the same question ("what do we know about this one request?"), are gated by
 * the same caller declaration, and are handled the same way when absent: the
 * base card prices the row, and every card that was not ruled out widens
 * `low`/`high`.
 *
 * A field left `undefined` means the caller did not say — never "no" — which
 * is why `usedReasoning` is a tri-state rather than a plain boolean.
 */
export interface RequestFacts {
  promptTokens?: number
  usedReasoning?: boolean
}

/**
 * Nothing known: an aggregated row, or a caller that never opted in.
 *
 * Exported and shared rather than built per call — this is the majority case,
 * and `estimate` runs once per row, so a fresh `{}` each time would be an
 * allocation to say nothing.
 */
export const NOTHING_KNOWN: RequestFacts = Object.freeze({ promptTokens: undefined, usedReasoning: undefined })

/**
 * Whether any period of this schedule prices by something only a single
 * request can answer — prompt size or thinking mode.
 *
 * Lets callers that memoise a resolution leave those facts out of their key
 * for the ~97% of models priced by neither, where they cannot change the
 * answer.
 */
const PRICES_BY_REQUEST = new WeakMap<PriceSchedule, boolean>()

export function pricesByRequest(schedule: PriceSchedule): boolean {
  // Memoised on the schedule: this is read once per priced row to decide what
  // belongs in a memo key, while being a pure function of a table the
  // catalogue holds for its lifetime. A weak key keeps that bounded by the
  // catalogue rather than by traffic, and — unlike a flag on the object — does
  // not mutate a table `normalizeSchedule` hands back by identity.
  const known = PRICES_BY_REQUEST.get(schedule)
  if (known !== undefined) {
    return known
  }
  let found = false
  for (const period of schedule.periods) {
    if (period.contextTiers?.length || period.reasoningRates) {
      found = true
      break
    }
  }
  PRICES_BY_REQUEST.set(schedule, found)
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
 * A card, or its thinking-mode variant when the request reasoned and the
 * vendor prices that apart.
 *
 * Applied to whichever card the other dimensions already chose, which is what
 * keeps prompt size and thinking mode composing instead of multiplying: each
 * card carries its own variant, so there is never a matrix to enumerate.
 */
function variantOf(card: RateCard, usedReasoning: boolean | undefined): Rates {
  return usedReasoning && card.reasoningRates ? card.reasoningRates : card.rates
}

/**
 * The one card a period resolves to: peak window first, then prompt size,
 * then thinking mode.
 *
 * Peak and the two per-request dimensions never co-occur upstream — no vendor
 * publishes both a peak schedule and either of the others — so peak is an
 * early return rather than another axis.
 */
function cardFor(period: PricePeriod, atMs: number | undefined, facts: RequestFacts): Rates {
  if (atMs !== undefined && period.peak && isPeakHour(period.peak.windowsUtc, atMs)) {
    return period.peak.rates
  }
  return variantOf(contextTierFor(period, facts.promptTokens) ?? period, facts.usedReasoning)
}

/** Exact rate card at one instant. */
export function ratesAt(schedule: NormalizedSchedule, atMs: number, facts: RequestFacts = NOTHING_KNOWN): Rates {
  return cardFor(periodAt(schedule, atMs), atMs, facts)
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
 * The cards a period could still have charged, given what the caller did not
 * state — memoised on the period, and empty when they stated everything.
 *
 * A row the caller has not declared per-request is priced at the base card,
 * which is the right single number — a sum cannot say whether any request
 * inside it crossed a prompt threshold or reasoned. But it is not a
 * certainty*, and reporting `low === high === base` claims one: on a tiered
 * model the same counts can cost nearly twice as much, and on a qwen thinking
 * model over three times. These are the cards those requests would have paid,
 * so the estimate can state the interval instead of hiding it.
 *
 * The base card is deliberately NOT in here. Every caller has already priced
 * it — it is either the card the resolution returned or one of the blend's
 * own parts — so including it would make each of them either recompute a
 * number they hold or trim an element by index, which is a layout of this
 * array leaking into three call sites.
 *
 * Memoised because `ratesFor`'s flat path runs once per priced row while this
 * array is a pure function of the period and of *which* facts are missing.
 * Periods come from tables the catalogue holds for its lifetime, so a weak key
 * is bounded by the catalogue rather than by traffic; the four combinations of
 * missing facts are held per period in one small record.
 */
// Indexed by which facts were left unstated, so the lookup costs no string:
// bit 0 is an open prompt length, bit 1 an open thinking mode.
type UnruledOut = Array<Rates[] | undefined>
const UNRULED_OUT_BY_PERIOD = new WeakMap<PricePeriod, UnruledOut>()

function unruledOutCards(period: PricePeriod, facts: RequestFacts): Rates[] | undefined {
  const openPrompt = facts.promptTokens === undefined && !!period.contextTiers?.length
  // A caller who says nothing about reasoning leaves the variant open; one who
  // says `false` has ruled it out, and one who says `true` is already paying
  // it. Only the first is uncertainty.
  const openReasoning = facts.usedReasoning === undefined
  if (!openPrompt && !openReasoning) {
    return undefined
  }
  const key = (openPrompt ? 1 : 0) | (openReasoning ? 2 : 0)
  let cache = UNRULED_OUT_BY_PERIOD.get(period)
  if (!cache) {
    cache = [undefined, undefined, undefined, undefined]
    UNRULED_OUT_BY_PERIOD.set(period, cache)
  }
  let cards = cache[key]
  if (!cards) {
    cards = []
    // Every card reachable under the open facts, minus the base card the
    // caller already priced. With the prompt open that is each tier; with
    // reasoning open it is each of those cards' thinking variants too.
    const reachable: RateCard[] = openPrompt ? [period, ...period.contextTiers!] : [period]
    for (const card of reachable) {
      if (card !== period) {
        cards.push(card.rates)
      }
      if (openReasoning && card.reasoningRates) {
        cards.push(card.reasoningRates)
      }
    }
    cache[key] = cards
  }
  return cards.length > 0 ? cards : undefined
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
  facts: RequestFacts = NOTHING_KNOWN,
): Array<{ rates: Rates, weight: number }> {
  const start = blendStart(fromMs, toMs)
  if (!(toMs > start)) {
    return [{ rates: ratesAt(schedule, start, facts), weight: 1 }]
  }
  // `parts` is never empty: the first period opens at -Infinity and
  // `toMs > start` was checked above, so at least one segment has span.
  return partsFor(weightedPeriods(schedule, start, toMs), facts)
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
  facts: RequestFacts,
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
      // single card the request's own facts select.
      parts.push({ rates: variantOf(contextTierFor(period, facts.promptTokens) ?? period, facts.usedReasoning), weight: span })
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
export function blendRates(schedule: NormalizedSchedule, fromMs: number, toMs: number, facts?: RequestFacts): Rates {
  return weightedRates(blendParts(schedule, fromMs, toMs, facts))
}

const FLAT_RESOLUTION = new WeakMap<PricePeriod, ResolvedRates>()

/**
 * Build a `ResolvedRates` with every field present, in one order.
 *
 * One shape across every return site, so the fields `estimate` and
 * `priceCardFor` read once per row are a monomorphic load rather than four
 * hidden classes. Costs nothing either way, and it keeps the four sites from
 * drifting apart.
 */
function resolved(
  rates: Rates,
  basis: PriceBasis,
  cards: Rates[] | undefined,
  tierAbove: number | undefined,
  reasoningMode: boolean | undefined,
): ResolvedRates {
  return { rates, basis, cards, tierAbove, reasoningMode }
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
   * off-peak ends of a window), or the caller left one of the per-request
   * facts unstated on a model priced by it, so a long or reasoning request
   * inside the row would have paid a dearer card — see `unruledOutCards`.
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
  /** Whether the card returned is a thinking-mode variant. */
  reasoningMode?: boolean
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
  facts: RequestFacts = NOTHING_KNOWN,
): ResolvedRates {
  if (!isTimeSensitive(schedule)) {
    // Flat in time, which is nearly every model — but not necessarily flat
    // in prompt size, so the tier still has to be selected here. `basis`
    // stays 'flat': it describes how the *time* axis was resolved, and a
    // tiered flat schedule is still exact rather than averaged.
    const period = schedule.periods[0]!
    // Ahead of everything else, because this is the hottest line in the
    // package: ~97% of models are priced by neither per-request dimension,
    // and for those nothing below can change the answer. Returning here keeps
    // them on the same two-property result they had before either existed.
    if (!period.contextTiers?.length && !period.reasoningRates) {
      // Memoised, not built: for a schedule that is flat in time and priced by
      // neither per-request dimension — ~97% of models, and the hottest path in
      // the package — this result is a pure function of the period and cannot
      // vary by row. `estimate` only reads it, so one instance is shared.
      let only = FLAT_RESOLUTION.get(period)
      if (!only) {
        only = resolved(period.rates, 'flat', undefined, undefined, undefined)
        FLAT_RESOLUTION.set(period, only)
      }
      return only
    }
    return resolveCard(period, undefined, 'flat', facts)
  }
  const atMs = toMs(at)
  if (atMs !== null) {
    return exactAt(schedule, atMs, facts)
  }
  const from = window ? toMs(window[0]) : null
  const until = window ? toMs(window[1]) : null
  // Saying nothing about time is not the same as asking for an unbounded
  // window. A caller who supplied neither gets the rate in force now — the
  // same answer `getPrice(model)` gives — instead of an average over the
  // last 365 days, which under-charges any model whose price has since
  // risen and made the two entry points disagree on the same row.
  if (from === null && until === null) {
    return exactAt(schedule, now, facts)
  }
  const begin = from ?? Number.NEGATIVE_INFINITY
  const end = until ?? now
  // A window is an interval, not an ordered pair of arguments. Reversed, it
  // still names the same interval; zero-width, it names an instant and
  // there is nothing to average.
  if (begin === end) {
    return exactAt(schedule, begin, facts)
  }
  // A window is an interval, not an ordered pair, so normalise it before
  // blending rather than duplicating the call.
  const [lo, hi] = begin > end ? [end, begin] : [begin, end]
  // One walk, three consumers — see `partsFor`.
  const segments = weightedPeriods(schedule, blendStart(lo, hi), hi)
  const parts = partsFor(segments, facts)
  const cards: Rates[] = []
  for (const part of parts) {
    // Zero-weight segments never influenced the average, so they must not
    // widen the interval either — a period the window merely touches the
    // boundary of is not a price this row could have paid.
    if (part.weight > 0) {
      cards.push(part.rates)
    }
  }
  for (const { period } of segments) {
    const unruled = unruledOutCards(period, facts)
    if (unruled) {
      cards.push(...unruled)
    }
  }
  return resolved(
    weightedRates(parts),
    'blended',
    cards,
    // Both claims hold only when every weighted segment agrees — a window
    // spanning the day a premium was withdrawn averages a card that belongs
    // to neither side, and naming one would be a lie about what was applied.
    facts.promptTokens === undefined ? undefined : blendedTierAbove(segments, facts.promptTokens),
    blendedReasoningMode(segments, facts),
  )
}

/**
 * One period resolved to one card, with what that card claims to be.
 *
 * Shared by the flat path and `exactAt`, which differ only in whether a peak
 * window can apply: they were the same three questions asked twice, and a rule
 * added to one of them would have quietly missed the other.
 */
function resolveCard(
  period: PricePeriod,
  atMs: number | undefined,
  basis: PriceBasis,
  facts: RequestFacts,
): ResolvedRates {
  const rates = cardFor(period, atMs, facts)
  const tier = contextTierFor(period, facts.promptTokens)
  return resolved(
    rates,
    basis,
    // Knowing *when* the tokens were spent says nothing about how long the
    // prompt was or whether the request reasoned, so an instant bounds those
    // exactly as a flat schedule does.
    unruledOutCards(period, facts),
    tier?.abovePromptTokens,
    rates === (tier ?? period).reasoningRates ? true : undefined,
  )
}

/** The one card in force at an instant, plus what it claims to be. */
function exactAt(schedule: NormalizedSchedule, atMs: number, facts: RequestFacts): ResolvedRates {
  return resolveCard(periodAt(schedule, atMs), atMs, 'exact', facts)
}

/**
 * Whether every weighted segment charged the thinking variant, so a blend can
 * honestly say it was applied.
 */
function blendedReasoningMode(
  segments: Array<{ period: PricePeriod }>,
  facts: RequestFacts,
): boolean | undefined {
  if (!facts.usedReasoning) {
    return undefined
  }
  for (const { period } of segments) {
    if (!(contextTierFor(period, facts.promptTokens) ?? period).reasoningRates) {
      return undefined
    }
  }
  return true
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
