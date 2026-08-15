import type { PricingSource } from '../src/sources'
import { describe, expect, it, vi } from 'vitest'
import { PricingCatalog } from '../src/catalog'
import { flatSchedule, mergeLiveQuote, ratesEqual } from '../src/rates'

const SYNCED_AT = Date.UTC(2026, 7, 1)
const BEFORE = Date.UTC(2026, 6, 1)
const AFTER = Date.UTC(2026, 8, 1)

// $5/MTok input, $25/MTok output — the archived rate.
const archived = flatSchedule('Model A', 5e-6, 5e-7, 25e-6, 6.25e-6)
// Upstream has since raised it to $8/MTok.
const live = flatSchedule('Model A', 8e-6, 8e-7, 40e-6, 1e-5, 'modelsdev')

function liveSource(table: Record<string, number>): PricingSource {
  return {
    name: 'modelsdev',
    url: 'https://example.test/models',
    parse: () => new Map(Object.entries(table).map(([id, input]) => [
      id,
      flatSchedule(id, input, input / 10, input * 5, input * 1.25, 'modelsdev'),
    ])),
  }
}

function okFetch(): typeof globalThis.fetch {
  return vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch
}

describe('ratesequal', () => {
  it('sees through unit-conversion rounding', () => {
    expect(ratesEqual(archived.periods[0]!.rates, { ...archived.periods[0]!.rates, inputCostPerToken: 5e-6 + 1e-21 })).toBe(true)
  })

  it('distinguishes a real reprice', () => {
    expect(ratesEqual(archived.periods[0]!.rates, live.periods[0]!.rates)).toBe(false)
  })
})

describe('mergelivequote', () => {
  it('passes a live quote straight through when there is no history', () => {
    expect(mergeLiveQuote(null, live, SYNCED_AT)).toBe(live)
  })

  it('keeps one flat period when the catalogue confirms the archive', () => {
    const merged = mergeLiveQuote(archived, { ...archived, source: 'modelsdev' }, SYNCED_AT)
    expect(merged.periods).toHaveLength(1)
    expect(merged.source).toBe('modelsdev')
  })

  it('grafts a reprice on as a new period instead of replacing the schedule', () => {
    const merged = mergeLiveQuote(archived, live, SYNCED_AT)
    expect(merged.periods).toHaveLength(2)
    expect(merged.periods[0]!.from).toBe(Number.NEGATIVE_INFINITY)
    expect(merged.periods[0]!.rates.inputCostPerToken).toBe(5e-6)
    expect(merged.periods[1]!.from).toBe(SYNCED_AT)
    expect(merged.periods[1]!.rates.inputCostPerToken).toBe(8e-6)
  })

  it('marks the merged schedule for hour-splitting in sql', () => {
    expect(mergeLiveQuote(archived, live, SYNCED_AT, ['%model-a%']).sqlMatch).toEqual(['%model-a%'])
  })

  it('corrects in place rather than stacking when the archive is not older', () => {
    const sameDay = { ...archived, periods: [{ from: SYNCED_AT, rates: archived.periods[0]!.rates }] }
    const merged = mergeLiveQuote(sameDay, live, SYNCED_AT)
    expect(merged.periods).toHaveLength(1)
    expect(merged.periods[0]!.rates.inputCostPerToken).toBe(8e-6)
  })
})

async function loaded(): Promise<PricingCatalog> {
  const catalog = new PricingCatalog({
    sources: [liveSource({ 'model-a': 8e-6 })],
    fallback: { 'model-a': archived },
    archiveObservedAt: SYNCED_AT,
    fetch: okFetch(),
  })
  await catalog.ensureLoaded()
  return catalog
}

describe('a live reprice does not re-price history', () => {
  it('charges the old rate before the observation and the new one after', async () => {
    const catalog = await loaded()
    expect(catalog.getPrice('model-a', BEFORE)?.inputCostPerToken).toBe(5e-6)
    expect(catalog.getPrice('model-a', AFTER)?.inputCostPerToken).toBe(8e-6)
  })

  it('prices a timestamped row exactly', async () => {
    const catalog = await loaded()
    const old = catalog.estimate({ model: 'model-a', inputTokens: 1e6, cachedInputTokens: 0, outputTokens: 0, at: BEFORE })
    expect(old.basis).toBe('exact')
    expect(old.cost).toBeCloseTo(5, 10)
  })

  it('blends a window that straddles the change', async () => {
    const catalog = await loaded()
    const { cost, basis } = catalog.estimate({
      model: 'model-a',
      inputTokens: 1e6,
      cachedInputTokens: 0,
      outputTokens: 0,
      window: [BEFORE, AFTER],
    })
    expect(basis).toBe('blended')
    // 31 days at $5 then 31 days at $8 — the exact midpoint of the window.
    expect(cost).toBeGreaterThan(5)
    expect(cost).toBeLessThan(8)
    expect(cost).toBeCloseTo(6.5, 1)
  })

  it('tells the query layer to split those rows by hour', async () => {
    const catalog = await loaded()
    expect(catalog.timeSensitiveSqlPatterns).toContain('%model-a%')
  })

  it('leaves a confirmed price flat, and out of the sql patterns', async () => {
    const catalog = new PricingCatalog({
      sources: [liveSource({ 'model-a': 5e-6 })],
      fallback: { 'model-a': archived },
      archiveObservedAt: SYNCED_AT,
      fetch: okFetch(),
    })
    await catalog.ensureLoaded()
    expect(catalog.getPrice('model-a', BEFORE)?.inputCostPerToken).toBe(5e-6)
    expect(catalog.estimate({ model: 'model-a', inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 }).basis).toBe('flat')
    expect(catalog.timeSensitiveSqlPatterns).not.toContain('%model-a%')
  })
})
