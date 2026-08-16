import type { SnapshotModels, SnapshotPeriod } from '../src/catalog/sync'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PROVIDER_PRIORITY } from '../src/catalog/modelsdev'
import { mergeSnapshot } from '../src/catalog/sync'

// The archive generator carries this package's strongest claim — history is
// never re-priced — and had no tests at all.

function api(input: number, output: number, extra: Record<string, number> = {}) {
  return {
    anthropic: { models: { 'claude-x': { name: 'Claude X', cost: { input, output, ...extra } } } },
  }
}

// The archive stores `input * 0.1` for an absent cache rate, and that
// arithmetic drifts: 6 * 0.1 is 0.6000000000000001, not 0.6. Build the
// expectation the same way rather than writing the tidy decimal.
function period(from: string | null, input: number, output: number): SnapshotPeriod {
  return [from, input, input * 0.1, input * 0.1, output]
}

describe('the archive only ever grows', () => {
  it('opens a newly seen model at -infinity, not at today', () => {
    // Dating it today would leave every row before this sync unpriced.
    const { models, added } = mergeSnapshot({}, api(5, 25), ['anthropic'], '2026-08-16')
    expect(added).toBe(1)
    expect(models['claude-x']![1]).toEqual([period(null, 5, 25)])
  })

  it('appends a period instead of overwriting when a price changes', () => {
    const previous: SnapshotModels = { 'claude-x': ['Claude X', [[null, 5, 0.5, 0.5, 25]]] }
    const { models, repriced } = mergeSnapshot(previous, api(6, 30), ['anthropic'], '2026-08-16')
    expect(repriced).toBe(1)
    expect(models['claude-x']![1]).toEqual([
      period(null, 5, 25),
      period('2026-08-16', 6, 30),
    ])
  })

  it('corrects in place when the last period was recorded in the same sync', () => {
    const previous: SnapshotModels = {
      'claude-x': ['Claude X', [[null, 5, 0.5, 0.5, 25], ['2026-08-16', 6, 0.6, 0.6, 30]]],
    }
    const { models } = mergeSnapshot(previous, api(7, 35), ['anthropic'], '2026-08-16')
    // Two periods on one date would describe a price that was never in
    // force for any interval.
    expect(models['claude-x']![1]).toEqual([
      period(null, 5, 25),
      period('2026-08-16', 7, 35),
    ])
  })

  it('keeps a model upstream has dropped', () => {
    const previous: SnapshotModels = { 'retired-model': ['Retired', [[null, 1, 0.1, 0.1, 2]]] }
    const { models, retained } = mergeSnapshot(previous, api(5, 25), ['anthropic'], '2026-08-16')
    // Stored model strings are immortal; deleting the row makes its
    // historical rows silently cost $0.
    expect(retained).toEqual(['retired-model'])
    expect(models['retired-model']).toEqual(['Retired', [[null, 1, 0.1, 0.1, 2]]])
  })

  it('refreshes a display name without recording a reprice', () => {
    const previous: SnapshotModels = { 'claude-x': ['Old Name', [[null, 5, 0.5, 0.5, 25]]] }
    const { models, repriced } = mergeSnapshot(previous, api(5, 25), ['anthropic'], '2026-08-16')
    expect(repriced).toBe(0)
    expect(models['claude-x']![0]).toBe('Claude X')
    expect(models['claude-x']![1]).toHaveLength(1)
  })
})

describe('what must never enter the archive', () => {
  it('ignores a placeholder 0/0 listing', () => {
    const { models } = mergeSnapshot({}, api(0, 0), ['anthropic'], '2026-08-16')
    expect(models['claude-x']).toBeUndefined()
  })

  it('ignores a negative rate', () => {
    const { models } = mergeSnapshot({}, api(5, -1), ['anthropic'], '2026-08-16')
    expect(models['claude-x']).toBeUndefined()
  })

  it('does not record a reprice for float drift in the last bits', () => {
    // `input * 0.1` is where a rate drifts; the snapshot already holds
    // figures like 0.010000000000000002. An exact comparison writes a
    // price change that never happened — permanently, since the file is
    // append-only.
    const previous: SnapshotModels = { 'claude-x': ['Claude X', [[null, 0.1, 0.010_000_000_000_000_002, 0.010_000_000_000_000_002, 0.4]]] }
    const { models, repriced } = mergeSnapshot(previous, api(0.1, 0.4), ['anthropic'], '2026-08-16')
    expect(repriced).toBe(0)
    expect(models['claude-x']![1]).toHaveLength(1)
  })

  it('lets the first provider in priority order win a bare name', () => {
    const twoProviders = {
      anthropic: { models: { 'shared-id': { name: 'First party', cost: { input: 5, output: 25 } } } },
      azure: { models: { 'shared-id': { name: 'Reseller', cost: { input: 9, output: 45 } } } },
    }
    const { models } = mergeSnapshot({}, twoProviders, ['anthropic', 'azure'], '2026-08-16')
    expect(models['shared-id']![1][0]![1]).toBe(5)
  })
})

describe('the list the script actually archives with', () => {
  it('gives the bare name to the highest-priority provider listing it', () => {
    // The archive and the live index must quote on the same basis, so the
    // script feeds `mergeSnapshot` the very list `parseModelsDev` ranks by.
    // With no second copy left to drift, what is worth asserting is that the
    // ordering does its job across the whole list: every provider quotes the
    // same id, and the winner must be the one at the head of the priority
    // list rather than the cheapest or the first key in the payload.
    const listings: Record<string, { models: Record<string, { name: string, cost: { input: number, output: number } }> }> = {}
    // Priced so the head of the list is the *most expensive* quote: what
    // wins must be the priority order, not the number.
    for (const [i, provider] of DEFAULT_PROVIDER_PRIORITY.entries()) {
      listings[provider] = { models: { shared: { name: provider, cost: { input: DEFAULT_PROVIDER_PRIORITY.length - i, output: 1 } } } }
    }
    const { models } = mergeSnapshot({}, listings, DEFAULT_PROVIDER_PRIORITY, '2026-08-16')
    expect(models.shared![0]).toBe(DEFAULT_PROVIDER_PRIORITY[0])
  })
})
