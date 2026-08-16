import type { EstimateArgs, PricingCatalogOptions, PricingCatalogState } from './catalog'
import type { RowOptions } from './row'
import type { CostEstimate, ModelPrice, TimeInput } from './types'
import { PricingCatalog } from './catalog'

// The public API. Everything the package can do is reachable from here;
// the pieces it is *built* from — catalogue parsers, rate arithmetic, the
// schedule primitives, the raw tables — live behind `llm-pricing/internal`
// so they can change without a major version. Import from there if you are
// extending the package rather than using it.

export type { PricingCache } from './cache'
export { memoryCache } from './cache'
export type { EstimateArgs, PricingCatalogOptions, PricingCatalogState } from './catalog'
export { PricingCatalog } from './catalog'
export { SNAPSHOT_SYNCED_AT, SNAPSHOT_SYNCED_AT_MS } from './catalog/fallback'
export type { ParseModelsDevOptions } from './catalog/modelsdev'
export { DEFAULT_PROVIDER_PRIORITY } from './catalog/modelsdev'
export type { TokenCounts } from './estimate'
export { CACHE_CREATE_1H_INPUT_MULTIPLIER, costFromRates, tokensBilled } from './estimate'
export { pricingCandidates } from './resolve'
export type { RowColumns, RowOptions, TokenShape } from './row'
export { DEFAULT_ROW_COLUMNS, inferTokenShape, PRICE_ANCHOR_COLUMN } from './row'
export type { PricingSource } from './sources'
export { modelsDevSource, openRouterSource } from './sources'
export type { CostTotal } from './total'
export { sumEstimates } from './total'
export type {
  CostEstimate,
  ModelPrice,
  NormalizedSchedule,
  PriceBasis,
  PricePeriod,
  PriceSchedule,
  PriceSource,
  RateKey,
  Rates,
  TimeInput,
} from './types'
export { RATE_KEYS } from './types'

// ---------------------------------------------------------------------
// The default catalogue.
// ---------------------------------------------------------------------
//
// One shared instance is the right shape for a server: the catalogue is a
// 4 MB download and a process-wide cache, not per-request state. It is
// created on first use rather than at import time so `configureDefaultCatalog`
// has a chance to run first — a catalogue built with the wrong options and
// then silently reused is exactly the bug this shape avoids.

let defaultOptions: PricingCatalogOptions = {}
let instance: PricingCatalog | null = null

/**
 * Set the options the default catalogue is built with. Call it once,
 * during startup, **before** anything touches the default catalogue.
 *
 * The usual reason is a cache:
 *
 * ```ts
 * import { configureDefaultCatalog } from 'llm-pricing'
 * import { fileCache } from 'llm-pricing/node'
 *
 * configureDefaultCatalog({ cache: fileCache() })
 * ```
 *
 * Throws if the catalogue already exists. Configuring it after the fact
 * cannot retroactively apply — the alternative is silently ignoring the
 * options and serving a whole process from an unconfigured catalogue.
 */
export function configureDefaultCatalog(options: PricingCatalogOptions): PricingCatalog {
  if (instance) {
    throw new Error('[llm-pricing] the default catalogue is already in use; configure it before the first call, or construct your own PricingCatalog')
  }
  defaultOptions = options
  return getDefaultCatalog()
}

/** The shared catalogue, created on first call. */
export function getDefaultCatalog(): PricingCatalog {
  instance ??= new PricingCatalog(defaultOptions)
  return instance
}

// Bound to the default catalogue. These exist because the one-catalogue
// case is overwhelmingly the common one and `estimateCostUsd(...)` reads
// better in a cost-folding loop than threading an instance through it.
// Anything holding its own `PricingCatalog` uses the methods instead —
// each of these is a one-line forward to one.

/** See `PricingCatalog#ensureLoaded`. */
export function ensurePricingLoaded(): Promise<void> {
  return getDefaultCatalog().ensureLoaded()
}

/** See `PricingCatalog#refresh`. */
export function refreshPricing(): Promise<void> {
  return getDefaultCatalog().refresh()
}

/** See `PricingCatalog#state`. */
export function pricingState(): PricingCatalogState {
  return getDefaultCatalog().state()
}

/** See `PricingCatalog#getPrice`. */
export function getPriceFor(model: string, at?: TimeInput): ModelPrice | null {
  return getDefaultCatalog().getPrice(model, at)
}

/** See `PricingCatalog#estimate`. */
export function estimateCostUsd(args: EstimateArgs): CostEstimate {
  return getDefaultCatalog().estimate(args)
}

/** See `PricingCatalog#estimateFromRow`. */
export function estimateCostFromRow(row: Record<string, unknown>, options?: RowOptions): CostEstimate {
  return getDefaultCatalog().estimateFromRow(row, options)
}

/** See `PricingCatalog#timeSensitiveSqlPatterns`. */
export function timeSensitiveSqlPatterns(): readonly string[] {
  return getDefaultCatalog().timeSensitiveSqlPatterns()
}
