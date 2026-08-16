import { describe, expect, it } from 'vitest'
import { parseModelsDev } from '../src/catalog/modelsdev'
import { parseOpenRouterModels } from '../src/catalog/openrouter'

describe('parseopenroutermodels', () => {
  const table = parseOpenRouterModels({
    data: [
      {
        id: 'anthropic/claude-opus-5',
        name: 'Claude Opus 5',
        pricing: { prompt: '0.000005', completion: '0.000025', input_cache_read: '0.0000005', input_cache_write: '0.00000625' },
      },
      {
        id: 'openai/gpt-5-mini',
        name: 'GPT-5 Mini',
        pricing: { prompt: '0.00000025', completion: '0.000002' },
      },
      { id: 'broken/no-pricing' },
      { id: 'broken/unparseable', pricing: { prompt: 'free', completion: 'free' } },
      // OpenRouter's real sentinel for "the router picks the endpoint, so
      // there is no price yet" — quoted on openrouter/auto and four more.
      { id: 'openrouter/auto', name: 'Auto Router', pricing: { prompt: '-1', completion: '-1' } },
      // Free is not the same as unpriced: 19 of 413 live listings quote 0/0
      // in earnest, so these have to survive where the sentinel does not.
      { id: 'vendor/really-free:free', name: 'Really Free', pricing: { prompt: '0', completion: '0' } },
      // A negative on a cache field alone must not discard an otherwise
      // usable listing — it falls back the same way an absent field does.
      {
        id: 'vendor/bad-cache',
        name: 'Bad Cache',
        pricing: { prompt: '0.000001', completion: '0.000004', input_cache_read: '-1' },
      },
    ],
  })

  it('indexes both the full id and the bare name', () => {
    expect(table.get('anthropic/claude-opus-5')).toBeDefined()
    expect(table.get('claude-opus-5')).toBe(table.get('anthropic/claude-opus-5'))
  })

  it('keeps cache write distinct from cache read', () => {
    const rates = table.get('claude-opus-5')!.periods[0]!.rates
    expect(rates.cacheCreationInputCostPerToken).toBe(6.25e-6)
    expect(rates.cacheReadInputCostPerToken).toBe(5e-7)
  })

  it('defaults a missing cache write to cache read, and a missing read to 10% of input', () => {
    const rates = table.get('gpt-5-mini')!.periods[0]!.rates
    expect(rates.cacheReadInputCostPerToken).toBeCloseTo(2.5e-8, 15)
    expect(rates.cacheCreationInputCostPerToken).toBe(rates.cacheReadInputCostPerToken)
  })

  it('skips entries without usable pricing', () => {
    expect(table.has('no-pricing')).toBe(false)
    expect(table.has('unparseable')).toBe(false)
  })

  it('drops the negative sentinel rather than pricing it', () => {
    // Read literally, -1 is a rate of minus one dollar per token: against a
    // real store, 14 aggregated rows of this id summed to -$9,625,814 and
    // pulled a $645k account total below zero. Dropping the id lets it fall
    // through to the fallback table or stay honestly unpriced; clamping to
    // 0 would resolve it to a free model, which shadows both.
    expect(table.has('openrouter/auto')).toBe(false)
    expect(table.has('auto')).toBe(false)
  })

  it('keeps a genuinely free listing', () => {
    const rates = table.get('really-free:free')!.periods[0]!.rates
    expect(rates.inputCostPerToken).toBe(0)
    expect(rates.outputCostPerToken).toBe(0)
  })

  it('falls back on a negative cache rate without dropping the model', () => {
    const rates = table.get('bad-cache')!.periods[0]!.rates
    expect(rates.inputCostPerToken).toBe(1e-6)
    expect(rates.cacheReadInputCostPerToken).toBeCloseTo(1e-7, 15)
  })
})

describe('parsemodelsdev', () => {
  const payload = {
    // Deliberately listed before the first-party providers to prove the
    // bare-name index is priority-ordered rather than JSON-order-dependent.
    cortecs: { models: { 'deepseek-v4-pro': { name: 'Reseller', cost: { input: 1.73, output: 3.46, cache_read: 0.432 } } } },
    kenari: { models: { 'claude-opus-5': { name: 'Placeholder', cost: { input: 0, output: 0 } } } },
    deepseek: { models: { 'deepseek-v4-pro': { name: 'DeepSeek V4 Pro', cost: { input: 0.435, output: 0.87, cache_read: 0.003_625 } } } },
    anthropic: { models: { 'claude-opus-5': { name: 'Claude Opus 5', cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } } } },
  }
  const table = parseModelsDev(payload)

  it('converts $/mtok to $/token', () => {
    const rates = table.get('anthropic/claude-opus-5')!.periods[0]!.rates
    expect(rates.inputCostPerToken).toBeCloseTo(5e-6, 15)
    expect(rates.outputCostPerToken).toBeCloseTo(25e-6, 15)
    expect(rates.cacheCreationInputCostPerToken).toBeCloseTo(6.25e-6, 15)
  })

  it('gives the bare name to the first-party provider, not a reseller', () => {
    expect(table.get('deepseek-v4-pro')!.periods[0]!.rates.inputCostPerToken).toBeCloseTo(0.435e-6, 15)
    expect(table.get('cortecs/deepseek-v4-pro')!.periods[0]!.rates.inputCostPerToken).toBeCloseTo(1.73e-6, 15)
  })

  it('honours a caller-supplied provider priority', () => {
    const reordered = parseModelsDev(payload, { providerPriority: ['cortecs'] })
    expect(reordered.get('deepseek-v4-pro')!.periods[0]!.rates.inputCostPerToken).toBeCloseTo(1.73e-6, 15)
  })

  it('skips $0 placeholder quotes so they cannot win the bare name', () => {
    expect(table.has('kenari/claude-opus-5')).toBe(false)
    expect(table.get('claude-opus-5')!.displayName).toBe('Claude Opus 5')
  })

  it('marks its provenance', () => {
    expect(table.get('claude-opus-5')!.source).toBe('modelsdev')
  })
})

describe('reseller listings never outrank a first-party one', () => {
  // Shaped after the real api.json: routers file models under a compound
  // id that already carries a vendor prefix, and junk providers stock
  // spellings the vendor itself does not use.
  const json = {
    zai: { models: { 'glm-4.6': { name: 'GLM-4.6', cost: { input: 0.6, output: 2.2 } } } },
    openai: { models: { 'gpt-5.5': { name: 'GPT-5.5', cost: { input: 5, output: 30 } } } },
    llmgateway: {
      models: {
        // Squats on the `vendor/model` key a caller means by `z-ai/glm-4.6`.
        'z-ai/glm-4.6': { name: 'GLM-4.6', cost: { input: 0.55, output: 2.2 } },
        // The only quote anyone publishes for this model.
        'x-ai/grok-9-fast': { name: 'Grok 9 Fast', cost: { input: 0.2, output: 0.5 } },
      },
    },
    frogbot: { models: { 'gpt-5-5': { name: 'GPT-5.5', cost: { input: 2.5, output: 15 } } } },
  }
  const table = parseModelsDev(json)
  const input = (key: string): number | undefined => table.get(key)?.periods[0]?.rates.inputCostPerToken

  it('demotes a router compound id instead of passing it off as first-party', () => {
    // Kept — it is a real quote, and for some models the only one — but
    // tiered below Z.ai's own listing so the lookup prefers the bare name.
    expect(input('z-ai/glm-4.6')).toBeCloseTo(5.5e-7, 15)
    expect(table.get('z-ai/glm-4.6')!.tier).toBe(1)
    expect(table.get('glm-4.6')!.tier).toBe(0)
  })

  it('still serves a model only a router lists', () => {
    expect(input('x-ai/grok-9-fast')).toBeCloseTo(2e-7, 15)
    expect(table.get('x-ai/grok-9-fast')!.tier).toBe(1)
  })

  it('tiers a ranked provider above an unranked one', () => {
    expect(table.get('gpt-5.5')!.tier).toBe(0)
    expect(table.get('gpt-5-5')!.tier).toBe(1)
  })
})

describe('candidate selection prefers a first-party quote', () => {
  it('takes a normalized spelling the vendor lists over an exact one only resellers stock', async () => {
    const { PricingCatalog } = await import('../src/catalog')
    const catalog = new PricingCatalog({
      sources: [{
        name: 'test',
        url: 'https://example.test/models',
        parse: (json: Parameters<typeof parseModelsDev>[0]) => parseModelsDev(json),
      }],
      fetch: (async () => Response.json({
        openai: { models: { 'gpt-5.5': { name: 'GPT-5.5', cost: { input: 5, output: 30 } } } },
        frogbot: { models: { 'gpt-5-5': { name: 'GPT-5.5', cost: { input: 2.5, output: 15 } } } },
      })) as unknown as typeof globalThis.fetch,
    })
    await catalog.ensureLoaded()
    // `gpt-5-5` is candidate #0 and hits; `gpt-5.5` is further down the
    // list. The lower tier has to win anyway.
    expect(catalog.getPrice('gpt-5-5')!.inputCostPerToken).toBeCloseTo(5e-6, 15)
  })

  it('answers a vendor-prefixed name with the vendor price, not the router that squatted the key', async () => {
    const { PricingCatalog } = await import('../src/catalog')
    const catalog = new PricingCatalog({
      sources: [{
        name: 'test',
        url: 'https://example.test/models',
        parse: (json: Parameters<typeof parseModelsDev>[0]) => parseModelsDev(json),
      }],
      fetch: (async () => Response.json({
        zai: { models: { 'glm-4.6': { name: 'GLM-4.6', cost: { input: 0.6, output: 2.2 } } } },
        llmgateway: { models: { 'z-ai/glm-4.6': { name: 'GLM-4.6', cost: { input: 0.55, output: 2.2 } } } },
      })) as unknown as typeof globalThis.fetch,
    })
    await catalog.ensureLoaded()
    expect(catalog.getPrice('z-ai/glm-4.6')!.inputCostPerToken).toBeCloseTo(6e-7, 15)
  })
})

describe('a price names the provider that quoted it', () => {
  // `source` says which feed answered, which is not the same question.
  // models.dev alone carries 186 providers quoting 6,199 models, so a bare
  // name resolves through a priority rule whose outcome is otherwise
  // invisible — and unauditable when someone asks why a number is what it
  // is.
  it('records the models.dev provider key', () => {
    const table = parseModelsDev({
      'anthropic': { models: { 'claude-opus-5': { cost: { input: 5, output: 25 } } } },
      'some-reseller': { models: { 'claude-opus-5': { cost: { input: 20, output: 100 } } } },
    })
    expect(table.get('anthropic/claude-opus-5')!.providerId).toBe('anthropic')
    expect(table.get('some-reseller/claude-opus-5')!.providerId).toBe('some-reseller')
    // The bare name went to the first-party listing, and says so.
    expect(table.get('claude-opus-5')!.providerId).toBe('anthropic')
  })

  it('records the openrouter vendor prefix', () => {
    const table = parseOpenRouterModels({
      data: [{ id: 'anthropic/claude-opus-5', pricing: { prompt: '0.000005', completion: '0.000025' } }],
    })
    expect(table.get('anthropic/claude-opus-5')!.providerId).toBe('anthropic')
    expect(table.get('claude-opus-5')!.providerId).toBe('anthropic')
  })
})
