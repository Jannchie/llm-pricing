import type { ModelsDevResponse } from './modelsdev'

/**
 * The merge behind `pnpm sync`, separated from the script so it can be
 * tested without a network call.
 *
 * This builds an ARCHIVE, not a table. models.dev — like OpenRouter,
 * LiteLLM and ccusage — publishes one number per model: whatever it costs
 * today. Applied naively that re-prices history, so a vendor raising a rate
 * silently inflates last month's bill. Each sync therefore *appends* a
 * period dated today rather than overwriting.
 *
 * Append-only in both directions: a model that disappears upstream keeps
 * its whole history, because stored model strings are immortal and a row
 * that silently prices at $0 is worse than one on a stale rate.
 */

/**
 * Providers whose listings are archived, best first.
 *
 * Deliberately the same list the live index ranks as first-party: if the
 * two disagree, a vendor-vs-reseller price gap reads as a change over time
 * and gets grafted into the history as one.
 */
export { DEFAULT_PROVIDER_PRIORITY as SYNC_PROVIDERS } from './modelsdev'

/** `[effectiveFrom|null, input, cacheWrite, cacheRead, output]`, $/MTok. */
export type SnapshotPeriod = [string | null, number, number, number, number]
export type SnapshotEntry = [displayName: string, periods: SnapshotPeriod[]]
export type SnapshotModels = Record<string, SnapshotEntry>

export interface SyncResult {
  models: SnapshotModels
  added: number
  repriced: number
  /** Present in the archive, no longer listed upstream. Kept. */
  retained: string[]
}

/**
 * Rates count as unchanged within a relative epsilon.
 *
 * The archive is append-only, so a spurious reprice is permanent. Rates are
 * carried through JSON and `input * 0.1` arithmetic, which is exactly where
 * a value drifts in its last bits — the snapshot already contains figures
 * like `0.010000000000000002`. An exact comparison turns that drift into a
 * price-change record that never happened. Matches `ratesEqual`.
 */
function sameRates(a: ReadonlyArray<string | number | null>, b: readonly number[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  return a.every((value, i) => {
    const other = b[i]!
    if (typeof value !== 'number') {
      return false
    }
    if (value === other) {
      return true
    }
    const scale = Math.max(Math.abs(value), Math.abs(other))
    return Math.abs(value - other) <= 1e-9 * scale
  })
}

export function mergeSnapshot(
  previous: SnapshotModels,
  api: ModelsDevResponse,
  providers: readonly string[],
  today: string,
): SyncResult {
  const models: SnapshotModels = { ...previous }
  const seen = new Set<string>()
  let added = 0
  let repriced = 0

  for (const provider of providers) {
    for (const [id, model] of Object.entries(api[provider]?.models ?? {})) {
      const cost = model?.cost
      if (!cost || typeof cost.input !== 'number' || typeof cost.output !== 'number') {
        continue
      }
      // Placeholder rows advertise availability at 0/0; pricing a real
      // workload against those silently reports $0 spend. A negative rate
      // is never a real quote and would credit back other models' cost.
      if (!(cost.input > 0 || cost.output > 0) || cost.input < 0 || cost.output < 0) {
        continue
      }
      const key = id.toLowerCase()
      // First provider in `providers` order wins a given bare model name.
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      const cacheRead = typeof cost.cache_read === 'number' && Number.isFinite(cost.cache_read)
        ? cost.cache_read
        : cost.input * 0.1
      const cacheWrite = typeof cost.cache_write === 'number' && Number.isFinite(cost.cache_write)
        ? cost.cache_write
        : cacheRead
      const rates: [number, number, number, number] = [cost.input, cacheWrite, cacheRead, cost.output]
      const displayName = typeof model.name === 'string' ? model.name : id

      const before = models[key]
      if (!before) {
        // First observation opens at null (-Infinity) rather than today:
        // the model was priced this way before we started watching, and
        // dating it today would leave every earlier row unpriced.
        models[key] = [displayName, [[null, ...rates]]]
        added++
        continue
      }
      const periods = before[1]
      const latest = periods.at(-1)!
      if (sameRates(latest.slice(1), rates)) {
        // Unchanged. Refresh the display name only.
        models[key] = [displayName, periods]
        continue
      }
      // A reprice. If the latest period was recorded in this same sync (a
      // re-run on the same day), correct it in place rather than stacking
      // two periods on one date.
      models[key] = [displayName, latest[0] === today
        ? [...periods.slice(0, -1), [today, ...rates]]
        : [...periods, [today, ...rates]]]
      repriced++
    }
  }

  return {
    models,
    added,
    repriced,
    retained: Object.keys(models).filter(key => !seen.has(key)),
  }
}
