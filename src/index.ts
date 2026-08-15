import type { EstimateArgs, PricingCatalogState } from './catalog'
import type { CostEstimate, ModelPrice, TimeInput } from './types'
import { PricingCatalog } from './catalog'
import { estimateCostFromRow as estimateRow } from './row'

export type {
  EstimateArgs,
  PricingCatalogOptions,
  PricingCatalogState,
} from './catalog'
export { PricingCatalog } from './catalog'
export { FALLBACK, SNAPSHOT_SYNCED_AT, SNAPSHOT_SYNCED_AT_MS } from './catalog/fallback'
export type { ModelsDevResponse, ParseModelsDevOptions } from './catalog/modelsdev'
export { DEFAULT_PROVIDER_PRIORITY, MODELS_DEV_URL, parseModelsDev } from './catalog/modelsdev'
export type { OpenRouterModelsResponse } from './catalog/openrouter'
export { OPENROUTER_MODELS_URL, parseOpenRouterModels } from './catalog/openrouter'
export { OVERRIDES } from './catalog/overrides'
export type { TokenCounts } from './estimate'
export { CACHE_CREATE_1H_INPUT_MULTIPLIER, costFromRates } from './estimate'
export { flatSchedule, mergeLiveQuote, ratesEqual, scaleRates, scaleSchedule, weightedRates } from './rates'
export { dotted, pricingCandidates } from './resolve'
export type { RowColumns } from './row'
export { DEFAULT_ROW_COLUMNS, PRICE_ANCHOR_COLUMN } from './row'
export {
  blendRates,
  isPeakHour,
  isTimeSensitive,
  peakMsBetween,
  periodAt,
  ratesAt,
  ratesFor,
  toMs,
} from './schedule'
export type { PricingSource } from './sources'
export { modelsDevSource, openRouterSource } from './sources'
export * from './types'

/**
 * Process-wide catalogue using the default source (OpenRouter). Convenient
 * for servers that want one shared cache; construct your own
 * `PricingCatalog` when you need a different source, an injected fetch, or
 * isolation between tenants.
 */
export const defaultCatalog: PricingCatalog = new PricingCatalog()

export function ensurePricingLoaded(): Promise<void> {
  return defaultCatalog.ensureLoaded()
}

export function pricingState(): PricingCatalogState {
  return defaultCatalog.state()
}

export function getPriceFor(model: string, at?: TimeInput): ModelPrice | null {
  return defaultCatalog.getPrice(model, at)
}

export function estimateCostUsd(args: EstimateArgs): CostEstimate {
  return defaultCatalog.estimate(args)
}

export function estimateCostFromRow(
  row: Record<string, unknown>,
  window?: readonly [TimeInput, TimeInput],
): CostEstimate {
  return estimateRow(defaultCatalog, row, window)
}

/** See `PricingCatalog#timeSensitiveSqlPatterns`. */
export function timeSensitiveSqlPatterns(): readonly string[] {
  return defaultCatalog.timeSensitiveSqlPatterns
}
