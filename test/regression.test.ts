import type { PricingSource } from '../src/sources'
import type { PriceSchedule, Rates } from '../src/types'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { memoryCache } from '../src/cache'
import { PricingCatalog } from '../src/catalog'
import { parseOpenRouterModels } from '../src/catalog/openrouter'
import { costFromRates } from '../src/estimate'
import { fileCache } from '../src/node'
import { normalizeSchedule } from '../src/normalize'
import { flatSchedule, mergeLiveQuote } from '../src/rates'
import { pricingCandidates } from '../src/resolve'
import { PRICE_ANCHOR_COLUMN } from '../src/row'
import { periodAt, ratesFor } from '../src/schedule'

// Each of these reproduces a defect found by review. They are grouped by
// what actually goes wrong for a caller, not by which file holds the bug.

/** A flat rate card at `perMTok` dollars per million input tokens. */
function rates(perMTok: number): Rates {
  return flatSchedule('x', perMTok / 1e6, perMTok / 1e7, perMTok * 4 / 1e6, undefined, 'fallback').periods[0]!.rates
}

/** A catalogue whose only model `m` runs the given schedule. */
function build(periods: PriceSchedule['periods'], sqlMatch: string[] = ['%m%']): PricingCatalog {
  return new PricingCatalog({ sources: [], fallback: { m: { displayName: 'M', source: 'fallback', sqlMatch, periods } } })
}

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

describe('hosted platforms and gateways wrap the vendor id', () => {
  const catalog = new PricingCatalog({ sources: [] })

  it('strips a bedrock dotted vendor prefix and version suffix', () => {
    expect(pricingCandidates('anthropic.claude-opus-4-5-20250514-v1:0')).toContain('claude-opus-4-5')
    expect(pricingCandidates('bedrock/anthropic.claude-3-5-haiku-20241022-v1:0')).toContain('claude-3-5-haiku')
    expect(pricingCandidates('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toContain('claude-sonnet-4-5')
  })

  it('strips a vertex date suffix', () => {
    expect(pricingCandidates('claude-opus-4-5@20250514')).toContain('claude-opus-4-5')
  })

  it('takes the last segment of a deep path', () => {
    expect(pricingCandidates('publishers/anthropic/models/claude-sonnet-4-5')).toContain('claude-sonnet-4-5')
    expect(pricingCandidates('accounts/fireworks/models/kimi-k2-instruct')).toContain('kimi-k2-instruct')
  })

  it('strips an openrouter routing modifier', () => {
    // `:nitro` and `:floor` pick an endpoint; the listed price is the same.
    expect(pricingCandidates('z-ai/glm-4.6:nitro')).toContain('glm-4.6')
    expect(pricingCandidates('openai/gpt-5.5:floor')).toContain('gpt-5.5')
  })

  it('does not strip :free, which is a different price tier', () => {
    // Resolving it to the paid listing would bill a free route.
    expect(pricingCandidates('deepseek/deepseek-v3.2:free')).not.toContain('deepseek-v3.2')
    expect(catalog.getPrice('deepseek/deepseek-v3.2:free')).toBeNull()
  })

  it('does not mangle a version number that merely contains a dot', () => {
    // A blind `^segment.` strip turns `gpt-3.5-turbo` into `5-turbo`.
    const candidates = pricingCandidates('gpt-3.5-turbo')
    expect(candidates).toContain('gpt-3.5-turbo')
    expect(candidates).not.toContain('5-turbo')
  })

  it('still misses what genuinely has no listed price', () => {
    // An Azure deployment name is arbitrary, and a local Ollama model has
    // no price at all. Inventing one would be worse than reporting none.
    expect(catalog.getPrice('my-gpt5-deployment')).toBeNull()
    expect(catalog.getPrice('ollama/llama3')).toBeNull()
  })
})

describe('a broken cache must not break the catalogue', () => {
  // `fileCache` swallows its own errors, but the documented contract is
  // "any string store", and a Redis client rejects when Redis is down.
  const source = stubSource('a', { m: 9e-6 })

  it('still fetches when the cache cannot be read', async () => {
    let fetched = 0
    const catalog = new PricingCatalog({
      sources: [source],
      cache: { get: async () => {
        throw new Error('redis down')
      }, set: async () => {} },
      fetch: (async () => {
        fetched++
        return new Response('{}', { status: 200 })
      }) as unknown as typeof globalThis.fetch,
      onWarn: () => {},
    })
    await catalog.ensureLoaded()
    // A cache is an optimisation. Its failure must not disable the source.
    expect(fetched).toBe(1)
    expect(catalog.getPrice('m')?.inputCostPerToken).toBe(9e-6)
  })

  it('keeps a successful download the cache refused to store', async () => {
    const catalog = new PricingCatalog({
      sources: [source],
      cache: { get: async () => null, set: async () => {
        throw new Error('redis down')
      } },
      fetch: ok,
      onWarn: () => {},
    })
    await catalog.ensureLoaded()
    // The fetch succeeded; throwing away its result because the write-through
    // failed is the most expensive possible response to a cache problem.
    expect(catalog.getPrice('m')?.inputCostPerToken).toBe(9e-6)
    expect(catalog.state().status).toBe('ready')
  })
})

describe('a hung upstream must not hang the caller', () => {
  it('gives up on a fetch that never settles', async () => {
    const catalog = new PricingCatalog({
      sources: [stubSource('hang', { m: 1e-6 })],
      timeoutMs: 50,
      fetch: (() => new Promise(() => {})) as unknown as typeof globalThis.fetch,
      onWarn: () => {},
    })
    // `ensureLoaded()` is documented as safe on a per-request path.
    const settled = await Promise.race([
      catalog.ensureLoaded().then(() => 'settled'),
      new Promise(resolve => setTimeout(resolve, 500, 'hung')),
    ])
    expect(settled).toBe('settled')
    expect(catalog.getPrice('claude-opus-5')?.source).toBe('fallback')
  })
})

describe('one bad row must not poison an aggregate', () => {
  const rates = flatSchedule('m', 1e-6, 1e-7, 4e-6, undefined, 'fallback').periods[0]!.rates

  it('treats a non-finite token count as zero', () => {
    // A single NaN turns the whole summed total into NaN, which loses more
    // than a wrong number would.
    expect(costFromRates(rates, { inputTokens: Number.NaN, cachedInputTokens: 0, outputTokens: 0 })).toBe(0)
    expect(costFromRates(rates, { inputTokens: 0, cachedInputTokens: 0, outputTokens: Number.POSITIVE_INFINITY })).toBe(0)
    expect(costFromRates(rates, { inputTokens: undefined as unknown as number, cachedInputTokens: 0, outputTokens: 0 })).toBe(0)
  })
})

describe('more shapes a stored model name comes in', () => {
  it('strips a dash-separated release date', () => {
    // `-20240229` is handled; `-2024-02-29` is the same thing with dashes,
    // and is how OpenAI and Bedrock write it.
    expect(pricingCandidates('o1-mini-2024-09-12')).toContain('o1-mini')
    expect(pricingCandidates('claude-3-opus-2024-02-29')).toContain('claude-3-opus')
  })

  it('ignores a trailing slash', () => {
    expect(pricingCandidates('anthropic/claude-opus-5/')).toContain('claude-opus-5')
  })
})

describe('a window must describe a real interval', () => {
  const catalog = new PricingCatalog({ sources: [] })
  const tokens = { inputTokens: 1e6, cachedInputTokens: 0, outputTokens: 0 }
  const day = [Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 2)] as const

  it('reads a reversed window as the interval it names', () => {
    const forward = catalog.estimate({ model: 'deepseek-v4-flash', window: day, ...tokens })
    const reversed = catalog.estimate({ model: 'deepseek-v4-flash', window: [day[1], day[0]], ...tokens })
    expect(reversed.cost).toBeCloseTo(forward.cost, 10)
  })

  it('prices a zero-width window at that instant', () => {
    const peak = Date.UTC(2026, 8, 1, 2)
    const result = catalog.estimate({ model: 'deepseek-v4-flash', window: [peak, peak], ...tokens })
    expect(result.basis).toBe('exact')
    expect(result.cost).toBeCloseTo(catalog.estimate({ model: 'deepseek-v4-flash', at: peak, ...tokens }).cost, 10)
  })
})

describe('a price anchor must be read in the documented unit', () => {
  it('does not silently price a millisecond anchor at a far-future instant', () => {
    const catalog = new PricingCatalog({ sources: [] })
    // Before DeepSeek's peak schedule took effect, so reading the value as
    // milliseconds lands in a different *period*, not merely a different
    // hour — the error becomes visible instead of coincidentally invisible.
    const seconds = Date.UTC(2026, 6, 1) / 1000
    const asSeconds = catalog.estimateFromRow({ model: 'deepseek-v4-flash', input_tokens: 1e6, [PRICE_ANCHOR_COLUMN]: seconds })
    const asMs = catalog.estimateFromRow({ model: 'deepseek-v4-flash', input_tokens: 1e6, [PRICE_ANCHOR_COLUMN]: seconds * 1000 })
    expect(asSeconds.cost).toBeCloseTo(0.14, 10)
    // An epoch-seconds value above 1e12 is the year 33658; it is a caller
    // passing milliseconds, not a real timestamp.
    expect(asMs.cost).toBeCloseTo(asSeconds.cost, 10)
  })
})

describe('token counts arrive in whatever shape the driver used', () => {
  const rates = flatSchedule('m', 1e-6, 1e-7, 4e-6, undefined, 'fallback').periods[0]!.rates

  it('bills a bigint or a numeric string rather than reading it as zero', () => {
    // node-postgres returns bigint columns as strings, and some drivers as
    // BigInt. Both reach `costFromRates` directly when a caller builds the
    // token counts itself.
    expect(costFromRates(rates, { inputTokens: 1_000_000n as unknown as number, cachedInputTokens: 0, outputTokens: 0 })).toBeCloseTo(1, 10)
    expect(costFromRates(rates, { inputTokens: '1000000' as unknown as number, cachedInputTokens: 0, outputTokens: 0 })).toBeCloseTo(1, 10)
  })
})

describe('a schedule the caller supplied must not silently mis-price', () => {
  it('does not crash on a schedule with no periods', () => {
    const catalog = build([])
    expect(() => catalog.getPrice('m')).not.toThrow()
    expect(catalog.getPrice('m')).toBeNull()
  })

  it('reads periods in time order however they were listed', () => {
    // `periodAt` walks until the first period that starts later, so an
    // out-of-order list silently returns the wrong era's rate.
    const catalog = build([
      { from: Date.UTC(2026, 6, 1), rates: rates(10) },
      { from: Number.NEGATIVE_INFINITY, rates: rates(1) },
    ])
    expect(catalog.getPrice('m', Date.UTC(2026, 7, 1))!.inputCostPerToken).toBeCloseTo(10e-6, 15)
    expect(catalog.getPrice('m', Date.UTC(2026, 0, 1))!.inputCostPerToken).toBeCloseTo(1e-6, 15)
  })

  it('keeps a blended rate inside [off-peak, peak] whatever the windows say', () => {
    const day: readonly [number, number] = [Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 2)]
    const tokens = { inputTokens: 1e6, cachedInputTokens: 0, outputTokens: 0 }
    for (const windowsUtc of [
      [[4, 1]], // reversed: produced a NEGATIVE peak duration
      [[25, 30]], // hours that do not exist
      [[-2, 3]], // ...nor these
      [[1, 5], [3, 8]], // overlapping: the shared hours were counted twice
    ] as Array<Array<[number, number]>>) {
      const catalog = build([{ from: Number.NEGATIVE_INFINITY, rates: rates(1), peak: { windowsUtc, rates: rates(2) } }])
      const cost = catalog.estimate({ model: 'm', window: day, ...tokens }).cost
      expect(cost, `windows ${JSON.stringify(windowsUtc)}`).toBeGreaterThanOrEqual(1)
      expect(cost, `windows ${JSON.stringify(windowsUtc)}`).toBeLessThanOrEqual(2)
    }
  })

  it('counts overlapping peak windows once', () => {
    // [1,5) and [3,8) cover 7 hours, not 9.
    const catalog = build([{ from: Number.NEGATIVE_INFINITY, rates: rates(1), peak: { windowsUtc: [[1, 5], [3, 8]], rates: rates(2) } }])
    const cost = catalog.estimate({
      model: 'm',
      window: [Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 2)],
      inputTokens: 1e6,
      cachedInputTokens: 0,
      outputTokens: 0,
    }).cost
    expect(cost).toBeCloseTo((7 * 2 + 17 * 1) / 24, 10)
  })

  it('warns when a time-sensitive schedule cannot tell the query layer about itself', () => {
    // Without `sqlMatch` no LIKE pattern is emitted, so every row blends
    // across the request window instead of pricing exactly — quietly.
    const warn = vi.fn()
    const catalog = new PricingCatalog({
      sources: [],
      onWarn: warn,
      fallback: {
        m: {
          displayName: 'M',
          source: 'fallback',
          periods: [
            { from: Number.NEGATIVE_INFINITY, rates: rates(1) },
            { from: Date.UTC(2026, 6, 1), rates: rates(9) },
          ],
        },
      },
    })
    expect(catalog.timeSensitiveSqlPatterns()).toEqual(['%deepseek%'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sqlMatch'), undefined)
  })
})

describe('a long-lived process must not grow without bound', () => {
  it('caps the resolved-lookup memo', () => {
    // The memo is keyed by the raw stored string. Anywhere a model name can
    // reach it from user input, an unbounded Map is a leak that outlives
    // every request.
    const catalog = new PricingCatalog({ sources: [] })
    for (let i = 0; i < 60_000; i++) {
      catalog.getPrice(`junk-model-${i}`)
    }
    expect(catalog.resolvedSize).toBeLessThanOrEqual(50_000)
    // ...and it still works afterwards.
    expect(catalog.getPrice('claude-opus-5')?.inputCostPerToken).toBe(5e-6)
  })
})

describe('a schedule whose history does not reach back far enough', () => {
  // `PriceSchedule.periods` documents that the first entry opens at
  // -Infinity so any timestamp resolves. Nothing enforced it, and both
  // consumers of a schedule break differently when it does not hold.
  const late = [
    { from: Date.UTC(2026, 0, 1), rates: rates(10) },
    { from: Date.UTC(2026, 6, 1), rates: rates(20) },
  ]

  it('prices a row from before the first period instead of crashing', () => {
    const catalog = build(late)
    // `blendRates` clips every period to the window, so a window entirely
    // before the first period leaves it with nothing to average — and it
    // documents that this cannot happen.
    const price = catalog.getPrice('m')
    expect(price).not.toBeNull()
    const { cost } = catalog.estimate({
      model: 'm',
      window: [Date.UTC(2025, 0, 1), Date.UTC(2025, 5, 1)],
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    })
    // The earliest rate we know about is the honest answer for a row that
    // predates the archive; anything else invents a price.
    expect(cost).toBeCloseTo(10, 6)
  })

  it('anchors the first period at -infinity so an instant before it resolves', () => {
    const catalog = build(late)
    const { cost } = catalog.estimate({
      model: 'm',
      at: Date.UTC(2025, 0, 1),
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
    })
    expect(cost).toBeCloseTo(10, 6)
  })
})

describe('an unvalidated schedule must not reach the pricing primitives', () => {
  // The primitives run once per priced row and so check nothing — that is
  // why validation happens at ingest. Before `NormalizedSchedule` existed
  // only a comment said so, and two producers (`mergeLiveQuote`,
  // `scaleSchedule`) did in fact bypass the gate. These assertions fail to
  // compile if the brand is ever dropped: `@ts-expect-error` is itself an
  // error when the line it guards type-checks.
  const raw: PriceSchedule = {
    source: 'fallback',
    periods: [{ from: Number.NEGATIVE_INFINITY, rates: rates(1) }],
  }

  it('is a type error to price one directly', () => {
    // @ts-expect-error a raw PriceSchedule has not been through the gate
    expect(() => ratesFor(raw, Date.now(), undefined)).not.toThrow()
    // @ts-expect-error ...and neither has one the caller hand-built
    expect(() => periodAt(raw, Date.now())).not.toThrow()
  })

  it('accepts the same schedule once it has been normalised', () => {
    const gated = normalizeSchedule(raw)!
    expect(ratesFor(gated, Date.now(), undefined).basis).toBe('flat')
    expect(periodAt(gated, Date.now()).rates.inputCostPerToken).toBe(1e-6)
  })
})

describe('the row api must be able to say what shape the rows are', () => {
  it('passes the nesting convention through to the estimate', () => {
    // A store that merges several agents into one schema needs this per
    // source: gemini rows carry reasoning beside output, claude rows do not,
    // and both live in the same table.
    const catalog = new PricingCatalog({ sources: [] })
    const row = {
      model: 'claude-opus-5',
      input_tokens: 0,
      cached_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 1000,
      reasoning_output_tokens: 400,
    }
    const folded = catalog.estimateFromRow(row).cost
    const beside = catalog.estimateFromRow(row, undefined, undefined, { reasoningIncludedInOutput: false }).cost
    expect(beside / folded).toBeCloseTo(1.4, 9)
  })
})
