import type { PricingSource } from '../src/sources'
import { describe, expect, it, vi } from 'vitest'
import { PricingCatalog } from '../src/catalog'
import { flatSchedule } from '../src/rates'
import { estimateCostFromRow, PRICE_ANCHOR_COLUMN } from '../src/row'

function stubSource(name: string, table: Record<string, number>): PricingSource {
  return {
    name,
    url: `https://example.test/${name}`,
    parse: () => new Map(Object.entries(table).map(([id, price]) => [
      id,
      flatSchedule(id, price, price / 10, price * 4, undefined, 'openrouter'),
    ])),
  }
}

function okFetch(): typeof globalThis.fetch {
  return vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch
}

describe('pricingcatalog offline', () => {
  const catalog = new PricingCatalog({ sources: [] })

  it('prices from the built-in fallback table', () => {
    const price = catalog.getPrice('claude-opus-5')
    expect(price?.source).toBe('fallback')
    expect(price?.inputCostPerToken).toBe(5e-6)
  })

  it('resolves a model spelled the way an agent cli stores it', () => {
    expect(catalog.getPrice('claude-haiku-4-5-20251001')?.displayName).toBe('Claude Haiku 4.5')
    expect(catalog.getPrice('gpt-5.5(xhigh)')?.displayName).toBe('GPT-5.5')
  })

  it('synthesizes fast variants at the documented multipliers', () => {
    expect(catalog.getPrice('claude-opus-4-7-fast')?.inputCostPerToken).toBeCloseTo(5e-6 * 6, 15)
    expect(catalog.getPrice('claude-opus-5-fast')?.inputCostPerToken).toBeCloseTo(5e-6 * 2, 15)
    expect(catalog.getPrice('gpt-5.5-fast')?.inputCostPerToken).toBeCloseTo(5e-6 * 2.5, 15)
  })

  it('has no fast variant for models that do not offer one', () => {
    expect(catalog.getPrice('claude-sonnet-5-fast')).toBeNull()
  })

  it('returns null and zero cost for an unknown model', () => {
    expect(catalog.getPrice('totally-made-up-model')).toBeNull()
    const result = catalog.estimate({
      model: 'totally-made-up-model',
      inputTokens: 1e6,
      cachedInputTokens: 0,
      outputTokens: 1e6,
    })
    expect(result).toEqual({ cost: 0, pricing: null, basis: 'flat' })
  })
})

describe('pricingcatalog overrides', () => {
  const catalog = new PricingCatalog({ sources: [] })

  it('prices deepseek from the first-party schedule, not a reseller quote', () => {
    const price = catalog.getPrice('deepseek-v4-pro', Date.UTC(2026, 6, 1))
    expect(price?.source).toBe('override')
    expect(price?.inputCostPerToken).toBeCloseTo(0.435 / 1e6, 15)
    // Cache creation bills at the miss rate, NOT the hit rate.
    expect(price?.cacheCreationInputCostPerToken).toBeCloseTo(0.435 / 1e6, 15)
    expect(price?.cacheReadInputCostPerToken).toBeCloseTo(0.003_625 / 1e6, 15)
  })

  it('does not re-price history when a vendor raises rates', () => {
    const before = catalog.getPrice('deepseek-v4-flash', Date.UTC(2026, 7, 16, 15))
    const after = catalog.getPrice('deepseek-v4-flash', Date.UTC(2026, 7, 16, 17))
    expect(before?.inputCostPerToken).toBeCloseTo(0.14 / 1e6, 15)
    expect(after?.inputCostPerToken).toBeCloseTo(0.22 / 1e6, 15)
  })

  it('charges peak rates inside the utc peak windows', () => {
    const offPeak = catalog.getPrice('deepseek-v4-flash', Date.UTC(2026, 8, 1, 12))
    const peak = catalog.getPrice('deepseek-v4-flash', Date.UTC(2026, 8, 1, 2))
    expect(peak!.inputCostPerToken).toBeCloseTo(offPeak!.inputCostPerToken * 2, 15)
  })

  it('exposes the sql patterns for every time-sensitive schedule', () => {
    expect(catalog.timeSensitiveSqlPatterns).toEqual(['%deepseek%'])
  })

  it('accepts caller-supplied overrides', () => {
    const custom = new PricingCatalog({
      sources: [],
      overrides: { 'claude-opus-5': flatSchedule('Custom Opus', 1e-9, 1e-10, 1e-8, undefined, 'override') },
    })
    expect(custom.getPrice('claude-opus-5')?.inputCostPerToken).toBe(1e-9)
  })
})

describe('pricingcatalog loading', () => {
  it('prefers a loaded source over the fallback table', async () => {
    const catalog = new PricingCatalog({
      sources: [stubSource('remote', { 'claude-opus-5': 9e-6 })],
      fetch: okFetch(),
    })
    await catalog.ensureLoaded()
    expect(catalog.getPrice('claude-opus-5')?.inputCostPerToken).toBe(9e-6)
    expect(catalog.state()).toMatchObject({ status: 'ready', source: 'remote', size: 1 })
  })

  it('keeps overrides ahead of a loaded source', async () => {
    const catalog = new PricingCatalog({
      sources: [stubSource('remote', { 'deepseek-v4-pro': 1.168e-6 })],
      fetch: okFetch(),
    })
    await catalog.ensureLoaded()
    expect(catalog.getPrice('deepseek-v4-pro')?.source).toBe('override')
  })

  it('fills gaps from later sources without overwriting earlier ones', async () => {
    const catalog = new PricingCatalog({
      sources: [
        stubSource('primary', { 'model-a': 1e-6 }),
        stubSource('secondary', { 'model-a': 2e-6, 'model-b': 3e-6 }),
      ],
      fetch: okFetch(),
    })
    await catalog.ensureLoaded()
    expect(catalog.getPrice('model-a')?.inputCostPerToken).toBe(1e-6)
    expect(catalog.getPrice('model-b')?.inputCostPerToken).toBe(3e-6)
    expect(catalog.state().source).toBe('primary+secondary')
  })

  it('falls back to the built-in table when the network fails', async () => {
    const warn = vi.fn()
    const catalog = new PricingCatalog({
      sources: [stubSource('remote', { 'claude-opus-5': 9e-6 })],
      fetch: vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof globalThis.fetch,
      onWarn: warn,
    })
    await catalog.ensureLoaded()
    expect(warn).toHaveBeenCalledOnce()
    expect(catalog.state().status).toBe('missing')
    expect(catalog.getPrice('claude-opus-5')?.source).toBe('fallback')
  })

  it('keeps serving the last good catalogue when a refresh fails', async () => {
    let fail = false
    const catalog = new PricingCatalog({
      sources: [stubSource('remote', { 'claude-opus-5': 9e-6 })],
      refreshMs: -1,
      fetch: vi.fn(async () => new Response('{}', { status: fail ? 500 : 200 })) as unknown as typeof globalThis.fetch,
      onWarn: () => {},
    })
    await catalog.ensureLoaded()
    fail = true
    await catalog.ensureLoaded()
    expect(catalog.state().status).toBe('stale')
    expect(catalog.getPrice('claude-opus-5')?.inputCostPerToken).toBe(9e-6)
  })

  it('fetches once while fresh and de-duplicates concurrent loads', async () => {
    const fetchImpl = okFetch()
    const catalog = new PricingCatalog({ sources: [stubSource('remote', {})], fetch: fetchImpl })
    await Promise.all([catalog.ensureLoaded(), catalog.ensureLoaded()])
    await catalog.ensureLoaded()
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('reuses one price-card object across rows sharing a rate card', () => {
    const catalog = new PricingCatalog({ sources: [] })
    const a = catalog.estimate({ model: 'gpt-5.5', inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 })
    const b = catalog.estimate({ model: 'gpt-5.5', inputTokens: 2, cachedInputTokens: 0, outputTokens: 2 })
    expect(a.pricing).toBe(b.pricing)
  })
})

describe('estimatecostfromrow', () => {
  const catalog = new PricingCatalog({ sources: [] })

  it('prices exactly when the row carries a time anchor', () => {
    const result = estimateCostFromRow(catalog, {
      model: 'deepseek-v4-flash',
      input_tokens: 1e6,
      cached_input_tokens: 0,
      output_tokens: 0,
      [PRICE_ANCHOR_COLUMN]: Date.UTC(2026, 8, 1, 2) / 1000,
    })
    expect(result.basis).toBe('exact')
    expect(result.cost).toBeCloseTo(0.44, 10)
  })

  it('blends across the request window when the anchor is null', () => {
    const result = estimateCostFromRow(catalog, {
      model: 'deepseek-v4-flash',
      input_tokens: 1e6,
      cached_input_tokens: 0,
      output_tokens: 0,
      [PRICE_ANCHOR_COLUMN]: null,
    }, [Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 2)])
    expect(result.basis).toBe('blended')
    expect(result.cost).toBeCloseTo((7 * 0.44 + 17 * 0.22) / 24, 10)
  })

  it('coerces string and null columns the way a driver returns them', () => {
    const result = estimateCostFromRow(catalog, {
      model: 'claude-opus-5',
      input_tokens: '1000000',
      cached_input_tokens: null,
      output_tokens: undefined,
    })
    expect(result.cost).toBeCloseTo(5, 10)
  })

  it('treats a missing model as unpriced rather than throwing', () => {
    expect(estimateCostFromRow(catalog, {}).cost).toBe(0)
  })
})
