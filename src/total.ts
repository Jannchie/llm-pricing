import type { CostEstimate, ModelPrice, PriceBasis } from './types'

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
   * bounds. Equal to `cost` unless something in the sum was blended.
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
   * peak boundary — which is the case a single `pricing` field cannot
   * represent and silently misreports.
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
 * estimates. Cards are identity-keyed: the catalogue memoises one object
 * per rate card, so two rows priced identically share one entry without
 * comparing five floats per row.
 */
export function sumEstimates(estimates: Iterable<CostEstimate>): CostTotal {
  const total: CostTotal = {
    ...EMPTY,
    unpriced: { count: 0, tokens: 0 },
    byBasis: { flat: 0, exact: 0, blended: 0 },
    cards: [],
  }
  const cards = new Map<ModelPrice, { pricing: ModelPrice, cost: number, count: number }>()
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
    const entry = cards.get(estimate.pricing)
    if (entry) {
      entry.cost += estimate.cost
      entry.count++
    }
    else {
      cards.set(estimate.pricing, { pricing: estimate.pricing, cost: estimate.cost, count: 1 })
    }
  }
  total.cards = [...cards.values()].sort((a, b) => b.cost - a.cost)
  return total
}
