import { describe, expect, it } from 'vitest'
import { PricingCatalog } from '../src/catalog'
import { FALLBACK, FAST_MULTIPLIERS, SNAPSHOT_SYNCED_AT } from '../src/catalog/fallback'
import { OVERRIDES } from '../src/catalog/overrides'

describe('bundled snapshot', () => {
  it('records when it was generated', () => {
    expect(SNAPSHOT_SYNCED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('covers the major vendors', () => {
    for (const id of ['claude-opus-5', 'claude-sonnet-5', 'gpt-5.5', 'deepseek-chat']) {
      expect(FALLBACK[id], id).toBeDefined()
    }
  })

  it('never prices a model at zero', () => {
    for (const [id, schedule] of Object.entries(FALLBACK)) {
      for (const period of schedule.periods) {
        expect(period.rates.inputCostPerToken + period.rates.outputCostPerToken, id).toBeGreaterThan(0)
      }
    }
  })

  it('quotes per-token rates, not per-million', () => {
    // The cheapest real model is ~$0.02/MTok and the priciest ~$100/MTok;
    // anything outside that band means a unit conversion was skipped.
    for (const [id, schedule] of Object.entries(FALLBACK)) {
      const { inputCostPerToken } = schedule.periods[0]!.rates
      expect(inputCostPerToken, id).toBeLessThan(1e-3)
      expect(inputCostPerToken, id).toBeGreaterThan(1e-12)
    }
  })

  it('keeps every rate finite and non-negative', () => {
    for (const [id, schedule] of Object.entries({ ...FALLBACK, ...OVERRIDES })) {
      for (const period of schedule.periods) {
        for (const rates of [period.rates, period.peak?.rates]) {
          for (const value of Object.values(rates ?? {})) {
            expect(Number.isFinite(value) && value >= 0, `${id}: ${value}`).toBe(true)
          }
        }
      }
    }
  })

  it('can derive a fast variant for every base model it declares', () => {
    const catalog = new PricingCatalog({ sources: [] })
    for (const [multiplier, baseIds] of FAST_MULTIPLIERS) {
      for (const id of baseIds) {
        const base = FALLBACK[id]
        expect(base, id).toBeDefined()
        expect(catalog.getPrice(`${id}-fast`)?.inputCostPerToken)
          .toBeCloseTo(base!.periods[0]!.rates.inputCostPerToken * multiplier, 15)
      }
    }
  })

  it('keeps fast tiers out of the table so no reseller listing can win them', () => {
    for (const [, baseIds] of FAST_MULTIPLIERS) {
      for (const id of baseIds) {
        expect(FALLBACK[`${id}-fast`], `${id}-fast`).toBeUndefined()
      }
    }
  })

  it('orders every override schedule by effective date', () => {
    for (const [id, schedule] of Object.entries(OVERRIDES)) {
      expect(schedule.periods[0]!.from, id).toBe(Number.NEGATIVE_INFINITY)
      for (let i = 1; i < schedule.periods.length; i++) {
        expect(schedule.periods[i]!.from, id).toBeGreaterThan(schedule.periods[i - 1]!.from)
      }
    }
  })

  it('declares sqlmatch on every time-sensitive override', () => {
    for (const [id, schedule] of Object.entries(OVERRIDES)) {
      const timeSensitive = schedule.periods.length > 1 || schedule.periods.some(p => p.peak)
      if (timeSensitive) {
        expect(schedule.sqlMatch?.length, id).toBeGreaterThan(0)
      }
    }
  })

  it('keeps peak windows within a day and half-open', () => {
    for (const [id, schedule] of Object.entries(OVERRIDES)) {
      for (const period of schedule.periods) {
        for (const [start, end] of period.peak?.windowsUtc ?? []) {
          expect(start, id).toBeGreaterThanOrEqual(0)
          expect(end, id).toBeLessThanOrEqual(24)
          expect(end, id).toBeGreaterThan(start)
        }
      }
    }
  })
})
