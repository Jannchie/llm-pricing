import type { Rates } from './types'

/**
 * Anthropic prices a 1-hour ephemeral cache write at 2x input, vs the
 * default 5-minute write at 1.25x input (the latter is what
 * `cacheCreationInputCostPerToken` already encodes).
 */
export const CACHE_CREATE_1H_INPUT_MULTIPLIER = 2

export interface TokenCounts {
  inputTokens: number
  /**
   * Whether `inputTokens` already contains `cacheCreationInputTokens` and
   * `cacheReadInputTokens`. Defaults to `true`.
   *
   * This is a property of whoever WROTE the row, not of the vendor. The
   * same turn is reported both ways: Anthropic's API — and Claude Code's
   * own log — put `input_tokens` beside the cache counts as the fresh
   * tokens alone, while a collector that normalises everything into one
   * schema (codetime's, for one, measured across 46,960 rows) stores the
   * total. It cannot be inferred: a sibling row with large fresh input and
   * a small cache write is indistinguishable from a superset row.
   *
   * Defaults to `true` because the failure directions are not symmetric.
   * Reading a superset as siblings bills cache reads at the full input rate
   * — on a cache-heavy workload a ~10x overcharge. Reading siblings as a
   * superset only drops the fresh component, which for the same workload is
   * a fraction of a percent.
   */
  inputIncludesCache?: boolean
  /**
   * Tokens served from cache as reported by providers that do NOT split
   * cache read from cache creation (OpenAI / Codex). A subset of
   * `inputTokens`.
   */
  cachedInputTokens: number
  cacheCreationInputTokens?: number
  /**
   * TTL split subsets of `cacheCreationInputTokens`. Optional; absent on
   * legacy clients. When both are 0 the cost is identical to the pre-split
   * behaviour (everything charged at `cacheCreationInputCostPerToken`).
   */
  cacheCreation5mInputTokens?: number
  cacheCreation1hInputTokens?: number
  cacheReadInputTokens?: number
  outputTokens: number
  reasoningOutputTokens?: number
  /**
   * Whether `reasoningOutputTokens` is already part of `outputTokens`.
   * Defaults to `true`.
   *
   * The output-side twin of `inputIncludesCache`, and producer-dependent
   * for the same reason. OpenAI and Anthropic fold reasoning into
   * `output_tokens`, so billing it again double-charges. Gemini does not:
   * `thoughtsTokenCount` sits beside `candidatesTokenCount` and inside
   * `totalTokenCount`, and Google charges for it at the output rate — so
   * ignoring it there drops real spend.
   *
   * Defaults to `true` because double-charging is the worse error, and
   * because it is what the two largest producers do.
   */
  reasoningIncludedInOutput?: boolean
}

/**
 * A token count, or 0 for anything that is not a usable one.
 *
 * Negatives are a caller bug that would *subtract* from the bill, and NaN
 * or Infinity propagates through every sum it reaches — one bad row turns a
 * whole aggregate into NaN, which loses more than a wrong number would.
 * Both become 0, the value a missing count already had.
 *
 * Coerced rather than type-checked, so the counts a driver hands back —
 * `bigint` for a Postgres bigint, a string for a numeric — still bill
 * instead of silently reading as zero.
 */
function count(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * The quantities a rate card is actually multiplied by, once the cache
 * carve-outs and the two nesting conventions have been applied.
 *
 * Split out so `costFromRates` and `tokensBilled` cannot disagree about
 * what was billed — a total that contradicts the cost beside it is worse
 * than no total at all. The object never escapes either caller.
 */
interface BilledTokens {
  fresh: number
  creationDefault: number
  creation1h: number
  cacheRead: number
  output: number
}

function billedTokens(tokens: TokenCounts): BilledTokens {
  // The splits are subsets of the total, so a row carrying splits but no
  // total is still describing creation tokens — reading the total alone
  // bills every one of them at zero.
  //
  // Only when the total is absent, though. A total that merely *disagrees*
  // with its splits is malformed in the other direction, and there the
  // total is the safer of the two: the clamp below is what keeps an
  // over-counted 1h split from billing more creation tokens than were
  // written, and real stores have rows like that (27 of 93,626 in the one
  // this was measured against).
  const creation1h = count(tokens.cacheCreation1hInputTokens)
  // `count` yields 0 or a positive finite number, so `||` is exactly the
  // "absent, fall back" test.
  const cacheCreation = count(tokens.cacheCreationInputTokens)
    || count(tokens.cacheCreation5mInputTokens) + creation1h
  // Split the cache-creation total by ephemeral TTL. `known1h` is clamped
  // to the total so a malformed/over-counted 1h split can never bill more
  // creation tokens than were actually written. Everything else (the 5m
  // split plus any unsplit remainder) bills at the default creation rate;
  // only the 1h portion takes the 2x input rate. When the 1h split is 0
  // (legacy / split-unknown), this collapses to the original single-rate
  // formula exactly.
  const known1h = Math.min(creation1h, cacheCreation)
  const creationDefaultRate = Math.max(0, cacheCreation - known1h)
  // Codex / OpenAI emit only `cachedInputTokens` (a subset of input) and
  // never split it into cache_read vs cache_creation. Clients therefore
  // write 0 (not NULL) into the cache-read field, so a plain `??` fallback
  // never fires. Treat an explicit 0 the same as "absent" and derive cache
  // read from `cachedInputTokens` — otherwise 90%+ of Codex input would
  // silently get charged at the full prompt rate instead of the much
  // cheaper cache-read rate.
  const cached = count(tokens.cachedInputTokens)
  const cacheRead = count(tokens.cacheReadInputTokens) || Math.max(0, cached - cacheCreation)
  // Whether the cache counts are already inside `inputTokens` is a property
  // of whoever wrote the row, not of the vendor — see `inputIncludesCache`.
  // `cachedInputTokens` is carved out either way: it is a subset by
  // definition, which is the whole reason it is a separate field.
  const input = count(tokens.inputTokens)
  const fresh = tokens.inputIncludesCache === false
    ? Math.max(0, input - Math.min(cached, input))
    : Math.max(0, input - cacheCreation - cacheRead)
  // Gemini reports reasoning beside the output count rather than inside it,
  // and Google bills it at the output rate — so for that producer it has to
  // be added, not ignored.
  const output = count(tokens.outputTokens)
    + (tokens.reasoningIncludedInOutput === false ? count(tokens.reasoningOutputTokens) : 0)
  return { fresh, creationDefault: creationDefaultRate, creation1h: known1h, cacheRead, output }
}

/**
 * Apply a resolved rate card to a set of token counts.
 *
 * Pure and stateless — every catalogue/schedule decision has already been
 * made by the time this runs, which is what makes it exhaustively testable.
 */
export function costFromRates(rates: Rates, tokens: TokenCounts): number {
  const b = billedTokens(tokens)
  return b.fresh * rates.inputCostPerToken
    + b.creationDefault * rates.cacheCreationInputCostPerToken
    + b.creation1h * rates.inputCostPerToken * CACHE_CREATE_1H_INPUT_MULTIPLIER
    + b.cacheRead * rates.cacheReadInputCostPerToken
    + b.output * rates.outputCostPerToken
}

/**
 * The prompt length a long-context tier is selected against: everything on
 * the input side of the bill, and nothing from the output side.
 *
 * The same quantity `costFromRates` bills at the three input rates, which
 * is what makes it the right measure — the vendors' threshold is on the
 * prompt, and the prompt is exactly fresh input plus whatever part of it
 * was read from or written to cache. Output tokens are billed at the tier's
 * rate once it is crossed but never count toward crossing it.
 *
 * Only meaningful for a single request. Summed over a day it says nothing
 * about whether any individual request cleared a threshold, which is why
 * `estimate` consults it only under `perRequest`.
 */
export function promptTokensBilled(tokens: TokenCounts): number {
  const b = billedTokens(tokens)
  return b.fresh + b.creationDefault + b.creation1h + b.cacheRead
}

/**
 * How many tokens `costFromRates` would bill for the same counts.
 *
 * Not the row's `total_tokens`: cache reads and fresh input are counted
 * once each rather than twice, and reasoning is included only when it sits
 * outside `outputTokens`. It answers "how much usage does this cost cover",
 * which is what makes an unpriced row's $0 legible as a gap.
 */
export function tokensBilled(tokens: TokenCounts): number {
  const b = billedTokens(tokens)
  return b.fresh + b.creationDefault + b.creation1h + b.cacheRead + b.output
}
