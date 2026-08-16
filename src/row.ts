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
 *
 * Per source is the right granularity for `inputIncludesCache`, which no
 * amount of data can recover. It is not enough for
 * `reasoningIncludedInOutput`: measured on a real multi-agent store, two
 * sources report both ways within a single day and a single model id. Set
 * `inferShape` on `RowOptions` so each row's own total decides that half.
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
  /**
   * Read only by `inferTokenShape`, never for billing — the components are
   * what get priced, and a total that disagrees with them is a collector
   * bug rather than a cost.
   */
  totalTokens: string
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
  totalTokens: 'total_tokens',
  priceAnchor: PRICE_ANCHOR_COLUMN,
}

/**
 * Recover `reasoningIncludedInOutput` from a row that carries a total.
 *
 * `TokenShape` is documented as a property of whoever wrote the row, which
 * invites passing it per source. Measured against a real multi-agent store,
 * that is not safe: `gemini` reports both ways — 857 of its 1,157
 * reasoning-bearing rows fold thinking into `output_tokens` and 300 sit it
 * alongside — and `opencode` splits 2,967/1,588. The two shapes overlap in
 * time and in model id (`gemini-3-flash-preview` and `big-pickle` each
 * produce both, from the same day), so no per-source, per-model, or
 * per-version rule separates them. Applying one source-wide overcharges the
 * majority by 4.2% on that store's `gemini` rows.
 *
 * The total settles it. Whenever reasoning is non-zero the two conventions
 * predict different totals, so exactly one can match:
 *
 * - `total == input + output + reasoning` — reasoning sits beside the
 *   output count. Gemini's `thoughtsTokenCount` does this, and Google bills
 *   it at the output rate, so it has to be added.
 * - `total == input + output` — reasoning is already inside `output_tokens`
 *   (OpenAI, Anthropic). Adding it again double-charges.
 *
 * Anything else — no total, zero reasoning, or a total matching neither —
 * returns `{}`, leaving the caller's own shape or the library default in
 * place. That is the honest answer: a row whose total disagrees with its
 * own components has a collector bug, and guessing which component is wrong
 * would be worse than billing the majority convention.
 *
 * Note this infers only the output side. `inputIncludesCache` genuinely
 * cannot be recovered — a sibling row with large fresh input and a small
 * cache write is arithmetically identical to a superset row, and the total
 * does not distinguish them either.
 *
 * Usually reached through `inferShape`, which applies it per row and merges
 * the result over whatever `shape` the caller passed:
 *
 * ```ts
 * const { cost } = estimateCostFromRow(row, {
 *   window,
 *   shape: shapeForSource(row.source),
 *   inferShape: true,
 * })
 * ```
 */
export function inferTokenShape(
  row: Record<string, unknown>,
  columns: RowColumns = DEFAULT_ROW_COLUMNS,
): TokenShape {
  const reasoning = rowNum(row[columns.reasoningOutputTokens])
  const total = rowNum(row[columns.totalTokens])
  // With no reasoning to attribute, or no total to attribute it against,
  // both conventions cost exactly the same and there is nothing to infer.
  if (reasoning <= 0 || total <= 0) {
    return {}
  }
  const base = rowNum(row[columns.inputTokens]) + rowNum(row[columns.outputTokens])
  if (total === base + reasoning) {
    return { reasoningIncludedInOutput: false }
  }
  if (total === base) {
    return { reasoningIncludedInOutput: true }
  }
  return {}
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
 * Everything a row needs beyond the row itself.
 *
 * An options object rather than positional parameters because the useful
 * combinations are not nested: a caller wanting `shape` almost never wants
 * to restate `columns`, and one wanting `columns` rarely has a `window`.
 * Positionally, each of those meant passing `DEFAULT_ROW_COLUMNS` or
 * `undefined` as filler at every call site — six of them in the store this
 * was designed against.
 */
export interface RowOptions {
  /**
   * The request's `[since, until]`. Rows carrying a `priceAnchor` price
   * exactly and ignore this; the rest blend across it.
   */
  window?: readonly [TimeInput, TimeInput]
  /** Override when the table spells its columns differently. */
  columns?: RowColumns
  /**
   * How the producer nests its counts. Pass the per-source value; anything
   * `inferShape` recovers from the row is merged over it.
   */
  shape?: TokenShape
  /**
   * Let each row's own `total_tokens` settle `reasoningIncludedInOutput`,
   * overriding `shape` where it can. Off by default: it reads a column
   * nothing else in this package reads, and a store that does not carry a
   * usable total gains nothing from the lookup.
   *
   * See `inferTokenShape` for why per-source alone is not safe here.
   */
  inferShape?: boolean
}

/**
 * Price a raw SQL row that uses snake_case `*_tokens` column names, so
 * every cost-folding loop does not repeat the same nine coercions.
 */
export function estimateCostFromRow(
  catalog: PricingCatalog,
  row: Record<string, unknown>,
  options: RowOptions = {},
): CostEstimate {
  const { window, columns = DEFAULT_ROW_COLUMNS, shape = {}, inferShape = false } = options
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
    // Merged over `shape`, not under it: what the row's own total proves
    // outranks what the caller assumed about its source. `inferTokenShape`
    // returns `{}` rather than a guess whenever the row cannot settle it,
    // so this never erases a per-source value it has nothing to say about.
    ...(inferShape ? inferTokenShape(row, columns) : undefined),
    at,
    window,
  })
}
