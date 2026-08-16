import type { ModelsDevResponse } from './modelsdev'
import { closeEnough } from '../rates'
import { cacheRatesFrom, isUsableCost } from './modelsdev'

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
 * The on-disk archive format, shared with the reader in `fallback.ts` so the
 * two cannot disagree about the tuple's arity or order. `$/MTok`.
 */
export type SnapshotPeriod = [from: string | null, input: number, cacheWrite: number, cacheRead: number, output: number]
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
 * Rates count as unchanged within `closeEnough`'s relative epsilon, rather
 * than exactly. The archive is append-only, so a spurious reprice is
 * permanent, and the snapshot already holds figures like
 * `0.010000000000000002` — an exact comparison would turn that last-bit
 * drift into a price-change record that never happened.
 */
function sameRates(a: readonly number[], b: readonly number[]): boolean {
  return a.every((value, i) => closeEnough(value, b[i]!))
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
      if (!isUsableCost(cost)) {
        continue
      }
      const key = id.toLowerCase()
      // First provider in `providers` order wins a given bare model name.
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      // Stored as models.dev publishes them, per MTok — hence divisor 1.
      const { cacheRead, cacheWrite } = cacheRatesFrom(cost, 1)
      const rates: [number, number, number, number] = [cost.input!, cacheWrite, cacheRead, cost.output!]
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
      if (sameRates(latest.slice(1) as number[], rates)) {
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
