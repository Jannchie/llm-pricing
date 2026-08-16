import type { PricePeriod, PriceSchedule } from './types'
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
): PriceSchedule | null {
  const usable = schedule.periods.filter(period => !Number.isNaN(period.from))
  if (usable.length === 0) {
    onWarn?.(`schedule "${id ?? schedule.displayName ?? '?'}" has no usable periods and was dropped`, undefined)
    return null
  }

  // `periodAt` walks the list and stops at the first period starting later
  // than the instant asked for, so an out-of-order list returns the wrong
  // era's rate — silently, and only for the models that have history.
  const ordered = [...usable].sort((a, b) => a.from - b.from)
  let changed = ordered.length !== schedule.periods.length
    || ordered.some((period, i) => period !== schedule.periods[i])

  const periods: PricePeriod[] = ordered.map((period) => {
    if (!period.peak) {
      return period
    }
    const windowsUtc = normalizeWindows(period.peak.windowsUtc)
    if (windowsUtc.length === period.peak.windowsUtc.length
      && windowsUtc.every((w, i) => w[0] === period.peak!.windowsUtc[i]![0] && w[1] === period.peak!.windowsUtc[i]![1])) {
      return period
    }
    changed = true
    // Every window was nonsense: the period simply has no peak.
    return windowsUtc.length === 0
      ? { from: period.from, rates: period.rates }
      : { ...period, peak: { ...period.peak, windowsUtc } }
  })

  const result = changed ? { ...schedule, periods } : schedule
  // A time-sensitive schedule with no `sqlMatch` still prices correctly when
  // the caller passes `at`, but the query layer is never told to split these
  // rows by hour, so in practice they all blend. Worth saying out loud.
  if (isTimeSensitive(result) && !(result.sqlMatch && result.sqlMatch.length > 0)) {
    onWarn?.(
      `schedule "${id ?? result.displayName ?? '?'}" varies with time but declares no sqlMatch, so its rows cannot be anchored to an hour`,
      undefined,
    )
  }
  return result
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
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
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
