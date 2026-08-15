// Core value types. Everything here is data — no I/O, no state.
//
// A price is a *schedule*, not a number. Two time dimensions exist:
//
//   1. Effective dates — a provider changing its rate must not re-price
//      history. DeepSeek's 2026-08-16 change raises every rate, so
//      applying it retroactively would overstate old months by up to 4.7x.
//   2. Time of day — DeepSeek bills peak and off-peak rates depending on
//      the UTC hour a request lands in.
//
// Everything else in the catalogue has a single flat period and pays no
// cost for those dimensions existing: `ratesFor` short-circuits to the
// one rate card and the SQL side never splits those rows by hour.

// Per-token USD rates. One card = the price of everything at one instant.
// RATE_KEYS is the field list every rate-card transform iterates, so adding
// a sixth cost dimension means touching the constructors only, never the
// scale/blend arithmetic.
export const RATE_KEYS = [
  'inputCostPerToken',
  'cacheCreationInputCostPerToken',
  'cacheReadInputCostPerToken',
  'cachedInputCostPerToken',
  'outputCostPerToken',
] as const

export type RateKey = (typeof RATE_KEYS)[number]

export type Rates = Record<RateKey, number>

/**
 * Where a rate card came from.
 *
 * - `openrouter` — the OpenRouter live catalogue.
 * - `modelsdev`  — the models.dev live catalogue.
 * - `fallback`   — the built-in table, used when the network is unavailable
 *                  or no catalogue lists the model.
 * - `override`   — a first-party schedule that deliberately OUTRANKS every
 *                  catalogue (see `src/catalog/overrides.ts`).
 * - `missing`    — reserved for callers that want to mark an unpriced model
 *                  without a null check.
 */
export type PriceSource = 'openrouter' | 'modelsdev' | 'fallback' | 'override' | 'missing'

// The rate card actually applied to a row, plus provenance. This is the
// shape dashboards serialise into a per-model `pricing` block, so it stays
// flat — the schedule is resolved before it gets here.
export type ModelPrice = Rates & {
  displayName?: string
  source: PriceSource
}

// One contiguous slice of a model's price history. `rates` is the flat
// (or off-peak) card; `peak` overrides it inside daily [startHour, endHour)
// **UTC** windows. Whole hours only — a consumer anchoring rows to a UTC
// hour could not honour a window boundary at :30 exactly.
export interface PricePeriod {
  from: number
  rates: Rates
  peak?: { windowsUtc: Array<[number, number]>, rates: Rates }
}

export interface PriceSchedule {
  displayName?: string
  source: PriceSource
  /**
   * Ascending by `from`. The first entry opens at -Infinity so any
   * timestamp resolves.
   */
  periods: PricePeriod[]
  /**
   * SQL LIKE patterns (lowercase) matching every stored spelling of this
   * model. REQUIRED on any schedule that is time-sensitive (more than one
   * period, or any peak window): it is what tells a query layer to split
   * these rows by UTC hour so each hour can take its own rate. Match the
   * whole vendor rather than one model id — over-matching only costs a few
   * extra (correctly priced) rows, under-matching silently mis-prices.
   */
  sqlMatch?: string[]
}

export type TimeInput = number | string | Date | null | undefined

/**
 * How a rate card was arrived at:
 *
 * - `flat`    — the model has a single timeless rate; `at` is irrelevant.
 * - `exact`   — time-sensitive model priced at a known instant.
 * - `blended` — time-sensitive model priced across a window (see `blendRates`).
 */
export type PriceBasis = 'flat' | 'exact' | 'blended'

export interface CostEstimate {
  cost: number
  pricing: ModelPrice | null
  basis: PriceBasis
}

export const HOUR_MS = 60 * 60 * 1000
export const DAY_MS = 24 * HOUR_MS
