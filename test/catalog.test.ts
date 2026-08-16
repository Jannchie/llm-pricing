import type { PricingSource } from '../src/sources'
import { describe, expect, it, vi } from 'vitest'
import { PricingCatalog } from '../src/catalog'
import { flatSchedule } from '../src/rates'
import { DEFAULT_ROW_COLUMNS, estimateCostFromRow, inferTokenShape, PRICE_ANCHOR_COLUMN } from '../src/row'

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

  // Both adapters reject unbillable quotes at parse time, but `overrides`
  // and `fallback` are caller-supplied and reach the catalogue directly.
  // A negative rate does not merely mis-price its own model — summed into
  // a total it credits back every other model's cost — and a NaN turns
  // every aggregate it reaches into NaN.
  it('drops a caller-supplied schedule quoting an unbillable rate', () => {
    const onWarn = vi.fn()
    const guarded = new PricingCatalog({
      sources: [],
      onWarn,
      overrides: {
        'negative-model': flatSchedule('Negative', -1, -0.1, -1),
        'nan-model': flatSchedule('NaN', Number.NaN, 0, 0),
        'free-model': flatSchedule('Free', 0, 0, 0),
      },
    })
    expect(guarded.getPrice('negative-model')).toBeNull()
    expect(guarded.getPrice('nan-model')).toBeNull()
    // Zero is a real quote, not an unbillable one.
    expect(guarded.getPrice('free-model')?.inputCostPerToken).toBe(0)
    expect(onWarn).toHaveBeenCalledTimes(2)
  })

  it('does not let a dropped override shadow the fallback table', () => {
    const shadowed = new PricingCatalog({
      sources: [],
      onWarn: () => {},
      overrides: { 'claude-opus-5': flatSchedule('Poisoned', -1, -1, -1) },
    })
    // Falling through is the whole reason for dropping rather than
    // clamping: a resolved id outranks every later source.
    expect(shadowed.getPrice('claude-opus-5')?.inputCostPerToken).toBe(5e-6)
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
    expect(catalog.timeSensitiveSqlPatterns()).toEqual(['%deepseek%'])
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

  it('backs off instead of re-fetching on every call while a source is down', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof globalThis.fetch
    const catalog = new PricingCatalog({
      sources: [stubSource('remote', {})],
      fetch: fetchImpl,
      onWarn: () => {},
    })
    for (let i = 0; i < 5; i++) {
      await catalog.ensureLoaded()
    }
    expect(fetchImpl).toHaveBeenCalledOnce()
    // The archive is answering correctly throughout.
    expect(catalog.getPrice('claude-opus-5')?.source).toBe('fallback')
  })

  it('retries once the backoff window has passed', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof globalThis.fetch
    const catalog = new PricingCatalog({
      sources: [stubSource('remote', {})],
      retryMs: -1,
      fetch: fetchImpl,
      onWarn: () => {},
    })
    await catalog.ensureLoaded()
    await catalog.ensureLoaded()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('clears the backoff after a source recovers', async () => {
    let down = true
    const fetchImpl = vi.fn(async () => new Response('{}', { status: down ? 503 : 200 })) as unknown as typeof globalThis.fetch
    const catalog = new PricingCatalog({
      sources: [stubSource('remote', { 'claude-opus-5': 9e-6 })],
      retryMs: -1,
      fetch: fetchImpl,
      onWarn: () => {},
    })
    await catalog.ensureLoaded()
    down = false
    await catalog.ensureLoaded()
    expect(catalog.state().status).toBe('ready')
    await catalog.ensureLoaded()
    // Loaded and fresh: no further attempts.
    expect(fetchImpl).toHaveBeenCalledTimes(2)
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

function reasoningRow(output: number, reasoning: number, total: number) {
  return {
    model: 'claude-opus-5',
    input_tokens: 1000,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total,
  }
}

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
    }, { window: [Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 2)] })
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

  describe('infertokenshape', () => {
    it('reads reasoning as a sibling when the total says so', () => {
      // total = 1000 + 200 + 50: thinking sits beside the output count, the
      // way Gemini reports it, and Google bills it at the output rate.
      expect(inferTokenShape(reasoningRow(200, 50, 1250))).toEqual({ reasoningIncludedInOutput: false })
    })

    it('reads reasoning as folded in when the total says so', () => {
      // total = 1000 + 200: thinking is already inside output_tokens.
      expect(inferTokenShape(reasoningRow(200, 50, 1200))).toEqual({ reasoningIncludedInOutput: true })
    })

    it('declines to guess when the total matches neither convention', () => {
      // A collector bug — say a per-session cumulative leaking into a
      // per-turn total. Which component is wrong is unknowable from here.
      expect(inferTokenShape(reasoningRow(200, 50, 99_999))).toEqual({})
    })

    it('declines to guess without a total, or without reasoning to attribute', () => {
      expect(inferTokenShape({ ...reasoningRow(200, 50, 0), total_tokens: undefined })).toEqual({})
      // Both conventions cost the same when reasoning is zero.
      expect(inferTokenShape(reasoningRow(200, 0, 1200))).toEqual({})
    })

    it('changes the bill only in the sibling case', () => {
      // 1M input + 1M output + 1M reasoning against Opus 5 ($5/$25 per M).
      const beside = { model: 'claude-opus-5', input_tokens: 1e6, output_tokens: 1e6, reasoning_output_tokens: 1e6, total_tokens: 3e6 }
      const folded = { ...beside, total_tokens: 2e6 }
      expect(estimateCostFromRow(catalog, beside, { inferShape: true }).cost).toBeCloseTo(55, 10)
      expect(estimateCostFromRow(catalog, folded, { inferShape: true }).cost).toBeCloseTo(30, 10)
    })

    it('lets an explicit per-source shape be overridden per row', () => {
      // The documented composition: a source-wide default, corrected by
      // whatever the row's own total proves.
      const r = reasoningRow(200, 50, 1250)
      const shape = { inputIncludesCache: false, ...inferTokenShape(r) }
      expect(shape).toEqual({ inputIncludesCache: false, reasoningIncludedInOutput: false })
    })
  })

  it('is reachable as a method, so a caller with its own catalogue can use it', () => {
    // The bound free function only ever sees the default catalogue. Anyone
    // who needs a cache, their own sources or tenant isolation holds an
    // instance, and has to be able to price rows against it.
    const result = catalog.estimateFromRow({
      model: 'claude-opus-5',
      input_tokens: 1e6,
      output_tokens: 0,
    })
    expect(result.cost).toBeCloseTo(5, 10)
  })

  it('reads the column names the caller supplies', () => {
    const result = catalog.estimateFromRow(
      { modelName: 'claude-opus-5', prompt_tokens: 1e6, completion_tokens: 0 },
      { columns: { ...DEFAULT_ROW_COLUMNS, model: 'modelName', inputTokens: 'prompt_tokens', outputTokens: 'completion_tokens' } },
    )
    expect(result.cost).toBeCloseTo(5, 10)
  })
})
