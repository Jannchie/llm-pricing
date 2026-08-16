import type { NormalizedSchedule, PricePeriod, PriceSchedule } from './types'
import { isTimeSensitive } from './schedule'

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
  // One period and no peak describes essentially every model in the
  // catalogue — nothing to sort and no window to check, so return the
  // schedule itself. Worth the branch: this runs over the whole bundled
  // table on construction and over every parsed remote entry on each load,
  // and rebuilding all of them would allocate a second copy of a table that
  // is otherwise shared by identity.
  const only = schedule.periods.length === 1 ? schedule.periods[0] : undefined
  if (only && !only.peak && only.from === Number.NEGATIVE_INFINITY) {
    warnIfUnanchored(schedule, onWarn, id)
    return schedule as NormalizedSchedule
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
      return period
    }
    const windowsUtc = normalizeWindows(period.peak.windowsUtc)
    // Every window was nonsense: the period simply has no peak.
    return windowsUtc.length === 0
      ? { from: period.from, rates: period.rates }
      : { ...period, peak: { ...period.peak, windowsUtc } }
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
