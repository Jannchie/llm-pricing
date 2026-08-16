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
  /**
   * An informational subset of `outputTokens` — NOT added to the billed
   * output. OpenAI/Codex already fold reasoning into `output_tokens`, and
   * modern clients do the same for Gemini/OpenCode. Kept as a parameter so
   * callers can keep passing it.
   */
  reasoningOutputTokens?: number
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
 * Apply a resolved rate card to a set of token counts.
 *
 * Pure and stateless — every catalogue/schedule decision has already been
 * made by the time this runs, which is what makes it exhaustively testable.
 */
export function costFromRates(rates: Rates, tokens: TokenCounts): number {
  const cacheCreation = count(tokens.cacheCreationInputTokens)
  // Split the cache-creation total by ephemeral TTL. `known1h` is clamped
  // to the total so a malformed/over-counted 1h split can never bill more
  // creation tokens than were actually written. Everything else (the 5m
  // split plus any unsplit remainder) bills at the default creation rate;
  // only the 1h portion takes the 2x input rate. When the 1h split is 0
  // (legacy / split-unknown), this collapses to the original single-rate
  // formula exactly.
  const known1h = Math.min(count(tokens.cacheCreation1hInputTokens), cacheCreation)
  const creationDefaultRate = Math.max(0, cacheCreation - known1h)
  // Codex / OpenAI emit only `cachedInputTokens` (a subset of input) and
  // never split it into cache_read vs cache_creation. Clients therefore
  // write 0 (not NULL) into the cache-read field, so a plain `??` fallback
  // never fires. Treat an explicit 0 the same as "absent" and derive cache
  // read from `cachedInputTokens` — otherwise 90%+ of Codex input would
  // silently get charged at the full prompt rate instead of the much
  // cheaper cache-read rate.
  const explicitCacheRead = count(tokens.cacheReadInputTokens)
  const cached = count(tokens.cachedInputTokens)
  const cacheRead = explicitCacheRead > 0
    ? explicitCacheRead
    : Math.max(0, cached - cacheCreation)
  // `cachedInputTokens` is the ONLY count documented as part of
  // `inputTokens`, so it is the only one carved back out of it.
  //
  // Anthropic reports `input_tokens` as the fresh tokens alone, with
  // `cache_creation_input_tokens` and `cache_read_input_tokens` beside it
  // rather than inside it; so does any client that has already split hit
  // from miss. Subtracting those there bills real fresh input at $0 —
  // silently, because the result is a smaller number rather than an error.
  // Measured against four agent CLIs' own cost figures, that was the whole
  // of the disagreement: correcting it reproduced two of them exactly and
  // left the Codex-shaped one untouched.
  const fresh = Math.max(0, count(tokens.inputTokens) - Math.min(cached, count(tokens.inputTokens)))
  const output = count(tokens.outputTokens)
  return fresh * rates.inputCostPerToken
    + creationDefaultRate * rates.cacheCreationInputCostPerToken
    + known1h * rates.inputCostPerToken * CACHE_CREATE_1H_INPUT_MULTIPLIER
    + cacheRead * rates.cacheReadInputCostPerToken
    // outputTokens already includes reasoning; do not add
    // reasoningOutputTokens here.
    + output * rates.outputCostPerToken
}
