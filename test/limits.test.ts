import type { PricingSource } from '../src'
import { describe, expect, it, vi } from 'vitest'
import { PricingCatalog } from '../src'
import { parseModelsDev } from '../src/catalog/modelsdev'
import { parseOpenRouterModels } from '../src/catalog/openrouter'
import { scaleSchedule } from '../src/rates'

describe('model limits', () => {
  it('reads a models.dev listing\'s window and output cap', () => {
    const table = parseModelsDev({
      openai: {
        models: {
          'gpt-6-luna': {
            name: 'GPT-6 Luna',
            cost: { input: 0.1, output: 0.5 },
            limit: { context: 400_000, output: 128_000 },
          },
        },
      },
    })
    expect(table.get('gpt-6-luna')).toMatchObject({ contextWindowTokens: 400_000, maxOutputTokens: 128_000 })
  })

  it('reads openrouter\'s window and its first endpoint\'s completion cap', () => {
    const table = parseOpenRouterModels({
      data: [{
        id: 'openai/gpt-6-luna',
        context_length: 400_000,
        top_provider: { context_length: 400_000, max_completion_tokens: 128_000 },
        pricing: { prompt: '0.0000001', completion: '0.0000005' },
      }],
    })
    expect(table.get('gpt-6-luna')).toMatchObject({ contextWindowTokens: 400_000, maxOutputTokens: 128_000 })
  })

  it('leaves a limit that could not be one unstated', () => {
    const table = parseOpenRouterModels({
      data: [{
        id: 'openrouter/auto',
        context_length: 0,
        top_provider: { max_completion_tokens: null },
        pricing: { prompt: '0.000001', completion: '0.000002' },
      }],
    })
    const schedule = table.get('openrouter/auto')!
    expect(schedule.contextWindowTokens).toBeUndefined()
    expect(schedule.maxOutputTokens).toBeUndefined()
  })

  it('carries them onto the price a lookup returns', async () => {
    const catalog = new PricingCatalog({
      sources: [modelsDevStub({ 'gpt-6-luna': { context: 400_000, output: 128_000 } })],
      fetch: okFetch(),
    })
    await catalog.ensureLoaded()
    const price = catalog.getPrice('gpt-6-luna')
    expect(price?.inputCostPerToken).toBeCloseTo(1e-7, 15)
    expect(price).toMatchObject({ contextWindowTokens: 400_000, maxOutputTokens: 128_000 })
  })

  it('keeps the live limits when the quote merges into an archived model', async () => {
    // claude-opus-5 is in the bundled snapshot, which records no limits.
    const catalog = new PricingCatalog({
      sources: [modelsDevStub({ 'claude-opus-5': { context: 1_000_000, output: 64_000 } })],
      fetch: okFetch(),
    })
    await catalog.ensureLoaded()
    expect(catalog.getPrice('claude-opus-5')).toMatchObject({ contextWindowTokens: 1_000_000, maxOutputTokens: 64_000 })
  })

  it('leaves a card from the built-in tables without limits', () => {
    const price = new PricingCatalog({ sources: [] }).getPrice('claude-opus-5')
    expect(price?.contextWindowTokens).toBeUndefined()
    expect(price?.maxOutputTokens).toBeUndefined()
  })

  it('gives a fast variant its base model\'s limits', () => {
    const base = parseModelsDev({
      anthropic: { models: { 'claude-opus-5': { cost: { input: 5, output: 25 }, limit: { context: 1_000_000, output: 64_000 } } } },
    }).get('claude-opus-5')!
    expect(scaleSchedule(base, 2, 'Fast')).toMatchObject({ contextWindowTokens: 1_000_000, maxOutputTokens: 64_000 })
  })
})

function modelsDevStub(limits: Record<string, { context: number, output: number }>): PricingSource {
  const models = Object.fromEntries(Object.entries(limits).map(([id, limit]) => [
    id,
    { name: id, cost: { input: 0.1, output: 0.5 }, limit },
  ]))
  return {
    name: 'modelsdev',
    url: 'https://example.test/modelsdev',
    parse: () => parseModelsDev({ openai: { models } }),
  }
}

function okFetch(): typeof globalThis.fetch {
  return vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch
}
