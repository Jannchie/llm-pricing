// The parts llm-pricing is built from: catalogue parsers, the raw price
// tables, rate arithmetic and the schedule primitives.
//
// These are exported so the package can be extended — a new upstream
// adapter, a custom archive, a report that reads the schedules directly —
// but they are NOT the public API. Their signatures track whatever the
// internals need and can change in a minor release. Build on `llm-pricing`
// itself unless you specifically need one of these.

export { FALLBACK, FAST_BY_ID, FAST_MULTIPLIERS } from './catalog/fallback'
export type { ModelsDevResponse } from './catalog/modelsdev'
export { MODELS_DEV_URL, parseModelsDev } from './catalog/modelsdev'
export type { OpenRouterModelsResponse } from './catalog/openrouter'
export { OPENROUTER_MODELS_URL, parseOpenRouterModels } from './catalog/openrouter'
export { OVERRIDES } from './catalog/overrides'
export {
  flatSchedule,
  mergeLiveQuote,
  ratesEqual,
  scaleRates,
  scaleSchedule,
  weightedRates,
} from './rates'
export { dotted, undotted } from './resolve'
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
export { DAY_MS, HOUR_MS } from './types'
