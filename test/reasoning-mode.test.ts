import type { ModelsDevResponse } from '../src/catalog/modelsdev'
import type { PriceSchedule, Rates } from '../src/types'
import { describe, expect, it, vi } from 'vitest'
import { PricingCatalog } from '../src/catalog'
import { parseModelsDev, reasoningRatesFrom } from '../src/catalog/modelsdev'
import { mergeSnapshot } from '../src/catalog/sync'
import { usedReasoning } from '../src/estimate'
import { normalizeSchedule } from '../src/normalize'
import { mergeLiveQuote, periodPricesEqual, scaleSchedule } from '../src/rates'
import { pricesByRequest } from '../src/schedule'
import { sumEstimates } from '../src/total'

// $/MTok, converted at the boundary so the expectations read in the units the
// vendors publish.
function rates(input: number, output: number, cacheRead = input / 10, cacheWrite = cacheRead): Rates {
  return {
    inputCostPerToken: input / 1e6,
    cacheCreationInputCostPerToken: cacheWrite / 1e6,
    cacheReadInputCostPerToken: cacheRead / 1e6,
    cachedInputCostPerToken: cacheRead / 1e6,
    outputCostPerToken: output / 1e6,
  }
}

// The real case: Alibaba's qwen-plus, $0.4 input either way, $1.2 of output
// normally and $4 in thinking mode — the column its own table heads 思维链+回答.
const QWEN_PLUS: PriceSchedule = {
  displayName: 'Qwen Plus',
  source: 'modelsdev',
  periods: [{
    from: Number.NEGATIVE_INFINITY,
    rates: rates(0.4, 1.2, 0.04),
    reasoningRates: rates(0.4, 4, 0.04),
  }],
}

function qwen(overrides: Partial<PriceSchedule> = {}): PricingCatalog {
  return new PricingCatalog({ sources: [], overrides: { 'qwen-plus': { ...QWEN_PLUS, ...overrides } } })
}

// 100k of prompt and 20k of output, of which 15k reasoned.
const THINKING = {
  model: 'qwen-plus',
  inputTokens: 100_000,
  cachedInputTokens: 0,
  outputTokens: 20_000,
  reasoningOutputTokens: 15_000,
}
const ON_BASE = 100_000 * 0.4e-6 + 20_000 * 1.2e-6
const ON_THINKING = 100_000 * 0.4e-6 + 20_000 * 4e-6

describe('selecting the thinking-mode card', () => {
  const catalog = qwen()

  it('leaves an aggregated row on the base card', () => {
    // The row reasoned *somewhere*, but a sum of thinking and non-thinking
    // requests cannot be attributed to either card.
    const { cost, pricing } = catalog.estimate(THINKING)
    expect(pricing?.reasoningMode).toBeUndefined()
    expect(cost).toBeCloseTo(ON_BASE, 12)
  })

  it('applies it once the caller states the row is one request', () => {
    const { cost, pricing } = catalog.estimate({ ...THINKING, perRequest: true })
    expect(pricing?.reasoningMode).toBe(true)
    // The whole response, not just the 15k that reasoned — 思维链+回答.
    expect(cost).toBeCloseTo(ON_THINKING, 12)
    // 3.33x is the output *rate*; at this input/output mix the request itself
    // comes to 1.88x, which is what a bill actually moves by.
    expect(cost / ON_BASE).toBeCloseTo(1.875, 3)
  })

  it('leaves a per-request row that did not reason on the base card', () => {
    const { cost, pricing } = catalog.estimate({ ...THINKING, reasoningOutputTokens: 0, perRequest: true })
    expect(pricing?.reasoningMode).toBeUndefined()
    expect(cost).toBeCloseTo(ON_BASE, 12)
  })

  it('bills input at the base rate either way', () => {
    const { pricing } = catalog.estimate({ ...THINKING, perRequest: true })
    expect(pricing?.inputCostPerToken).toBeCloseTo(0.4e-6, 12)
    expect(pricing?.outputCostPerToken).toBeCloseTo(4e-6, 12)
  })

  it('reads the signal on either side of the reasoning nesting convention', () => {
    // Whether thinking tokens sit inside `outputTokens` changes how many
    // tokens are billed, never whether the request reasoned.
    for (const reasoningIncludedInOutput of [true, false]) {
      const { pricing } = catalog.estimate({ ...THINKING, reasoningIncludedInOutput, perRequest: true })
      expect(pricing?.reasoningMode).toBe(true)
    }
    expect(usedReasoning({ ...THINKING, reasoningIncludedInOutput: false })).toBe(true)
    expect(usedReasoning({ ...THINKING, reasoningOutputTokens: undefined })).toBe(false)
  })

  it('ignores the card on a model that does not price thinking apart', () => {
    const flat = new PricingCatalog({ sources: [], overrides: {
      'qwen-plus': { ...QWEN_PLUS, periods: [{ from: Number.NEGATIVE_INFINITY, rates: rates(0.4, 1.2, 0.04) }] },
    } })
    const { cost, pricing } = flat.estimate({ ...THINKING, perRequest: true })
    expect(pricing?.reasoningMode).toBeUndefined()
    expect(cost).toBeCloseTo(ON_BASE, 12)
  })

  it('reports the two cards apart in a mixed workload', () => {
    const total = sumEstimates([
      catalog.estimate({ ...THINKING, perRequest: true }),
      catalog.estimate({ ...THINKING, reasoningOutputTokens: 0, perRequest: true }),
    ])
    expect(total.cards).toHaveLength(2)
    expect(total.cards.map(c => c.pricing.reasoningMode)).toEqual([true, undefined])
  })

  it('shows what a thinking request would cost through getprice', () => {
    expect(catalog.getPrice('qwen-plus')?.outputCostPerToken).toBeCloseTo(1.2e-6, 12)
    const thinking = catalog.getPrice('qwen-plus', undefined, { usedReasoning: true })
    expect(thinking?.outputCostPerToken).toBeCloseTo(4e-6, 12)
    expect(thinking?.reasoningMode).toBe(true)
  })
})

describe('what an undeclared row admits about thinking', () => {
  const catalog = qwen()

  it('bounds the row by the card it could not rule out', () => {
    const { cost, low, high } = catalog.estimate(THINKING)
    expect(low).toBeCloseTo(cost, 12)
    expect(high).toBeCloseTo(ON_THINKING, 12)
  })

  it('bounds even a row carrying no reasoning tokens', () => {
    // Reporting zero reasoning tokens is not evidence: an aggregate sums
    // requests, and a producer that never reports them looks the same.
    const { cost, low, high } = catalog.estimate({ ...THINKING, reasoningOutputTokens: 0 })
    expect(low).toBeCloseTo(cost, 12)
    expect(high).toBeGreaterThan(cost)
  })

  it('closes the interval once the caller states the grain', () => {
    for (const args of [{ perRequest: true }, { perRequest: true, reasoningOutputTokens: 0 }]) {
      const { cost, low, high } = catalog.estimate({ ...THINKING, ...args })
      expect(low).toBeCloseTo(cost, 12)
      expect(high).toBeCloseTo(cost, 12)
    }
  })
})

describe('thinking mode alongside a long-context tier', () => {
  // Alibaba's Beijing table prices both axes: a 128k-256k prompt is $2.868/MTok
  // of output normally and $3.441 in thinking mode. Upstream publishes no model
  // with both today, so this is the shape holding the vendor's own truth.
  const both: PriceSchedule = {
    displayName: 'Qwen Plus',
    source: 'override',
    periods: [{
      from: Number.NEGATIVE_INFINITY,
      rates: rates(0.115, 0.287, 0.0115),
      reasoningRates: rates(0.115, 1.147, 0.0115),
      contextTiers: [{
        abovePromptTokens: 128_000,
        rates: rates(0.345, 2.868, 0.0345),
        reasoningRates: rates(0.345, 3.441, 0.0345),
      }],
    }],
  }
  const catalog = new PricingCatalog({ sources: [], overrides: { 'qwen-plus': both } })
  const long = { model: 'qwen-plus', inputTokens: 200_000, cachedInputTokens: 0, outputTokens: 1000, perRequest: true }

  it('picks the tier\'s own thinking card, not the base one', () => {
    const { pricing } = catalog.estimate({ ...long, reasoningOutputTokens: 500 })
    expect(pricing?.contextTierAbove).toBe(128_000)
    expect(pricing?.reasoningMode).toBe(true)
    expect(pricing?.outputCostPerToken).toBeCloseTo(3.441e-6, 12)
  })

  it('keeps the four combinations distinct', () => {
    const seen = new Set<number>()
    for (const inputTokens of [100_000, 200_000]) {
      for (const reasoningOutputTokens of [0, 500]) {
        const { pricing } = catalog.estimate({ ...long, inputTokens, reasoningOutputTokens })
        seen.add(pricing!.outputCostPerToken)
      }
    }
    expect([...seen].sort((a, b) => a - b).map(r => +(r * 1e6).toFixed(3)))
      .toEqual([0.287, 1.147, 2.868, 3.441])
  })

  it('bounds an undeclared row by the dearest of all four', () => {
    const { cost, high } = catalog.estimate({ ...long, perRequest: false, reasoningOutputTokens: 500 })
    expect(cost).toBeCloseTo(200_000 * 0.115e-6 + 1000 * 0.287e-6, 12)
    expect(high).toBeCloseTo(200_000 * 0.345e-6 + 1000 * 3.441e-6, 12)
  })
})

describe('the schedule primitives', () => {
  it('reports a schedule priced by either per-request dimension', () => {
    expect(pricesByRequest(QWEN_PLUS)).toBe(true)
    expect(pricesByRequest({
      displayName: 'M',
      source: 'fallback',
      periods: [{ from: Number.NEGATIVE_INFINITY, rates: rates(1, 2) }],
    })).toBe(false)
  })

  it('compares the thinking card when deciding whether a price moved', () => {
    const base = { from: Number.NEGATIVE_INFINITY, rates: rates(0.4, 1.2, 0.04) }
    expect(periodPricesEqual({ ...base, reasoningRates: rates(0.4, 4, 0.04) }, base)).toBe(false)
    expect(periodPricesEqual(
      { ...base, reasoningRates: rates(0.4, 4, 0.04) },
      { ...base, reasoningRates: rates(0.4, 5, 0.04) },
    )).toBe(false)
    expect(periodPricesEqual(
      { ...base, reasoningRates: rates(0.4, 4, 0.04) },
      { ...base, reasoningRates: rates(0.4, 4, 0.04) },
    )).toBe(true)
  })

  it('drops a schedule whose thinking card cannot be billed', () => {
    const onWarn = vi.fn()
    const broken = {
      ...QWEN_PLUS,
      periods: [{ ...QWEN_PLUS.periods[0]!, reasoningRates: rates(0.4, Number.NaN, 0.04) }],
    }
    expect(normalizeSchedule(broken, onWarn, 'qwen-plus')).toBeNull()
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('unbillable'), undefined)
  })

  it('scales the thinking card onto a derived variant', () => {
    const scaled = scaleSchedule(QWEN_PLUS, 2, 'Fast')
    expect(scaled.periods[0]!.rates.outputCostPerToken).toBeCloseTo(2.4e-6, 12)
    expect(scaled.periods[0]!.reasoningRates!.outputCostPerToken).toBeCloseTo(8e-6, 12)
  })
})

function payload(cost: Record<string, unknown>): ModelsDevResponse {
  return { alibaba: { models: { 'qwen-plus': { id: 'qwen-plus', name: 'Qwen Plus', cost } } } } as ModelsDevResponse
}

describe('parsing the thinking rate from models.dev', () => {
  // Exactly what models.dev publishes for alibaba/qwen-plus, which matches
  // Alibaba's own Singapore table to the cent.
  const upstream = { input: 0.4, output: 1.2, reasoning: 4 }

  it('reads a rate dearer than output as a thinking-mode card', () => {
    const period = parseModelsDev(payload(upstream)).get('qwen-plus')!.periods[0]!
    expect(period.rates.outputCostPerToken).toBeCloseTo(1.2e-6, 12)
    expect(period.reasoningRates!.outputCostPerToken).toBeCloseTo(4e-6, 12)
    // Only output moves; Alibaba charges the same input either way.
    expect(period.reasoningRates!.inputCostPerToken).toBe(period.rates.inputCostPerToken)
  })

  it('ignores a rate cheaper than output', () => {
    // Perplexity's sonar-deep-research bills reasoning tokens at $3 *plus*
    // $8 output. Read as a replacement it would price a whole response at $3.
    const period = parseModelsDev(payload({ input: 2, output: 8, reasoning: 3 })).get('qwen-plus')!.periods[0]!
    expect(period.reasoningRates).toBeUndefined()
    expect(period.rates.outputCostPerToken).toBe(8e-6)
  })

  it('ignores a placeholder zero rather than making thinking free', () => {
    expect(reasoningRatesFrom({ input: 1, output: 2, reasoning: 0 }, rates(1, 2), 1e6)).toBeUndefined()
  })

  it('ignores a rate equal to output', () => {
    expect(reasoningRatesFrom({ input: 1, output: 2, reasoning: 2 }, rates(1, 2), 1e6)).toBeUndefined()
  })

  it('ignores a non-finite rate', () => {
    expect(reasoningRatesFrom({ input: 1, output: 2, reasoning: Number.NaN }, rates(1, 2), 1e6)).toBeUndefined()
  })

  it('reads a tier\'s own thinking rate when it states one', () => {
    const period = parseModelsDev(payload({
      input: 0.115,
      output: 0.287,
      reasoning: 1.147,
      tiers: [{ input: 0.345, output: 2.868, reasoning: 3.441, tier: { type: 'context', size: 128_000 } }],
    })).get('qwen-plus')!.periods[0]!
    expect(period.contextTiers![0]!.reasoningRates!.outputCostPerToken).toBeCloseTo(3.441e-6, 12)
  })
})

describe('the archive', () => {
  const api = payload({ input: 0.4, output: 1.2, reasoning: 4 })

  it('writes the thinking rate, with a null hole where tiers would go', () => {
    const { models } = mergeSnapshot({}, api, ['alibaba'], '2026-08-18')
    // The slots are positional, so a model with a thinking rate and no tiers
    // has to say "no tiers" explicitly rather than shift the rate left.
    expect(models['qwen-plus']![1][0]).toEqual([null, 0.4, 0.040_000_000_000_000_01, 0.040_000_000_000_000_01, 1.2, null, 4])
  })

  it('reads a five-element row as neither dimension', () => {
    const previous = { 'qwen-plus': ['Qwen Plus', [[null, 0.4, 0.04, 0.04, 1.2]]] } as never
    const { repriced, backfilled } = mergeSnapshot(previous, api, ['alibaba'], '2026-08-18')
    // First sighting of the dimension is this package learning to record it,
    // not the vendor introducing a premium — so it is corrected in place.
    expect(repriced).toBe(0)
    expect(backfilled).toBe(1)
  })

  it('backfills only while no thinking rate is recorded anywhere', () => {
    const previous = {
      'qwen-plus': ['Qwen Plus', [[null, 0.4, 0.04, 0.04, 1.2]]],
      'qwen-turbo': ['Qwen Turbo', [[null, 0.05, 0.005, 0.005, 0.2, null, 0.5]]],
    } as never
    const { models, repriced, backfilled } = mergeSnapshot(previous, api, ['alibaba'], '2026-08-18')
    // The archive already records the dimension, so this is news: a new period.
    expect(backfilled).toBe(0)
    expect(repriced).toBe(1)
    expect(models['qwen-plus']![1]).toHaveLength(2)
    expect(models['qwen-plus']![1][1]![0]).toBe('2026-08-18')
  })

  it('records a reprice when only the thinking rate moved', () => {
    const previous = { 'qwen-plus': ['Qwen Plus', [[null, 0.4, 0.04, 0.04, 1.2, null, 3]]] } as never
    const { repriced, backfilled } = mergeSnapshot(previous, api, ['alibaba'], '2026-08-18')
    expect(backfilled).toBe(0)
    expect(repriced).toBe(1)
  })

  it('reports no reprice when nothing moved', () => {
    const previous = { 'qwen-plus': ['Qwen Plus', [[null, 0.4, 0.04, 0.04, 1.2, null, 4]]] } as never
    const { repriced, backfilled } = mergeSnapshot(previous, api, ['alibaba'], '2026-08-18')
    expect(repriced).toBe(0)
    expect(backfilled).toBe(0)
  })

  it('does not backfill a tier and a thinking rate as one event', () => {
    // Gaining the thinking rate is a backfill; the tier moving at the same
    // time is a price change, and the pair must read as the latter.
    const previous = { 'qwen-plus': ['Qwen Plus', [[null, 0.4, 0.04, 0.04, 1.2, [[128_000, 1, 0.1, 0.1, 3]]]]] } as never
    const next = payload({
      input: 0.4,
      output: 1.2,
      reasoning: 4,
      tiers: [{ input: 2, output: 6, tier: { type: 'context', size: 128_000 } }],
    })
    const { repriced, backfilled } = mergeSnapshot(previous, next, ['alibaba'], '2026-08-18')
    expect(backfilled).toBe(0)
    expect(repriced).toBe(1)
  })
})

describe('grafting a live quote onto the archive', () => {
  const archived: PriceSchedule = {
    displayName: 'Qwen Plus',
    source: 'fallback',
    periods: [{ from: Number.NEGATIVE_INFINITY, rates: rates(0.4, 1.2, 0.04), reasoningRates: rates(0.4, 4, 0.04) }],
  }
  const observedAt = Date.UTC(2026, 7, 1)

  it('treats a thinking-only change as a change', () => {
    const live: PriceSchedule = {
      displayName: 'Qwen Plus',
      source: 'modelsdev',
      periods: [{ from: Number.NEGATIVE_INFINITY, rates: rates(0.4, 1.2, 0.04), reasoningRates: rates(0.4, 5, 0.04) }],
    }
    const merged = mergeLiveQuote(archived, live, observedAt)
    expect(merged.periods).toHaveLength(2)
    expect(merged.periods[1]!.reasoningRates!.outputCostPerToken).toBe(5e-6)
  })

  it('carries the thinking card across when the base rate changes', () => {
    const live: PriceSchedule = {
      displayName: 'Qwen Plus',
      source: 'modelsdev',
      periods: [{ from: Number.NEGATIVE_INFINITY, rates: rates(0.5, 1.5, 0.05), reasoningRates: rates(0.5, 5, 0.05) }],
    }
    const merged = mergeLiveQuote(archived, live, observedAt)
    expect(merged.periods[1]!.reasoningRates!.outputCostPerToken).toBe(5e-6)
  })

  it('keeps the history when the quote confirms it', () => {
    const merged = mergeLiveQuote(archived, { ...archived, source: 'modelsdev' }, observedAt)
    expect(merged.periods).toHaveLength(1)
  })
})

describe('pricing a row', () => {
  const catalog = qwen()
  const row = {
    model: 'qwen-plus',
    input_tokens: 100_000,
    output_tokens: 20_000,
    reasoning_output_tokens: 15_000,
  }

  it('stays on the base card by default', () => {
    expect(catalog.estimateFromRow(row).pricing?.reasoningMode).toBeUndefined()
  })

  it('applies the card for a table whose grain is one request', () => {
    const { cost, pricing } = catalog.estimateFromRow(row, { perRequest: true })
    expect(pricing?.reasoningMode).toBe(true)
    expect(cost).toBeCloseTo(ON_THINKING, 12)
  })
})

describe('the live catalogue', () => {
  it('prices a qwen-plus thinking request at the published rate', async () => {
    const catalog = new PricingCatalog({ sources: [] })
    const base = catalog.getPrice('qwen-plus')
    const thinking = catalog.getPrice('qwen-plus', undefined, { usedReasoning: true })
    // Alibaba's published Singapore figures: $1.2/MTok of output, $4 thinking.
    expect(base?.outputCostPerToken).toBeCloseTo(1.2e-6, 12)
    expect(thinking?.outputCostPerToken).toBeCloseTo(4e-6, 12)
    expect(thinking?.inputCostPerToken).toBe(base?.inputCostPerToken)
  })
})
