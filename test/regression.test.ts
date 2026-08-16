import type { PricingSource } from '../src/sources'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { memoryCache } from '../src/cache'
import { PricingCatalog } from '../src/catalog'
import { parseOpenRouterModels } from '../src/catalog/openrouter'
import { costFromRates } from '../src/estimate'
import { fileCache } from '../src/node'
import { flatSchedule, mergeLiveQuote } from '../src/rates'
import { pricingCandidates } from '../src/resolve'

// Each of these reproduces a defect found by review. They are grouped by
// what actually goes wrong for a caller, not by which file holds the bug.

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

const ok = (async () => new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch

describe('a model must not silently price at $0', () => {
  it('resolves a vendor-joined name whose vendor contains a dash', () => {
    // `deepseek-deepseek-v4-pro` worked because splitting on the first dash
    // happens to be right for a single-word vendor. `x-ai-grok-4` splits
    // into `ai-grok-4` and misses everything.
    const catalog = new PricingCatalog({ sources: [] })
    expect(pricingCandidates('x-ai-grok-4')).toContain('grok-4')
    expect(pricingCandidates('z-ai-glm-4.6')).toContain('glm-4.6')
    expect(pricingCandidates('meta-llama-llama-3.3-70b-instruct')).toContain('llama-3.3-70b-instruct')
    expect(catalog.getPrice('z-ai-glm-4-6')).not.toBeNull()
  })

  it('does not invent candidates by stripping past the vendor', () => {
    // Over-stripping manufactures keys like `4-5`, and a junk key that
    // happens to exist upstream prices the wrong model.
    expect(pricingCandidates('claude-opus-4-5')).not.toContain('4-5')
  })

  it('keeps serving models from a source that failed while another succeeded', async () => {
    let failB = false
    const fetch = (async (url: string) => (failB && String(url).includes('/b'))
      ? new Response('nope', { status: 503 })
      : new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch
    const catalog = new PricingCatalog({
      sources: [stubSource('a', { 'only-a': 1e-6 }), stubSource('b', { 'only-b': 2e-6 })],
      refreshMs: -1,
      fetch,
      onWarn: () => {},
    })
    await catalog.ensureLoaded()
    expect(catalog.getPrice('only-b')?.inputCostPerToken).toBe(2e-6)

    failB = true
    await catalog.ensureLoaded()
    // Wholesale-replacing the table drops every model only the failed
    // source listed, and they price at $0 with no warning.
    expect(catalog.getPrice('only-b')?.inputCostPerToken).toBe(2e-6)
    // ...and the catalogue must admit it is no longer complete.
    expect(catalog.state().status).toBe('stale')
  })
})

describe('a bad input must not reduce the bill', () => {
  it('clamps negative token counts instead of subtracting from the cost', () => {
    const rates = flatSchedule('m', 1e-6, 1e-7, 4e-6, undefined, 'fallback').periods[0]!.rates
    const cost = costFromRates(rates, { inputTokens: 0, cachedInputTokens: 0, outputTokens: -1e6 })
    expect(cost).toBe(0)
  })
})

describe('a quoted price must be used as quoted', () => {
  it('bills a $0 cache read at $0 rather than falling back to 10% of input', () => {
    // `parseFloat(x) || default` cannot tell "free" from "absent".
    const table = parseOpenRouterModels({
      data: [{
        id: 'vendor/free-cache',
        name: 'Free Cache',
        pricing: { prompt: '0.000001', completion: '0.000002', input_cache_read: '0' },
      }],
    })
    expect(table.get('free-cache')!.periods[0]!.rates.cacheReadInputCostPerToken).toBe(0)
  })
})

describe('a peak schedule must survive a live quote', () => {
  it('refuses to graft a single number over a period that prices by hour', () => {
    const peak = flatSchedule('P', 2e-6, 2e-7, 8e-6, undefined, 'override').periods[0]!.rates
    const archive = {
      displayName: 'P',
      source: 'override' as const,
      sqlMatch: ['%p%'],
      periods: [{
        from: Number.NEGATIVE_INFINITY,
        rates: flatSchedule('P', 1e-6, 1e-7, 4e-6, undefined, 'override').periods[0]!.rates,
        peak: { windowsUtc: [[1, 4]] as Array<[number, number]>, rates: peak },
      }],
    }
    const live = flatSchedule('P', 3e-6, 3e-7, 12e-6, undefined, 'modelsdev')
    const merged = mergeLiveQuote(archive, live, Date.now() - 86_400_000)
    // One number cannot describe a two-rate day. Dropping the peak
    // under-charges every peak hour from here on.
    expect(merged.periods.at(-1)!.peak).toBeDefined()
  })
})

describe('the same model must cost the same through either entry point', () => {
  it('prices at now when the caller supplies neither an instant nor a window', () => {
    const past = Date.now() - 30 * 86_400_000
    const catalog = new PricingCatalog({
      sources: [],
      fallback: {
        m: {
          displayName: 'M',
          source: 'fallback',
          sqlMatch: ['%m%'],
          periods: [
            { from: Number.NEGATIVE_INFINITY, rates: flatSchedule('M', 1e-6, 1e-7, 4e-6, undefined, 'fallback').periods[0]!.rates },
            { from: past, rates: flatSchedule('M', 10e-6, 1e-6, 40e-6, undefined, 'fallback').periods[0]!.rates },
          ],
        },
      },
    })
    const tokens = { inputTokens: 1e6, cachedInputTokens: 0, outputTokens: 0 }
    // getPrice() with no `at` means "now". estimate() with no time meant
    // "blend the last 365 days", which is a different, much lower number.
    expect(catalog.getPrice('m')!.inputCostPerToken).toBe(10e-6)
    expect(catalog.estimate({ model: 'm', ...tokens }).cost).toBeCloseTo(10, 10)
  })
})

describe('the refresh state machine must honour its own contract', () => {
  it('backs off when a dead upstream is being papered over by a stale cache', async () => {
    const cache = memoryCache()
    let calls = 0
    const counting = (async () => {
      calls++
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch
    await new PricingCatalog({ sources: [stubSource('a', { m: 1e-6 })], cache, fetch: counting }).ensureLoaded()
    const seeded = calls

    const catalog = new PricingCatalog({
      sources: [stubSource('a', { m: 1e-6 })],
      cache,
      cacheTtlMs: -1, // the cached copy is already too old to use directly
      refreshMs: -1, // ...and the catalogue is never considered fresh
      fetch: (async () => {
        calls++
        return new Response('nope', { status: 503 })
      }) as unknown as typeof globalThis.fetch,
      onWarn: () => {},
    })
    for (let i = 0; i < 5; i++) {
      await catalog.ensureLoaded()
    }
    // Being rescued by a stale cache looked like success, so `retryMs`
    // never engaged and every request paid the upstream timeout.
    expect(calls - seeded).toBe(1)
    expect(catalog.getPrice('m')?.inputCostPerToken).toBe(1e-6)
  })

  it('does not let a forced refresh be absorbed by an in-flight normal load', async () => {
    let calls = 0
    const slow = (async () => {
      calls++
      await new Promise(resolve => setTimeout(resolve, 20))
      return new Response('{}', { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const catalog = new PricingCatalog({ sources: [stubSource('a', { m: 1e-6 })], cache: memoryCache(), fetch: slow })

    const normal = catalog.ensureLoaded()
    const forced = catalog.refresh()
    await Promise.all([normal, forced])
    // The load already running may be serving from cache — which is
    // exactly what force exists to bypass.
    expect(calls).toBe(2)
  })
})

describe('a catalogue entry must not price at a negative rate', () => {
  it('rejects a listing quoting a negative output price', async () => {
    const catalog = new PricingCatalog({
      sources: [{
        name: 'broken',
        url: 'https://example.test/broken',
        parse: () => new Map(),
      }],
      fetch: ok,
    })
    await catalog.ensureLoaded()
    const { parseModelsDev } = await import('../src/catalog/modelsdev')
    const table = parseModelsDev({
      openai: { models: { 'bad-model': { name: 'Bad', cost: { input: 1, output: -1 } } } },
    })
    expect(table.has('bad-model')).toBe(false)
  })
})

describe('a cache write must not be corrupted by a concurrent one', () => {
  it('gives each write its own temp file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'llm-pricing-concurrent-'))
    const cache = fileCache(dir)
    // Distinct payloads of distinct lengths: a fixed `${target}.${pid}.tmp`
    // name funnels all of these through one file, so the survivor can be a
    // splice of two writes rather than either one of them.
    const values = Array.from({ length: 8 }, (_, i) => String(i).repeat(20_000 * (i + 1)))
    await Promise.all(values.map(async value => cache.set('https://example.test/k', value)))
    const survivor = await cache.get('https://example.test/k')
    expect(values).toContain(survivor)
  })
})
