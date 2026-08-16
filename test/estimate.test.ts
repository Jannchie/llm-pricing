import type { Rates } from '../src/types'
import { describe, expect, it } from 'vitest'
import { CACHE_CREATE_1H_INPUT_MULTIPLIER, costFromRates } from '../src/estimate'

// Distinct powers of ten per dimension so any mis-attribution is visible in
// the resulting digits rather than hidden by a coincidental sum.
const RATES: Rates = {
  inputCostPerToken: 1e-6,
  cacheCreationInputCostPerToken: 1e-5,
  cacheReadInputCostPerToken: 1e-7,
  cachedInputCostPerToken: 1e-7,
  outputCostPerToken: 1e-4,
}

describe('costfromrates', () => {
  it('splits input into fresh, creation and read', () => {
    const cost = costFromRates(RATES, {
      inputTokens: 1000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 500,
      outputTokens: 10,
    })
    // fresh = 1000 - 200 - 500 = 300, the default superset reading.
    expect(cost).toBeCloseTo(300 * 1e-6 + 200 * 1e-5 + 500 * 1e-7 + 10 * 1e-4, 12)
  })

  it('derives cache read from cachedinputtokens when the split is absent', () => {
    // The Codex shape: only `cachedInputTokens`, and the cache-read column
    // written as an explicit 0 rather than NULL.
    const cost = costFromRates(RATES, {
      inputTokens: 1000,
      cachedInputTokens: 900,
      cacheReadInputTokens: 0,
      outputTokens: 0,
    })
    expect(cost).toBeCloseTo(100 * 1e-6 + 900 * 1e-7, 12)
  })

  it('prefers an explicit cache-read count over the derived one', () => {
    const cost = costFromRates(RATES, {
      inputTokens: 1000,
      cachedInputTokens: 900,
      cacheReadInputTokens: 400,
      outputTokens: 0,
    })
    expect(cost).toBeCloseTo(600 * 1e-6 + 400 * 1e-7, 12)
  })

  it('bills the 1h cache-creation split at 2x input', () => {
    const cost = costFromRates(RATES, {
      inputTokens: 500,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 500,
      cacheCreation1hInputTokens: 200,
      outputTokens: 0,
    })
    expect(cost).toBeCloseTo(300 * 1e-5 + 200 * 1e-6 * CACHE_CREATE_1H_INPUT_MULTIPLIER, 12)
  })

  it('is unchanged when the ttl split is unknown', () => {
    const tokens = { inputTokens: 500, cachedInputTokens: 0, cacheCreationInputTokens: 500, outputTokens: 0 }
    expect(costFromRates(RATES, tokens)).toBeCloseTo(
      costFromRates(RATES, { ...tokens, cacheCreation1hInputTokens: 0, cacheCreation5mInputTokens: 500 }),
      12,
    )
  })

  it('clamps an over-counted 1h split to the creation total', () => {
    const cost = costFromRates(RATES, {
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 100,
      cacheCreation1hInputTokens: 999_999,
      outputTokens: 0,
    })
    expect(cost).toBeCloseTo(100 * 1e-6 * CACHE_CREATE_1H_INPUT_MULTIPLIER, 12)
  })

  it('does not bill reasoning tokens on top of output', () => {
    const base = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 1000 }
    expect(costFromRates(RATES, { ...base, reasoningOutputTokens: 800 }))
      .toBe(costFromRates(RATES, base))
  })

  it('never goes negative when the parts exceed the input total', () => {
    const cost = costFromRates(RATES, {
      inputTokens: 10,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 100,
      outputTokens: 0,
    })
    expect(cost).toBeGreaterThanOrEqual(0)
  })

  it('ignores negative token counts', () => {
    const cost = costFromRates(RATES, {
      inputTokens: -5,
      cachedInputTokens: 0,
      cacheCreationInputTokens: -5,
      cacheReadInputTokens: -5,
      outputTokens: 0,
    })
    expect(cost).toBe(0)
  })

  it('is zero for an empty row', () => {
    expect(costFromRates(RATES, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 })).toBe(0)
  })
})

describe('cache counts are siblings of the input count, not part of it', () => {
  // Only `cachedInputTokens` is documented as a subset of `inputTokens` —
  // it is the OpenAI/Codex shape, where `input_tokens` is the total and the
  // cached part is carved out of it. Anthropic, and every client that has
  // already split hit from miss (DeepSeek via dsh, pi), report
  // `input_tokens` as the fresh part ALONE. Subtracting the cache counts
  // from it there bills real fresh input at $0.
  const rates: Rates = {
    inputCostPerToken: 5e-6,
    cacheCreationInputCostPerToken: 6.25e-6,
    cacheReadInputCostPerToken: 5e-7,
    cachedInputCostPerToken: 5e-7,
    outputCostPerToken: 25e-6,
  }

  it('bills fresh input that arrives alongside a cache read', () => {
    // A real Claude Code turn: 2 fresh, 1603 written, 198363 read.
    const cost = costFromRates(rates, {
      inputIncludesCache: false,
      inputTokens: 2,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 1603,
      cacheReadInputTokens: 198_363,
      outputTokens: 422,
    })
    const expected = 2 * 5e-6 + 1603 * 6.25e-6 + 198_363 * 5e-7 + 422 * 25e-6
    expect(cost).toBeCloseTo(expected, 12)
  })

  it('bills fresh input on a first turn that only writes cache', () => {
    // No read at all, so nothing can be inferred from one being present.
    const cost = costFromRates(rates, {
      inputIncludesCache: false,
      inputTokens: 1000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 5000,
      outputTokens: 0,
    })
    expect(cost).toBeCloseTo(1000 * 5e-6 + 5000 * 6.25e-6, 12)
  })

  it('still carves the cached part out of a codex total', () => {
    // The one shape where input IS the total: 30236 total, 21248 of it
    // served from cache, so only 8988 is fresh.
    const cost = costFromRates(rates, {
      inputTokens: 30_236,
      cachedInputTokens: 21_248,
      outputTokens: 1391,
    })
    expect(cost).toBeCloseTo(8988 * 5e-6 + 21_248 * 5e-7 + 1391 * 25e-6, 12)
  })
})

describe('who decides whether input already contains the cache counts', () => {
  // Measured across two producers of the SAME underlying turns:
  //
  //   Claude Code's own jsonl   input_tokens = fresh only      (siblings)
  //   codetime's collector      input_tokens = the whole total (superset)
  //
  // 46,960 rows of codetime's `agent_session_models` satisfy
  // `total = input + output` exactly and never once have
  // `input < cache_read`. So the nesting is a property of the producer, not
  // of the vendor, and the library cannot infer it: a sibling row with big
  // fresh input and a small cache write looks exactly like a superset row.
  //
  // The default is superset because the failure directions are not
  // symmetric. Reading a superset as siblings bills cache reads at the full
  // input rate — a ~10x OVERCHARGE on 90% of tokens. The reverse only drops
  // the fresh component.
  const RATES2: Rates = {
    inputCostPerToken: 5e-6,
    cacheCreationInputCostPerToken: 6.25e-6,
    cacheReadInputCostPerToken: 5e-7,
    cachedInputCostPerToken: 5e-7,
    outputCostPerToken: 25e-6,
  }
  const superset = { inputTokens: 200_000, cachedInputTokens: 0, cacheCreationInputTokens: 1600, cacheReadInputTokens: 198_363, outputTokens: 0 }

  it('carves the cache counts out of input by default', () => {
    const cost = costFromRates(RATES2, superset)
    const fresh = 200_000 - 1600 - 198_363
    expect(cost).toBeCloseTo(fresh * 5e-6 + 1600 * 6.25e-6 + 198_363 * 5e-7, 12)
  })

  it('bills input as fresh when the producer reports siblings', () => {
    const cost = costFromRates(RATES2, { ...superset, inputTokens: 2, inputIncludesCache: false })
    expect(cost).toBeCloseTo(2 * 5e-6 + 1600 * 6.25e-6 + 198_363 * 5e-7, 12)
  })

  it('never bills a cache read at the input rate by accident', () => {
    // The expensive mistake, pinned: reading codetime's shape with the
    // wrong convention would cost ~10x.
    const wrong = costFromRates(RATES2, { ...superset, inputIncludesCache: false })
    expect(wrong / costFromRates(RATES2, superset)).toBeGreaterThan(5)
  })
})

describe('whether reasoning is inside the output count', () => {
  // Same class of problem as `inputIncludesCache`, on the output side.
  //
  // OpenAI and Anthropic fold reasoning into `output_tokens`, so billing it
  // again would double-charge. Gemini does not: `thoughtsTokenCount` sits
  // beside `candidatesTokenCount` and inside `totalTokenCount`, and Google
  // bills it at the output rate. Measured in codetime's table, gemini's and
  // hermes' `total - (input + output)` equals `sum(reasoning)` to the
  // token, which is what a third sibling column looks like.
  const R: Rates = {
    inputCostPerToken: 0,
    cacheCreationInputCostPerToken: 0,
    cacheReadInputCostPerToken: 0,
    cachedInputCostPerToken: 0,
    outputCostPerToken: 1e-5,
  }
  const tokens = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 1000, reasoningOutputTokens: 400 }

  it('does not bill reasoning twice by default', () => {
    expect(costFromRates(R, tokens)).toBeCloseTo(1000 * 1e-5, 12)
  })

  it('bills reasoning that sits beside the output count', () => {
    expect(costFromRates(R, { ...tokens, reasoningIncludedInOutput: false }))
      .toBeCloseTo(1400 * 1e-5, 12)
  })
})
