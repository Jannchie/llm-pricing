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
    // fresh = 1000 - 200 - 500 = 300
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
