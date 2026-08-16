import type { PricingCatalog } from './catalog'
import type { TokenCounts } from './estimate'
import type { CostEstimate, TimeInput } from './types'

/**
 * How the producer of these rows nests its counts. Both default to the
 * majority convention; see `TokenCounts` for why guessing is not safe.
 *
 * A store that merges several agents into one schema will need this per
 * source rather than per query — the nesting travels with whoever wrote the
 * row, not with the model.
 */
export type TokenShape = Pick<TokenCounts, 'inputIncludesCache' | 'reasoningIncludedInOutput'>

/**
 * Column name carrying a row's pricing time anchor: the start of the UTC
 * hour its tokens were spent in, as epoch **seconds**, or NULL when the
 * model's price does not vary with time.
 *
 * This is one half of a contract. The other half lives in the query layer,
 * which must select this column (and group by it) for rows to price
 * exactly instead of being blended across the request window. Rows without
 * it still price, just less precisely.
 *
 * A reference Postgres expression:
 *
 * ```sql
 * case when lower(coalesce(model, '')) like '%deepseek%'
 *      then (floor(extract(epoch from ts) / 3600) * 3600)::bigint
 * end as price_hour_epoch
 * ```
 *
 * Build the LIKE list from `catalog.timeSensitiveSqlPatterns()` rather than
 * hard-coding it, and prefer `extract(epoch from ...)` over `date_trunc`:
 * the latter depends on the session TimeZone, which is the wrong frame for
 * a billing window.
 */
export const PRICE_ANCHOR_COLUMN = 'price_hour_epoch'

/**
 * Column names read by `estimateCostFromRow`. Override individually when
 * your table spells them differently.
 */
export interface RowColumns {
  model: string
  inputTokens: string
  cachedInputTokens: string
  cacheCreationInputTokens: string
  cacheCreation5mInputTokens: string
  cacheCreation1hInputTokens: string
  cacheReadInputTokens: string
  outputTokens: string
  reasoningOutputTokens: string
  priceAnchor: string
}

export const DEFAULT_ROW_COLUMNS: RowColumns = {
  model: 'model',
  inputTokens: 'input_tokens',
  cachedInputTokens: 'cached_input_tokens',
  cacheCreationInputTokens: 'cache_creation_input_tokens',
  cacheCreation5mInputTokens: 'cache_creation_5m_input_tokens',
  cacheCreation1hInputTokens: 'cache_creation_1h_input_tokens',
  cacheReadInputTokens: 'cache_read_input_tokens',
  outputTokens: 'output_tokens',
  reasoningOutputTokens: 'reasoning_output_tokens',
  priceAnchor: PRICE_ANCHOR_COLUMN,
}

function rowNum(v: unknown): number {
  if (v === null || v === undefined) {
    return 0
  }
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * The anchor is documented as epoch **seconds**, and the SQL helper emits
 * seconds. A caller who passes milliseconds would otherwise be priced at a
 * point tens of thousands of years out — silently, and often at a
 * plausible-looking rate, because the last period runs to infinity.
 *
 * Epoch seconds above 1e12 is the year 33658, so there is no real value to
 * confuse with a millisecond timestamp.
 */
function anchorToMs(anchor: number): number {
  return anchor > 1e12 ? anchor : anchor * 1000
}

/**
 * Price a raw SQL row that uses snake_case `*_tokens` column names, so
 * every cost-folding loop does not repeat the same nine coercions.
 */
export function estimateCostFromRow(
  catalog: PricingCatalog,
  row: Record<string, unknown>,
  window?: readonly [TimeInput, TimeInput],
  columns: RowColumns = DEFAULT_ROW_COLUMNS,
  shape: TokenShape = {},
): CostEstimate {
  const anchor = row[columns.priceAnchor]
  const at = anchor === null || anchor === undefined
    ? undefined
    : anchorToMs(rowNum(anchor))
  return catalog.estimate({
    model: String(row[columns.model] ?? 'unknown'),
    inputTokens: rowNum(row[columns.inputTokens]),
    cachedInputTokens: rowNum(row[columns.cachedInputTokens]),
    cacheCreationInputTokens: rowNum(row[columns.cacheCreationInputTokens]),
    cacheCreation5mInputTokens: rowNum(row[columns.cacheCreation5mInputTokens]),
    cacheCreation1hInputTokens: rowNum(row[columns.cacheCreation1hInputTokens]),
    cacheReadInputTokens: rowNum(row[columns.cacheReadInputTokens]),
    outputTokens: rowNum(row[columns.outputTokens]),
    reasoningOutputTokens: rowNum(row[columns.reasoningOutputTokens]),
    ...shape,
    at,
    window,
  })
}
