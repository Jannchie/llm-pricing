// Core value types. Everything here is data — no I/O, no state.
//
// A price is a *schedule*, not a number. Three dimensions exist — two of
// time, one of scale:
//
//   1. Effective dates — a provider changing its rate must not re-price
//      history. DeepSeek's 2026-08-16 change raises every rate, so
//      applying it retroactively would overstate old months by up to 4.7x.
//   2. Time of day — DeepSeek bills peak and off-peak rates depending on
//      the UTC hour a request lands in.
//   3. Prompt size — a request whose prompt exceeds a threshold is billed
//      at a dearer card for its whole length. See `ContextTier`.
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
  // An alias of `cacheReadInputCostPerToken`, not a fifth priced dimension.
  // "Cached input" (OpenAI's word) and "cache read" (Anthropic's) name one
  // thing, and no vendor charges them differently — every producer in this
  // package assigns both from a single value, and all 8,352 rate cards in
  // the bundled tables and the live models.dev feed quote them equal.
  //
  // It is therefore never multiplied by a token count of its own: which of
  // the two count fields a row happens to fill in is a property of the
  // collector, not of the vendor, so selecting a *rate* from it would put a
  // pricing decision on the wrong side of that line. Kept because it is
  // published on `ModelPrice` and callers display it.
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
  /**
   * The long-context tier this card came from — its `abovePromptTokens`
   * threshold. Absent on the base card, which is what nearly every row
   * pays. See `ContextTier`; `sumEstimates` keys on this, so a request that
   * crossed the threshold is reported as its own line rather than averaged
   * into the base rate.
   */
  contextTierAbove?: number
}

/**
 * A dearer rate card that applies to a whole request once its **prompt**
 * exceeds `abovePromptTokens`.
 *
 * Real and widely published: `gpt-5.5` doubles input and takes output to
 * 1.5x above 272k, Gemini 2.5 Pro does the same above 200k, and so do
 * Vertex's Claude listings. models.dev publishes these as
 * `cost.tiers[].tier = { type: 'context', size }`.
 *
 * Three things this shape says deliberately:
 *
 * - **A full card, not a multiplier.** The ratios are not uniform — 206 of
 *   the 375 tiers upstream are input x2 / output x1.5, but 74 are x2/x2 and
 *   others run to x4. A multiplier would approximate all of them.
 * - **Measured on the prompt, billed on everything.** Output tokens do not
 *   count toward the threshold but are billed at the tier's output rate
 *   once it is crossed — which is what the vendors' ">200K prompt" wording
 *   means.
 * - **Inside a period, not beside it.** Tiers are themselves historical:
 *   Anthropic's own >200k premium ($6/$22.50 on Sonnet 4/4.5) existed until
 *   2026-03-13 and was then withdrawn, so a schedule has to carry a tier
 *   for its old periods and none for its new ones.
 */
export interface ContextTier {
  /** Strictly greater than: a prompt of exactly this size pays the base card. */
  abovePromptTokens: number
  rates: Rates
}

// One contiguous slice of a model's price history. `rates` is the flat
// (or off-peak) card; `peak` overrides it inside daily [startHour, endHour)
// **UTC** windows. Whole hours only — a consumer anchoring rows to a UTC
// hour could not honour a window boundary at :30 exactly.
export interface PricePeriod {
  from: number
  rates: Rates
  peak?: { windowsUtc: Array<[number, number]>, rates: Rates }
  /**
   * Long-context tiers, ascending by threshold; the highest one the prompt
   * clears wins. Only consulted when the caller states the row describes a
   * single request — see `EstimateArgs.perRequest`.
   *
   * Never present alongside `peak`. No vendor publishes both, and pricing
   * one of the two dimensions away silently would be worse than refusing
   * the combination, so `normalizeSchedule` drops the tiers and warns.
   */
  contextTiers?: ContextTier[]
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
