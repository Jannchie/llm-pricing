import type { NormalizedSchedule, PricePeriod, PriceSchedule } from './types'
import { isTimeSensitive } from './schedule'
import { RATE_KEYS } from './types'

/**
 * The first rate on this schedule that cannot be billed, or null.
 *
 * A rate has to be finite and non-negative to mean anything. Neither
 * failure is hypothetical:
 *
 * - **Negative.** OpenRouter quotes `-1` on the meta-models it prices only
 *   at request time (`openrouter/auto` and friends). A negative rate does
 *   not merely mis-price its own model — summed into a total it credits
 *   back every other model's cost, so one unpriceable id can carry a whole
 *   account below zero. Both catalogue adapters now reject these at parse
 *   time; this catches the same value arriving through `overrides` or
 *   `fallback`, which are caller-supplied and not under this package's
 *   control.
 * - **NaN / Infinity.** One such rate propagates through every sum it
 *   reaches, so a single bad card turns an entire aggregate into NaN —
 *   which loses more than a wrong number would. `costFromRates` already
 *   guards its token counts this way; rates deserve the same.
 */
function unbillableRate(schedule: PriceSchedule): string | null {
  for (const period of schedule.periods) {
    for (const rates of [period.rates, period.peak?.rates, ...(period.contextTiers ?? []).map(tier => tier.rates)]) {
      if (!rates) {
        continue
      }
      for (const key of RATE_KEYS) {
        const value = rates[key]
        if (!Number.isFinite(value) || value < 0) {
          return `${key}=${value}`
        }
      }
    }
  }
  return null
}

/**
 * Bring a schedule to the shape the pricing primitives assume, or reject it.
 *
 * Schedules arrive from three places — the bundled tables, a parsed remote
 * catalogue, and whatever a caller passes as `overrides`/`fallback` — and
 * only the first is under this package's control. The primitives are hot
 * (`periodAt` runs per priced row) so they check nothing; this runs once,
 * at ingest, and is where the assumptions get enforced.
 *
 * Returns null for a schedule that cannot price anything, so the caller can
 * drop it rather than throw on the first lookup.
 */
export function normalizeSchedule(
  schedule: PriceSchedule,
  onWarn?: (message: string, error: unknown) => void,
  id?: string,
): NormalizedSchedule | null {
  // Ahead of the fast path below, because a schedule that cannot be billed
  // is exactly the shape that path returns untouched. Cost is one pass over
  // at most a handful of rate cards, once per schedule at ingest — never
  // per priced row.
  const unbillable = unbillableRate(schedule)
  if (unbillable !== null) {
    onWarn?.(`schedule "${id ?? schedule.displayName ?? '?'}" quotes an unbillable rate (${unbillable}) and was dropped`, undefined)
    return null
  }

  // One period and no peak describes essentially every model in the
  // catalogue — nothing to sort and no window to check, so return the
  // schedule itself. Worth the branch: this runs over the whole bundled
  // table on construction and over every parsed remote entry on each load,
  // and rebuilding all of them would allocate a second copy of a table that
  // is otherwise shared by identity.
  const only = schedule.periods.length === 1 ? schedule.periods[0] : undefined
  if (only && !only.peak && only.from === Number.NEGATIVE_INFINITY) {
    // Tiers still have to pass their own gate — a flat-in-time schedule is
    // exactly the shape most tiered models have (gpt-5.5, Gemini 2.5 Pro),
    // so skipping them here would leave the hot path reading an unsorted
    // list. `normalizeTiers` returns the period by identity when there is
    // nothing to fix, which keeps the table shared rather than copied.
    const gated = normalizeTiers(only, onWarn, id)
    warnIfUnanchored(schedule, onWarn, id)
    return (gated === only ? schedule : { ...schedule, periods: [gated] }) as NormalizedSchedule
  }

  const usable = schedule.periods.filter(period => !Number.isNaN(period.from))
  if (usable.length === 0) {
    onWarn?.(`schedule "${id ?? schedule.displayName ?? '?'}" has no usable periods and was dropped`, undefined)
    return null
  }

  // `periodAt` walks the list and stops at the first period starting later
  // than the instant asked for, so an out-of-order list returns the wrong
  // era's rate — silently, and only for the models that have history.
  // Sorted in place: `filter` above already made this array ours.
  usable.sort((a, b) => a.from - b.from)

  const periods: PricePeriod[] = usable.map((period) => {
    if (!period.peak) {
      return normalizeTiers(period, onWarn, id)
    }
    const windowsUtc = normalizeWindows(period.peak.windowsUtc)
    // Every window was nonsense: the period simply has no peak — which also
    // means its tiers are no longer in conflict and can be kept.
    return windowsUtc.length === 0
      ? normalizeTiers({ from: period.from, rates: period.rates, contextTiers: period.contextTiers }, onWarn, id)
      : normalizeTiers({ ...period, peak: { ...period.peak, windowsUtc } }, onWarn, id)
  })

  // The first period must open at -Infinity. `periodAt` already falls back
  // to it for any earlier instant, but `blendRates` clips each period to the
  // window and is left with nothing to average — it throws rather than
  // returning a price, and its own comment says that cannot happen. Opening
  // the earliest known rate at -Infinity makes the two agree, and it is the
  // only defensible answer for a row that predates the schedule: any other
  // invents a price nobody quoted.
  const first = periods[0]!
  if (first.from !== Number.NEGATIVE_INFINITY) {
    onWarn?.(
      `schedule "${id ?? schedule.displayName ?? '?'}" begins at ${new Date(first.from).toISOString()}; opening it at -infinity so earlier rows still price`,
      undefined,
    )
    periods[0] = { ...first, from: Number.NEGATIVE_INFINITY }
  }

  const result = { ...schedule, periods } as NormalizedSchedule
  warnIfUnanchored(result, onWarn, id)
  return result
}

/**
 * A time-sensitive schedule with no `sqlMatch` still prices correctly when
 * the caller passes `at`, but the query layer is never told to split its rows
 * by hour, so in practice they all blend. The type says the field is
 * required; this is what says so at runtime.
 */
function warnIfUnanchored(
  schedule: PriceSchedule,
  onWarn: ((message: string, error: unknown) => void) | undefined,
  id: string | undefined,
): void {
  if (!onWarn || !isTimeSensitive(schedule) || schedule.sqlMatch?.length) {
    return
  }
  onWarn(
    `schedule "${id ?? schedule.displayName ?? '?'}" varies with time but declares no sqlMatch, so its rows cannot be anchored to an hour`,
    undefined,
  )
}

/**
 * Bring a period's long-context tiers to the shape `contextTierFor` assumes,
 * or strip them.
 *
 * Returned by identity when there is nothing to change, so the common case —
 * no tiers at all, or upstream's already-sorted list — allocates nothing and
 * lets the bundled tables stay shared.
 *
 * Three rules, each guarding a way a bad tier costs more than no tier:
 *
 * - **Never alongside `peak`.** The two dimensions are independent and no
 *   vendor publishes both, so a period carrying both is malformed rather
 *   than expressive. Keeping the peak is the safer half to keep: it applies
 *   to every request inside its hours, where a tier applies only to
 *   unusually long ones.
 * - **Thresholds must be positive and finite.** A threshold of 0 makes the
 *   "tier" the base rate for every request, silently doubling an entire
 *   vendor's bill.
 * - **Ascending, and one card per threshold.** `contextTierFor` stops at the
 *   first threshold the prompt fails, so an unsorted list can return a
 *   cheaper tier than the one that applies.
 */
function normalizeTiers(
  period: PricePeriod,
  onWarn: ((message: string, error: unknown) => void) | undefined,
  name = '?',
): PricePeriod {
  const tiers = period.contextTiers
  if (!tiers || tiers.length === 0) {
    return tiers ? { ...period, contextTiers: undefined } : period
  }
  if (period.peak) {
    onWarn?.(
      `schedule "${name}" prices both a peak window and a long-context tier; keeping the peak and dropping the tier, since no vendor publishes both`,
      undefined,
    )
    return { ...period, contextTiers: undefined }
  }
  const usable = tiers.filter(tier => Number.isFinite(tier.abovePromptTokens) && tier.abovePromptTokens > 0)
  if (usable.length !== tiers.length) {
    onWarn?.(`schedule "${name}" has ${tiers.length - usable.length} long-context tier(s) with an unusable threshold; dropped`, undefined)
  }
  // Copy before sorting only when `filter` did not already make the array
  // ours, so an already-sorted upstream list is compared, not rebuilt.
  const sorted = (usable.length === tiers.length ? [...usable] : usable)
    .sort((a, b) => a.abovePromptTokens - b.abovePromptTokens)
  const deduped = sorted.filter((tier, i) => {
    const clash = i > 0 && sorted[i - 1]!.abovePromptTokens === tier.abovePromptTokens
    if (clash) {
      onWarn?.(`schedule "${name}" quotes two long-context tiers above ${tier.abovePromptTokens} tokens; keeping the first`, undefined)
    }
    return !clash
  })
  if (deduped.length === 0) {
    return { ...period, contextTiers: undefined }
  }
  const unchanged = deduped.length === tiers.length && deduped.every((tier, i) => tier === tiers[i])
  return unchanged ? period : { ...period, contextTiers: deduped }
}

/**
 * Clamp peak windows to real UTC hours and merge them into a disjoint set.
 *
 * `peakMsBetween` sums each window independently, so overlapping windows
 * count their shared hours twice and a reversed one contributes a *negative*
 * duration. Either way the blended rate escapes [off-peak, peak], which is
 * the one guarantee blending makes.
 */
function normalizeWindows(windows: Array<[number, number]>): Array<[number, number]> {
  const clamped = windows
    .map(([start, end]): [number, number] => [
      Math.max(0, Math.min(24, Math.floor(start))),
      Math.max(0, Math.min(24, Math.ceil(end))),
    ])
    // `end > start` also drops NaN, the only non-finite value that survives
    // the clamp above.
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0])

  const merged: Array<[number, number]> = []
  for (const [start, end] of clamped) {
    const last = merged.at(-1)
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end)
    }
    else {
      merged.push([start, end])
    }
  }
  return merged
}
