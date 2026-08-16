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
  /**
   * Which provider inside `source` quoted this. `source` alone does not
   * identify a price: models.dev carries 186 providers quoting 6,199
   * models between them, so a bare model name collides 15-25 ways and the
   * winner is decided by provider priority — first-party where one exists,
   * and otherwise by whichever provider id sorts first. That tie-break is
   * arbitrary and, without this field, invisible.
   *
   * Absent on the built-in tables (`fallback`, `override`), which quote
   * first-party rates by construction and have no provider to name.
   */
  providerId?: string
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
  /** Which provider inside `source` quoted this. See `ModelPrice`. */
  providerId?: string
  /**
   * How much this quote is trusted; lower wins. `0` means the source ranks
   * the quoting provider as first-party for this model, `1` (the default
   * when absent) means it does not.
   *
   * A lookup probes several spellings of one stored name, and a spelling
   * can be listed *only* by resellers: `gpt-5-5` is sold by three no-name
   * routers at three different prices, while OpenAI's own listing is filed
   * under `gpt-5.5`. Without a tier the exact-but-worthless spelling wins
   * on candidate order alone.
   */
  tier?: number
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

declare const NORMALIZED: unique symbol

/**
 * A schedule that has been through `normalizeSchedule`, and so keeps every
 * promise the comments above make: at least one period, ascending by `from`,
 * the first opening at -Infinity, and peak windows that are real, disjoint
 * UTC hours.
 *
 * The primitives that read a schedule run once per priced row and therefore
 * check nothing — which is the whole reason validation happens at ingest.
 * This brand is what keeps that from being a convention: they accept only
 * this type, so no schedule can reach them without passing the gate.
 * `mergeLiveQuote` and `scaleSchedule` both produced schedules that skipped
 * it while nothing but a comment said they should not.
 *
 * There is no way to make one except through `normalizeSchedule`, exported
 * from `llm-pricing/internal` for anyone extending the package.
 */
export type NormalizedSchedule = PriceSchedule & { readonly [NORMALIZED]: true }

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
  /**
   * What this row could have cost, at the cheapest and dearest rate card
   * the estimate drew on.
   *
   * Equal to `cost` for `flat` and `exact` — there was only ever one card.
   * For `blended` they are the off-peak and peak ends of the window, which
   * for DeepSeek is a factor of two apart. `basis: 'blended'` says the
   * number is approximate; these say by how much, and they cost nothing to
   * produce because both cards were already in hand.
   *
   * Sound because cost is linear in the rates: blending averages the cards,
   * so the blended cost is exactly the same average of their costs and can
   * never fall outside them.
   */
  low: number
  high: number
  /**
   * Tokens this estimate billed for — the quantities actually multiplied by
   * a rate, after cache carve-outs and the reasoning convention. Zero-cost
   * for an unpriced model, where it is the only record that real usage was
   * counted as $0. See `sumEstimates`.
   */
  tokens: number
}

export const HOUR_MS = 60 * 60 * 1000
export const DAY_MS = 24 * HOUR_MS
