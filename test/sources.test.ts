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
