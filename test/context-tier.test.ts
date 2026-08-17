import type { ModelsDevResponse } from '../src/catalog/modelsdev'
import type { SnapshotModels } from '../src/catalog/sync'
import type { ContextTier, PriceSchedule, Rates } from '../src/types'
import { describe, expect, it, vi } from 'vitest'
import { PricingCatalog } from '../src/catalog'
import { contextTiersFrom, parseModelsDev, ratesFromCost } from '../src/catalog/modelsdev'
import { mergeSnapshot } from '../src/catalog/sync'
import { promptTokensBilled } from '../src/estimate'
import { normalizeSchedule } from '../src/normalize'
import { mergeLiveQuote, periodPricesEqual, scaleSchedule } from '../src/rates'
import { contextTierFor, hasContextTiers, ratesFor } from '../src/schedule'
import { sumEstimates } from '../src/total'
import { DAY_MS, RATE_KEYS } from '../src/types'

// $/MTok, converted at the boundary so the expectations below read in the
// units the vendors publish.
function rates(input: number, output: number, cacheRead = input / 10, cacheWrite = cacheRead): Rates {
  return {
    inputCostPerToken: input / 1e6,
    cacheCreationInputCostPerToken: cacheWrite / 1e6,
    cacheReadInputCostPerToken: cacheRead / 1e6,
    cachedInputCostPerToken: cacheRead / 1e6,
    outputCostPerToken: output / 1e6,
  }
}

// The real shape of the case this feature exists for: gpt-5.5, whose whole
// request doubles on input and takes output to 1.5x above a 272k prompt.
const GPT_55: PriceSchedule = {
  displayName: 'GPT-5.5',
  source: 'modelsdev',
  periods: [{
    from: Number.NEGATIVE_INFINITY,
    rates: rates(5, 30, 0.5),
    contextTiers: [{ abovePromptTokens: 272_000, rates: rates(10, 45, 1) }],
  }],
}

function tiered(overrides: Partial<PriceSchedule> = {}): PricingCatalog {
  return new PricingCatalog({ sources: [], overrides: { 'gpt-5.5': { ...GPT_55, ...overrides } } })
}

// What a 400k-prompt, 1000-output request costs on `GPT_55`, at each card.
const LONG_COUNTS = { inputTokens: 400_000, cachedInputTokens: 0, outputTokens: 1000 }
const LONG_ON_BASE = 400_000 * 5e-6 + 1000 * 30e-6
const LONG_ON_TIER = 400_000 * 10e-6 + 1000 * 45e-6

// Anthropic's own >200k premium existed until 2026-03-13 and was then
// withdrawn — the case that forces tiers to live inside a period.
//
// Module-scoped because "one period tiered, one not" is the shape every test
// of tiers against the time axis needs, and a second fixture saying the same
// thing with different numbers is two places to update when tier semantics
// move.
const WITHDRAWN_AT = Date.UTC(2026, 2, 13)
const withdrawn: PriceSchedule = {
  displayName: 'Claude Sonnet 4.5',
  source: 'override',
  sqlMatch: ['%sonnet%'],
  periods: [
    {
      from: Number.NEGATIVE_INFINITY,
      rates: rates(3, 15, 0.3, 3.75),
      contextTiers: [{ abovePromptTokens: 200_000, rates: rates(6, 22.5, 0.6, 7.5) }],
    },
    { from: WITHDRAWN_AT, rates: rates(3, 15, 0.3, 3.75) },
  ],
}

function withdrawnCatalog(): PricingCatalog {
  return new PricingCatalog({ sources: [], overrides: { 'claude-sonnet-4-5': withdrawn } })
}

describe('selecting a long-context tier', () => {
  const catalog = tiered()

  it('leaves an aggregated row on the base card', () => {
    // 400k of input in one row, but nothing says it was one request — ten
    // 40k requests look identical here, and none of those crossed 272k.
    const { cost, pricing } = catalog.estimate({ model: 'gpt-5.5', ...LONG_COUNTS })
    expect(pricing?.contextTierAbove).toBeUndefined()
    expect(cost).toBeCloseTo(LONG_ON_BASE, 10)
  })

  it('applies the tier once the caller states the row is one request', () => {
    const { cost, pricing } = catalog.estimate({ model: 'gpt-5.5', ...LONG_COUNTS, perRequest: true })
    expect(pricing?.contextTierAbove).toBe(272_000)
    // Output is billed at the tier rate even though it never counted toward
    // the threshold.
    expect(cost).toBeCloseTo(LONG_ON_TIER, 10)
  })

  it('treats the threshold as strictly greater than', () => {
    const at = catalog.estimate({ model: 'gpt-5.5', inputTokens: 272_000, cachedInputTokens: 0, outputTokens: 0, perRequest: true })
    const over = catalog.estimate({ model: 'gpt-5.5', inputTokens: 272_001, cachedInputTokens: 0, outputTokens: 0, perRequest: true })
    expect(at.pricing?.contextTierAbove).toBeUndefined()
    expect(over.pricing?.contextTierAbove).toBe(272_000)
  })

  it('measures the threshold on the prompt, not on output', () => {
    // 200k prompt with 200k of output does not cross a 272k prompt threshold,
    // even though the row bills 400k tokens in total.
    const { pricing } = catalog.estimate({
      model: 'gpt-5.5',
      inputTokens: 200_000,
      cachedInputTokens: 0,
      outputTokens: 200_000,
      perRequest: true,
    })
    expect(pricing?.contextTierAbove).toBeUndefined()
  })

  it('counts cache reads and writes toward the prompt', () => {
    // The prompt is 300k long; only 20k of it is fresh. Billing the fresh
    // part alone would keep this request off the tier it really paid.
    const counts = {
      model: 'gpt-5.5',
      inputTokens: 300_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 80_000,
      cacheReadInputTokens: 200_000,
      outputTokens: 500,
      perRequest: true,
    }
    expect(promptTokensBilled(counts)).toBe(300_000)
    expect(catalog.estimate(counts).pricing?.contextTierAbove).toBe(272_000)
  })

  it('bills a 1h cache write at twice the tier input rate, not the base', () => {
    const { cost } = catalog.estimate({
      model: 'gpt-5.5',
      inputTokens: 300_000,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 300_000,
      cacheCreation1hInputTokens: 300_000,
      outputTokens: 0,
      perRequest: true,
    })
    // 2x the tier's $10 input, not 2x the base $5.
    expect(cost).toBeCloseTo(300_000 * 10e-6 * 2, 10)
  })

  it('picks the highest threshold a prompt clears', () => {
    const catalog = tiered({
      periods: [{
        from: Number.NEGATIVE_INFINITY,
        rates: rates(1, 2),
        contextTiers: [
          { abovePromptTokens: 128_000, rates: rates(2, 4) },
          { abovePromptTokens: 512_000, rates: rates(4, 8) },
        ],
      }],
    })
    const tierOf = (inputTokens: number): number | undefined =>
      catalog.estimate({ model: 'gpt-5.5', inputTokens, cachedInputTokens: 0, outputTokens: 0, perRequest: true })
        .pricing
        ?.contextTierAbove
    expect(tierOf(100_000)).toBeUndefined()
    expect(tierOf(200_000)).toBe(128_000)
    expect(tierOf(600_000)).toBe(512_000)
  })

  it('lets an explicit prompttokens override the derived length', () => {
    // A producer that stores the context length but folds its cache counts
    // together: the components under-report the prompt, the column does not.
    const { pricing } = catalog.estimate({
      model: 'gpt-5.5',
      inputTokens: 5000,
      cachedInputTokens: 0,
      outputTokens: 100,
      promptTokens: 400_000,
    })
    expect(pricing?.contextTierAbove).toBe(272_000)
  })

  it('reports base and tier as separate cards in a total', () => {
    const short = { model: 'gpt-5.5', inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100, perRequest: true }
    const long = { model: 'gpt-5.5', inputTokens: 400_000, cachedInputTokens: 0, outputTokens: 100, perRequest: true }
    const total = sumEstimates([short, long, short].map(args => catalog.estimate(args)))
    expect(total.cards).toHaveLength(2)
    expect(total.cards.map(card => card.pricing.contextTierAbove)).toEqual([272_000, undefined])
    expect(total.cards.find(card => card.pricing.contextTierAbove === undefined)?.count).toBe(2)
  })

  it('exposes the tier through getprice for display', () => {
    expect(catalog.getPrice('gpt-5.5')?.inputCostPerToken).toBe(5e-6)
    expect(catalog.getPrice('gpt-5.5', undefined, 400_000)?.inputCostPerToken).toBe(10e-6)
    expect(catalog.getPrice('gpt-5.5', undefined, 400_000)?.contextTierAbove).toBe(272_000)
  })
})

describe('what an undeclared row admits it does not know', () => {
  const catalog = tiered()

  it('bounds an aggregated row by the tier it could not rule out', () => {
    // The defect this replaces: `low === high === cost` on the base card,
    // which says "one card was possible" about a model where two are.
    const { cost, low, high } = catalog.estimate({ model: 'gpt-5.5', ...LONG_COUNTS })
    expect(low).toBeCloseTo(cost, 12)
    expect(high).toBeCloseTo(LONG_ON_TIER, 10)
    expect(high / cost).toBeCloseTo(1.99, 2)
  })

  it('closes the interval once the caller states the grain', () => {
    for (const args of [{ perRequest: true }, { perRequest: true, promptTokens: 1000 }]) {
      const { cost, low, high } = catalog.estimate({ model: 'gpt-5.5', ...LONG_COUNTS, ...args })
      expect(low).toBeCloseTo(cost, 12)
      expect(high).toBeCloseTo(cost, 12)
    }
  })

  it('leaves an untiered model exact', () => {
    const flat = new PricingCatalog({ sources: [], overrides: {
      m: { displayName: 'M', source: 'override', periods: [{ from: Number.NEGATIVE_INFINITY, rates: rates(5, 30) }] },
    } })
    const { cost, low, high } = flat.estimate({ model: 'm', ...LONG_COUNTS })
    expect(low).toBe(cost)
    expect(high).toBe(cost)
  })

  // The two time paths (`at` and `window`) against a schedule where only one
  // period is tiered — reusing the withdrawn-premium fixture rather than
  // building a mirror of it.
  const sonnet = withdrawnCatalog()
  const onTier = 400_000 * 6e-6 + 1000 * 22.5e-6

  it('bounds an exact instant too, since knowing when says nothing about how long', () => {
    const { cost, low, high, basis } = sonnet.estimate({
      model: 'claude-sonnet-4-5',
      ...LONG_COUNTS,
      at: WITHDRAWN_AT - DAY_MS,
    })
    expect(basis).toBe('exact')
    expect(low).toBeCloseTo(cost, 12)
    expect(high).toBeCloseTo(onTier, 10)
  })

  it('claims nothing extra at an instant whose period has no tier', () => {
    const { cost, low, high } = sonnet.estimate({
      model: 'claude-sonnet-4-5',
      ...LONG_COUNTS,
      at: WITHDRAWN_AT + DAY_MS,
    })
    expect(low).toBe(cost)
    expect(high).toBe(cost)
  })

  it('bounds a blend by the tiers of every period the window drew on', () => {
    const { cost, low, high, basis } = sonnet.estimate({
      model: 'claude-sonnet-4-5',
      ...LONG_COUNTS,
      window: [WITHDRAWN_AT - 30 * DAY_MS, WITHDRAWN_AT + 30 * DAY_MS],
    })
    expect(basis).toBe('blended')
    // The base rate never moved, so the blend itself is not what widens this.
    expect(low).toBeCloseTo(cost, 12)
    expect(high).toBeCloseTo(onTier, 10)
  })

  it('sums the interval across a mixed workload', () => {
    const undeclared = catalog.estimate({ model: 'gpt-5.5', ...LONG_COUNTS })
    const declared = catalog.estimate({ model: 'gpt-5.5', ...LONG_COUNTS, perRequest: true })
    const total = sumEstimates([undeclared, declared])
    // Both rows' floors are what they were costed at, so only the ceiling
    // moves — the total is exact about the declared row and open about the
    // other, which is the only honest reading of that pair.
    expect(total.low).toBeCloseTo(total.cost, 10)
    expect(total.high).toBeCloseTo(declared.cost * 2, 10)
    expect(total.high).toBeGreaterThan(total.cost)
  })
})

describe('tiers alongside the time dimensions', () => {
  const catalog = withdrawnCatalog()
  const long = {
    model: 'claude-sonnet-4-5',
    inputTokens: 400_000,
    cachedInputTokens: 0,
    outputTokens: 1000,
    perRequest: true,
  }

  it('charges the premium before it was withdrawn', () => {
    const { cost, pricing, basis } = catalog.estimate({ ...long, at: WITHDRAWN_AT - DAY_MS })
    expect(basis).toBe('exact')
    expect(pricing?.contextTierAbove).toBe(200_000)
    expect(cost).toBeCloseTo(400_000 * 6e-6 + 1000 * 22.5e-6, 10)
  })

  it('does not re-price that history after the withdrawal', () => {
    const { cost, pricing } = catalog.estimate({ ...long, at: WITHDRAWN_AT + DAY_MS })
    expect(pricing?.contextTierAbove).toBeUndefined()
    expect(cost).toBeCloseTo(400_000 * 3e-6 + 1000 * 15e-6, 10)
  })

  it('blends across the withdrawal and claims no tier', () => {
    const { basis, pricing, low, high, cost } = catalog.estimate({
      ...long,
      window: [WITHDRAWN_AT - DAY_MS, WITHDRAWN_AT + DAY_MS],
    })
    expect(basis).toBe('blended')
    // The averaged card belongs to neither period's tier, so naming one
    // would report a rate this row did not pay.
    expect(pricing?.contextTierAbove).toBeUndefined()
    expect(cost).toBeGreaterThan(low)
    expect(cost).toBeLessThan(high)
  })

  it('keeps the tier when every weighted period carries the same one', () => {
    const { basis, pricing } = catalog.estimate({
      ...long,
      window: [WITHDRAWN_AT - 3 * DAY_MS, WITHDRAWN_AT - DAY_MS],
    })
    expect(basis).toBe('blended')
    expect(pricing?.contextTierAbove).toBe(200_000)
  })

  it('does not let one row\'s tier leak into the next through the blend memo', () => {
    const window = [WITHDRAWN_AT - 3 * DAY_MS, WITHDRAWN_AT - DAY_MS] as const
    const short = catalog.estimate({ ...long, inputTokens: 1000, window })
    const big = catalog.estimate({ ...long, window })
    const shortAgain = catalog.estimate({ ...long, inputTokens: 1000, window })
    expect(short.pricing?.contextTierAbove).toBeUndefined()
    expect(big.pricing?.contextTierAbove).toBe(200_000)
    expect(shortAgain.pricing?.contextTierAbove).toBeUndefined()
    expect(shortAgain.cost).toBeCloseTo(short.cost, 12)
  })

  it('keeps a peak schedule and drops a tier that contradicts it', () => {
    const onWarn = vi.fn()
    const normalized = normalizeSchedule({
      source: 'override',
      sqlMatch: ['%x%'],
      periods: [{
        from: Number.NEGATIVE_INFINITY,
        rates: rates(1, 2),
        peak: { windowsUtc: [[1, 4]], rates: rates(2, 4) },
        contextTiers: [{ abovePromptTokens: 200_000, rates: rates(9, 9) }],
      }],
    }, onWarn, 'x')!
    expect(normalized.periods[0]!.peak).toBeDefined()
    expect(normalized.periods[0]!.contextTiers).toBeUndefined()
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('peak window and a long-context tier'), undefined)
  })
})

describe('normalising tiers at ingest', () => {
  const base = { from: Number.NEGATIVE_INFINITY, rates: rates(1, 2) }

  function gate(contextTiers: ContextTier[], onWarn = vi.fn()) {
    const normalized = normalizeSchedule({ source: 'fallback', periods: [{ ...base, contextTiers }] }, onWarn, 'm')
    return { tiers: normalized?.periods[0]!.contextTiers, onWarn }
  }

  it('sorts thresholds ascending so the highest match cannot be skipped', () => {
    const { tiers } = gate([
      { abovePromptTokens: 512_000, rates: rates(4, 8) },
      { abovePromptTokens: 128_000, rates: rates(2, 4) },
    ])
    expect(tiers?.map(t => t.abovePromptTokens)).toEqual([128_000, 512_000])
  })

  it('drops a threshold of zero rather than making the tier the base rate', () => {
    const { tiers, onWarn } = gate([{ abovePromptTokens: 0, rates: rates(9, 9) }])
    expect(tiers).toBeUndefined()
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('unusable threshold'), undefined)
  })

  it('drops a non-finite threshold', () => {
    expect(gate([{ abovePromptTokens: Number.NaN, rates: rates(9, 9) }]).tiers).toBeUndefined()
    expect(gate([{ abovePromptTokens: Number.POSITIVE_INFINITY, rates: rates(9, 9) }]).tiers).toBeUndefined()
  })

  it('keeps one card per threshold', () => {
    const { tiers, onWarn } = gate([
      { abovePromptTokens: 200_000, rates: rates(6, 12) },
      { abovePromptTokens: 200_000, rates: rates(7, 14) },
    ])
    expect(tiers).toHaveLength(1)
    expect(tiers?.[0]!.rates.inputCostPerToken).toBe(6e-6)
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('two long-context tiers'), undefined)
  })

  it('rejects a schedule whose tier quotes an unbillable rate', () => {
    const onWarn = vi.fn()
    const dropped = normalizeSchedule({
      source: 'fallback',
      periods: [{ ...base, contextTiers: [{ abovePromptTokens: 200_000, rates: rates(-1, 2) }] }],
    }, onWarn, 'm')
    expect(dropped).toBeNull()
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('unbillable rate'), undefined)
  })

  it('returns an untiered schedule by identity so the tables stay shared', () => {
    const schedule: PriceSchedule = { source: 'fallback', periods: [base] }
    expect(normalizeSchedule(schedule)).toBe(schedule)
  })

  it('returns an already-valid tiered schedule by identity too', () => {
    const schedule: PriceSchedule = {
      source: 'fallback',
      periods: [{ ...base, contextTiers: [{ abovePromptTokens: 200_000, rates: rates(2, 4) }] }],
    }
    expect(normalizeSchedule(schedule)).toBe(schedule)
  })
})

describe('the schedule primitives', () => {
  it('selects nothing when the caller has not stated a prompt length', () => {
    const period = { from: Number.NEGATIVE_INFINITY, rates: rates(1, 2), contextTiers: [{ abovePromptTokens: 100, rates: rates(2, 4) }] }
    expect(contextTierFor(period, undefined)).toBeNull()
    expect(contextTierFor(period, 101)?.abovePromptTokens).toBe(100)
  })

  it('reports whether a schedule prices by prompt size at all', () => {
    expect(hasContextTiers(GPT_55)).toBe(true)
    expect(hasContextTiers({ source: 'fallback', periods: [{ from: Number.NEGATIVE_INFINITY, rates: rates(1, 2) }] })).toBe(false)
  })

  it('applies a tier on the flat fast path, which is where most tiered models live', () => {
    const normalized = normalizeSchedule(GPT_55)!
    const resolved = ratesFor(normalized, undefined, undefined, Date.now(), 400_000)
    expect(resolved.basis).toBe('flat')
    expect(resolved.rates.inputCostPerToken).toBe(10e-6)
    expect(resolved.tierAbove).toBe(272_000)
  })
})

describe('deriving tiers from a variant', () => {
  it('scales a fast tier\'s long-context card with the rest of the schedule', () => {
    const scaled = scaleSchedule(GPT_55, 2, 'Fast')
    const tier = scaled.periods[0]!.contextTiers![0]!
    expect(tier.abovePromptTokens).toBe(272_000)
    expect(tier.rates.inputCostPerToken).toBe(20e-6)
    expect(tier.rates.outputCostPerToken).toBe(90e-6)
  })

  it('prices a -fast variant of a tiered model through the catalogue', () => {
    // `gpt-5.4-fast` is derived from `gpt-5.4` at 2x, and gpt-5.4 is tiered
    // upstream. Losing the tier here would undercharge long fast requests.
    const catalog = new PricingCatalog({
      sources: [],
      overrides: { 'gpt-5.4': { ...GPT_55, displayName: 'GPT-5.4' } },
    })
    const { pricing } = catalog.estimate({
      model: 'gpt-5.4-fast',
      inputTokens: 400_000,
      cachedInputTokens: 0,
      outputTokens: 0,
      perRequest: true,
    })
    expect(pricing?.contextTierAbove).toBe(272_000)
    expect(pricing?.inputCostPerToken).toBe(20e-6)
  })
})

function payload(cost: Record<string, unknown>): ModelsDevResponse {
  return { openai: { models: { 'gpt-5.5': { id: 'gpt-5.5', name: 'GPT-5.5', cost } } } } as ModelsDevResponse
}

describe('parsing tiers from models.dev', () => {
  const upstream = {
    input: 5,
    output: 30,
    cache_read: 0.5,
    tiers: [{ input: 10, output: 45, cache_read: 1, tier: { type: 'context', size: 272_000 } }],
  }

  it('reads the published context tier', () => {
    const tiers = parseModelsDev(payload(upstream)).get('gpt-5.5')!.periods[0]!.contextTiers!
    expect(tiers).toHaveLength(1)
    expect(tiers[0]!.abovePromptTokens).toBe(272_000)
    expect(tiers[0]!.rates.inputCostPerToken).toBe(10e-6)
    expect(tiers[0]!.rates.outputCostPerToken).toBe(45e-6)
    expect(tiers[0]!.rates.cacheReadInputCostPerToken).toBe(1e-6)
  })

  it('leaves an untiered model untiered', () => {
    expect(parseModelsDev(payload({ input: 5, output: 30 })).get('gpt-5.5')!.periods[0]!.contextTiers).toBeUndefined()
  })

  it('ignores the redundant context_over_200k restatement', () => {
    // Reading both would quote one model two thresholds for the same rates.
    const tiers = parseModelsDev(payload({ ...upstream, context_over_200k: { input: 10, output: 45 } }))
      .get('gpt-5.5')!
      .periods[0]!
      .contextTiers!
    expect(tiers).toHaveLength(1)
  })

  it('ignores a tier selected by something this package does not measure', () => {
    const tiers = contextTiersFrom({
      input: 5,
      output: 30,
      tiers: [{ input: 10, output: 45, tier: { type: 'throughput', size: 100 } }],
    }, 1e6)
    expect(tiers).toBeUndefined()
  })

  it('drops a placeholder tier rather than making long requests free', () => {
    const tiers = contextTiersFrom({
      input: 5,
      output: 30,
      tiers: [{ input: 0, output: 0, tier: { type: 'context', size: 272_000 } }],
    }, 1e6)
    expect(tiers).toBeUndefined()
  })

  it('drops a tier with a negative rate', () => {
    const tiers = contextTiersFrom({
      input: 5,
      output: 30,
      tiers: [{ input: -1, output: 45, tier: { type: 'context', size: 272_000 } }],
    }, 1e6)
    expect(tiers).toBeUndefined()
  })

  it('defaults a tier\'s cache rates from its own input rate', () => {
    const tiers = contextTiersFrom({
      input: 5,
      output: 30,
      tiers: [{ input: 10, output: 45, tier: { type: 'context', size: 272_000 } }],
    }, 1e6)!
    // 10% of the tier's input, matching how the base quote defaults — not
    // 10% of the base, which would price a long request's cache reads below
    // a short one's. Compared loosely: the `input * 0.1` default drifts in
    // its last bits, which is why `closeEnough` exists.
    expect(tiers[0]!.rates.cacheReadInputCostPerToken).toBeCloseTo(1e-6, 12)
  })

  // The shape `openrouter`'s `google/gemini-2.5-pro` is published in, and 10
  // other listings with it: the base quotes a cache-write rate and the tier
  // does not. Defaulting to the tier's own cache_read made a long request's
  // cache writes CHEAPER than a short one's, while its input doubled.
  const partial = {
    input: 1.25,
    output: 10,
    cache_read: 0.125,
    cache_write: 0.375,
    tiers: [{ input: 2.5, output: 15, cache_read: 0.25, tier: { type: 'context', size: 200_000 } }],
  }

  it('inherits a rate the tier omits from the base, scaled by the tier\'s input ratio', () => {
    const tier = contextTiersFrom(partial, 1e6)![0]!
    // 0.375 x (2.5 / 1.25), not the tier's own 0.25 cache_read.
    expect(tier.rates.cacheCreationInputCostPerToken).toBeCloseTo(0.75e-6, 12)
  })

  it('never prices an inherited tier rate below the base card', () => {
    const base = ratesFromCost(partial, 1e6)
    const tier = contextTiersFrom(partial, 1e6)![0]!
    for (const key of RATE_KEYS) {
      expect(tier.rates[key]).toBeGreaterThanOrEqual(base[key])
    }
  })

  it('never overrides a rate the tier states, even a cheaper one', () => {
    // `llmgateway`'s grok-4-20 pair really does quote a tier cheaper on
    // output. A quoted number is evidence; only a missing one is inferred.
    const tier = contextTiersFrom({
      input: 2,
      output: 6,
      cache_write: 4,
      tiers: [{ input: 2.5, output: 5, cache_write: 1, tier: { type: 'context', size: 128_000 } }],
    }, 1e6)![0]!
    expect(tier.rates.outputCostPerToken).toBe(5e-6)
    expect(tier.rates.cacheCreationInputCostPerToken).toBe(1e-6)
  })

  it('falls back to the generic default when the base has no ratio to scale by', () => {
    const tier = contextTiersFrom({
      input: 0,
      output: 30,
      cache_write: 4,
      tiers: [{ input: 10, output: 45, tier: { type: 'context', size: 272_000 } }],
    }, 1e6)![0]!
    // A base input of 0 leaves no ratio, so scaling 4 by it would be
    // arbitrary; the tier's own 10% default applies instead.
    expect(tier.rates.cacheReadInputCostPerToken).toBeCloseTo(1e-6, 12)
    expect(tier.rates.cacheCreationInputCostPerToken).toBeCloseTo(1e-6, 12)
  })

  it('archives a partially-quoted tier the same way the live index reads it', () => {
    // The archive answers whenever the network is down, so a correction only
    // the live path applied would be a rate that changes with connectivity.
    const { models } = mergeSnapshot({}, payload(partial), ['openai'], '2026-08-17')
    const [, periods] = models['gpt-5.5']!
    expect(periods[0]![5]).toEqual([[200_000, 2.5, 0.75, 0.25, 15]])
  })
})

describe('the archive', () => {
  const api = {
    openai: {
      models: {
        'gpt-5.5': {
          id: 'gpt-5.5',
          name: 'GPT-5.5',
          cost: {
            input: 5,
            output: 30,
            cache_read: 0.5,
            tiers: [{ input: 10, output: 45, cache_read: 1, tier: { type: 'context', size: 272_000 } }],
          },
        },
      },
    },
  } as unknown as ModelsDevResponse

  it('writes the tier alongside the base rates', () => {
    const { models } = mergeSnapshot({}, api, ['openai'], '2026-08-17')
    expect(models['gpt-5.5']).toEqual(['GPT-5.5', [[null, 5, 0.5, 0.5, 30, [[272_000, 10, 1, 1, 45]]]]])
  })

  it('leaves an untiered model on the five-element row it always had', () => {
    const flat = { openai: { models: { 'gpt-5.5': { id: 'gpt-5.5', name: 'GPT-5.5', cost: { input: 5, output: 30 } } } } } as unknown as ModelsDevResponse
    expect(mergeSnapshot({}, flat, ['openai'], '2026-08-17').models['gpt-5.5']![1][0]).toHaveLength(5)
  })

  it('records a reprice when only the tier moved', () => {
    // The failure this guards: the base rate holds steady while the >272k
    // rate doubles. Comparing base rates alone reads that as unchanged and
    // keeps yesterday's long-context price forever.
    const previous: SnapshotModels = { 'gpt-5.5': ['GPT-5.5', [[null, 5, 0.5, 0.5, 30, [[272_000, 10, 1, 1, 45]]]]] }
    const moved = structuredClone(api) as any
    moved.openai.models['gpt-5.5'].cost.tiers[0].input = 20
    const { models, repriced } = mergeSnapshot(previous, moved, ['openai'], '2026-08-17')
    expect(repriced).toBe(1)
    expect(models['gpt-5.5']![1]).toHaveLength(2)
    expect(models['gpt-5.5']![1][1]![0]).toBe('2026-08-17')
  })

  it('backfills a first tier in place rather than inventing a price change', () => {
    // gpt-5.5 has had its 272k rate since launch; this package simply did
    // not record tiers before. Dating the tier today would assert every
    // earlier row was untiered, and would hand a flat model a two-period
    // history it would then blend across.
    const previous: SnapshotModels = { 'gpt-5.5': ['GPT-5.5', [[null, 5, 0.5, 0.5, 30]]] }
    const { repriced, backfilled, models } = mergeSnapshot(previous, api, ['openai'], '2026-08-17')
    expect(repriced).toBe(0)
    expect(backfilled).toBe(1)
    expect(models['gpt-5.5']![1]).toHaveLength(1)
    expect(models['gpt-5.5']![1][0]).toEqual([null, 5, 0.5, 0.5, 30, [[272_000, 10, 1, 1, 45]]])
  })

  it('backfills only into the latest period, leaving older observations alone', () => {
    const previous: SnapshotModels = {
      'gpt-5.5': ['GPT-5.5', [[null, 4, 0.4, 0.4, 24], ['2026-06-01', 5, 0.5, 0.5, 30]]],
    }
    const { models } = mergeSnapshot(previous, api, ['openai'], '2026-08-17')
    // Today's quote is evidence about today's period only — an earlier
    // period's tier is not something it can speak to.
    expect(models['gpt-5.5']![1][0]![5]).toBeUndefined()
    expect(models['gpt-5.5']![1][1]![5]).toEqual([[272_000, 10, 1, 1, 45]])
  })

  it('treats a new tier as a reprice once the archive records tiers at all', () => {
    // The backfill is a one-time migration. After it, a tier that appears is
    // a vendor introducing a premium, and backfilling it would assert a
    // charge over history that nobody paid.
    const previous: SnapshotModels = {
      'gpt-5.5': ['GPT-5.5', [[null, 5, 0.5, 0.5, 30]]],
      'gpt-5.6': ['GPT-5.6', [[null, 5, 0.5, 0.5, 30, [[272_000, 10, 1, 1, 45]]]]],
    }
    const { repriced, backfilled, models } = mergeSnapshot(previous, api, ['openai'], '2026-08-17')
    expect(backfilled).toBe(0)
    expect(repriced).toBe(1)
    expect(models['gpt-5.5']![1]).toHaveLength(2)
    expect(models['gpt-5.5']![1][1]![0]).toBe('2026-08-17')
  })

  it('records a reprice when a tier is withdrawn', () => {
    // The Anthropic case: the premium disappears and the base rate stays.
    const previous: SnapshotModels = { 'gpt-5.5': ['GPT-5.5', [[null, 5, 0.5, 0.5, 30, [[272_000, 10, 1, 1, 45]]]]] }
    const flat = { openai: { models: { 'gpt-5.5': { id: 'gpt-5.5', name: 'GPT-5.5', cost: { input: 5, output: 30, cache_read: 0.5 } } } } } as unknown as ModelsDevResponse
    const { repriced, models } = mergeSnapshot(previous, flat, ['openai'], '2026-08-17')
    expect(repriced).toBe(1)
    expect(models['gpt-5.5']![1][1]).toHaveLength(5)
  })

  it('reports no reprice when nothing moved', () => {
    const previous: SnapshotModels = { 'gpt-5.5': ['GPT-5.5', [[null, 5, 0.5, 0.5, 30, [[272_000, 10, 1, 1, 45]]]]] }
    expect(mergeSnapshot(previous, api, ['openai'], '2026-08-17').repriced).toBe(0)
  })
})

describe('grafting a live quote onto the archive', () => {
  const archived: PriceSchedule = {
    source: 'fallback',
    periods: [{
      from: Number.NEGATIVE_INFINITY,
      rates: rates(5, 30, 0.5),
      contextTiers: [{ abovePromptTokens: 272_000, rates: rates(10, 45, 1) }],
    }],
  }
  const observedAt = Date.UTC(2026, 7, 16)

  it('treats a tier-only change as a change', () => {
    const live: PriceSchedule = {
      source: 'modelsdev',
      periods: [{
        from: Number.NEGATIVE_INFINITY,
        rates: rates(5, 30, 0.5),
        contextTiers: [{ abovePromptTokens: 272_000, rates: rates(20, 90, 2) }],
      }],
    }
    expect(periodPricesEqual(archived.periods[0]!, live.periods[0]!)).toBe(false)
    const merged = mergeLiveQuote(archived, live, observedAt)
    expect(merged.periods).toHaveLength(2)
    expect(merged.periods[1]!.contextTiers![0]!.rates.inputCostPerToken).toBe(20e-6)
  })

  it('carries the tier across when the base rate changes', () => {
    const live: PriceSchedule = {
      source: 'modelsdev',
      periods: [{
        from: Number.NEGATIVE_INFINITY,
        rates: rates(6, 36, 0.6),
        contextTiers: [{ abovePromptTokens: 272_000, rates: rates(12, 54, 1.2) }],
      }],
    }
    const merged = mergeLiveQuote(archived, live, observedAt)
    // Grafting the base rate while dropping the tier would price every long
    // request from here on at the new base.
    expect(merged.periods[1]!.contextTiers![0]!.rates.inputCostPerToken).toBe(12e-6)
  })

  it('records a withdrawal as a new untiered period', () => {
    const live: PriceSchedule = {
      source: 'modelsdev',
      periods: [{ from: Number.NEGATIVE_INFINITY, rates: rates(5, 30, 0.5) }],
    }
    const merged = mergeLiveQuote(archived, live, observedAt)
    expect(merged.periods).toHaveLength(2)
    expect(merged.periods[0]!.contextTiers).toBeDefined()
    expect(merged.periods[1]!.contextTiers).toBeUndefined()
  })

  it('keeps the history when the quote confirms it', () => {
    const merged = mergeLiveQuote(archived, { ...archived, source: 'modelsdev' }, observedAt)
    expect(merged.periods).toHaveLength(1)
    expect(merged.source).toBe('modelsdev')
  })
})

describe('pricing a row', () => {
  const catalog = tiered()

  it('stays on the base card by default, whatever the row contains', () => {
    const estimate = catalog.estimateFromRow({ model: 'gpt-5.5', input_tokens: 400_000, output_tokens: 100 })
    expect(estimate.pricing?.contextTierAbove).toBeUndefined()
  })

  it('applies the tier for a table whose grain is one request', () => {
    const estimate = catalog.estimateFromRow(
      { model: 'gpt-5.5', input_tokens: 400_000, output_tokens: 100 },
      { perRequest: true },
    )
    expect(estimate.pricing?.contextTierAbove).toBe(272_000)
  })

  it('prefers a prompt-length column when the row carries one', () => {
    const estimate = catalog.estimateFromRow(
      { model: 'gpt-5.5', input_tokens: 5000, output_tokens: 100, prompt_tokens: 400_000 },
      { perRequest: true },
    )
    expect(estimate.pricing?.contextTierAbove).toBe(272_000)
  })

  it('derives the length when the column is absent or zero', () => {
    const estimate = catalog.estimateFromRow(
      { model: 'gpt-5.5', input_tokens: 400_000, output_tokens: 100, prompt_tokens: 0 },
      { perRequest: true },
    )
    expect(estimate.pricing?.contextTierAbove).toBe(272_000)
  })
})

describe('the live catalogue', () => {
  it('prices a 300k-prompt gpt-5.5 request at the published long-context rate', async () => {
    // End to end against the real models.dev shape: parse, normalise,
    // resolve, bill. $10/$45 per MTok above 272k.
    const body = JSON.stringify({
      openai: {
        models: {
          'gpt-5.5': {
            id: 'gpt-5.5',
            name: 'GPT-5.5',
            cost: {
              input: 5,
              output: 30,
              cache_read: 0.5,
              tiers: [{ input: 10, output: 45, cache_read: 1, tier: { type: 'context', size: 272_000 } }],
            },
          },
        },
      },
    })
    const catalog = new PricingCatalog({
      fetch: vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof globalThis.fetch,
    })
    await catalog.ensureLoaded()

    const counts = {
      model: 'gpt-5.5',
      inputTokens: 300_000,
      cachedInputTokens: 0,
      outputTokens: 4000,
      at: Date.now(),
    }
    const aggregated = catalog.estimate(counts)
    const perRequest = catalog.estimate({ ...counts, perRequest: true })

    expect(aggregated.cost).toBeCloseTo(300_000 * 5e-6 + 4000 * 30e-6, 10)
    expect(perRequest.cost).toBeCloseTo(300_000 * 10e-6 + 4000 * 45e-6, 10)
    expect(perRequest.pricing?.contextTierAbove).toBe(272_000)
    // The whole point: reading this row as aggregated undercharges it ~2x.
    expect(perRequest.cost / aggregated.cost).toBeCloseTo(1.96, 2)
  })
})
