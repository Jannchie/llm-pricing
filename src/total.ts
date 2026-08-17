import type { CostEstimate, ModelPrice, PriceBasis } from './types'
import { RATE_KEYS } from './types'

/**
 * A sum of estimates that keeps what a bare `+=` throws away.
 *
 * Every estimate carries provenance and a confidence — which card priced
 * it, how the card was arrived at, whether the model was known at all. Cost
 * is the only part of that which adds, so a caller folding thousands of
 * rows loses the rest at the first `+`. What they write instead is an
 * ad-hoc accumulator, and the ad-hoc version is usually wrong in the same
 * way: it keeps the *last* card it saw and calls it the model's price.
 *
 * That is only true when every row of a model shares one card, which is
 * exactly false for the models this package works hardest on — a DeepSeek
 * model spanning peak and off-peak has two, a factor of two apart.
 */
export interface CostTotal {
  /** Summed cost. Identical to adding `estimate.cost` by hand. */
  cost: number
  /**
   * The interval the true cost lies in, summed from each estimate's own
   * bounds. Equal to `cost` unless something in the sum was blended across a
   * price change, or priced on a long-context model without `perRequest` —
   * see `CostEstimate.low`.
   */
  low: number
  high: number
  /** Estimates folded in, and how many of them had no price. */
  count: number
  /**
   * Estimates whose model the catalogue does not list. Their cost is 0,
   * so a total containing them is an undercount by construction — this is
   * how much of one.
   */
  unpriced: { count: number, tokens: number }
  /** Tokens billed, across the priced estimates only. */
  tokens: number
  /**
   * Cost split by how it was arrived at. `blended` is the share that would
   * sharpen if the query grouped by UTC hour; `flat` needs no such fix.
   */
  byBasis: Record<PriceBasis, number>
  /**
   * The distinct rate cards that produced this cost, most expensive first,
   * with what each contributed. More than one for a model priced across a
   * peak boundary, or a workload whose long requests crossed a long-context
   * threshold while its short ones did not — the cases a single `pricing`
   * field cannot represent and silently misreports.
   */
  cards: Array<{ pricing: ModelPrice, cost: number, count: number }>
}

const EMPTY: CostTotal = {
  cost: 0,
  low: 0,
  high: 0,
  count: 0,
  unpriced: { count: 0, tokens: 0 },
  tokens: 0,
  byBasis: { flat: 0, exact: 0, blended: 0 },
  cards: [],
}

/**
 * What makes two rate cards the same price: every rate, plus where it came
 * from. Provenance is part of it — the same numbers reached through a
 * reseller and through the vendor are the same cost but not the same fact,
 * and `cards` is read to answer "what was this charged at".
 */
function cardKey(pricing: ModelPrice): string {
  // The tier and the thinking variant are part of the identity, not
  // decorations: "the base rate", "the rate above 272k" and "the rate in
  // thinking mode" are three different facts about the same model, and a
  // caller reading `cards` to answer "what was this charged at" needs them
  // apart even in the corner case where two of them quote equal rates.
  let key = `${pricing.source}|${pricing.providerId ?? ''}|${pricing.displayName ?? ''}|${pricing.contextTierAbove ?? ''}|${pricing.reasoningMode ?? ''}`
  for (const rate of RATE_KEYS) {
    key += `|${pricing[rate]}`
  }
  return key
}

/**
 * Fold estimates into one total, keeping their provenance and confidence.
 *
 * ```ts
 * const total = sumEstimates(rows.map(row => estimateCostFromRow(row, { window })))
 *
 * total.cost                  // what to display
 * total.low, total.high       // how far off it could be
 * total.unpriced.tokens       // usage this total counts as $0
 * total.byBasis.blended       // cost that an hour-grouped query would sharpen
 * total.cards                 // every rate actually applied, not just the last
 * ```
 *
 * Accepts any iterable, so a generator over a cursor never materialises the
 * estimates.
 *
 * Two rows quoting the same price share one card entry whatever produced
 * them — the same catalogue, two catalogues, or an estimate assembled by
 * hand. Grouping on object identity would have been cheaper, but it would
 * make this function's answer depend on a private memo inside
 * `PricingCatalog`: a cache eviction, a second instance, or a round-trip
 * through JSON would silently split one price into many entries, which is
 * the exact failure this function exists to prevent.
 */
export function sumEstimates(estimates: Iterable<CostEstimate>): CostTotal {
  const total: CostTotal = {
    ...EMPTY,
    unpriced: { count: 0, tokens: 0 },
    byBasis: { flat: 0, exact: 0, blended: 0 },
    cards: [],
  }
  const cards = new Map<string, { pricing: ModelPrice, cost: number, count: number }>()
  // Identity still short-circuits the key building, because the common case
  // by far is thousands of rows sharing one memoised card.
  const seen = new Map<ModelPrice, string>()
  for (const estimate of estimates) {
    total.count++
    total.cost += estimate.cost
    total.low += estimate.low
    total.high += estimate.high
    total.byBasis[estimate.basis] += estimate.cost
    if (!estimate.pricing) {
      total.unpriced.count++
      total.unpriced.tokens += estimate.tokens
      continue
    }
    total.tokens += estimate.tokens
    let key = seen.get(estimate.pricing)
    if (key === undefined) {
      key = cardKey(estimate.pricing)
      seen.set(estimate.pricing, key)
    }
    const entry = cards.get(key)
    if (entry) {
      entry.cost += estimate.cost
      entry.count++
    }
    else {
      cards.set(key, { pricing: estimate.pricing, cost: estimate.cost, count: 1 })
    }
  }
  total.cards = [...cards.values()].sort((a, b) => b.cost - a.cost)
  return total
}
