import { describe, expect, it } from 'vitest'
import { PricingCatalog } from '../src/catalog'
import { sumEstimates } from '../src/total'

// What a caller loses by folding estimates with `+=`, and what
// `sumEstimates` keeps instead. Every number here is hand-computable from
// the DeepSeek override asserted in the first test.

const catalog = new PricingCatalog({ sources: [] })
const MTOK = { inputTokens: 1e6, cachedInputTokens: 0, outputTokens: 0 }
const PEAK = Date.UTC(2026, 8, 1, 2)
const OFF = Date.UTC(2026, 8, 1, 12)
const DAY = [Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 2)] as const

describe('cost bounds', () => {
  it('quotes the same number for low, cost and high when one card priced it', () => {
    // Nearly every model. The bounds must not imply an uncertainty that is
    // not there, or every flat total starts displaying a spurious range.
    const flat = catalog.estimate({ model: 'claude-opus-5', ...MTOK })
    expect(flat.basis).toBe('flat')
    expect(flat.low).toBe(flat.cost)
    expect(flat.high).toBe(flat.cost)

    const exact = catalog.estimate({ model: 'deepseek-v4-flash', ...MTOK, at: PEAK })
    expect(exact.basis).toBe('exact')
    expect(exact.cost).toBeCloseTo(0.44, 10)
    expect(exact.low).toBe(exact.cost)
    expect(exact.high).toBe(exact.cost)
  })

  it('brackets a blend by the cheapest and dearest hour it averaged', () => {
    const blended = catalog.estimate({ model: 'deepseek-v4-flash', ...MTOK, window: DAY })
    expect(blended.basis).toBe('blended')
    // 7 peak hours and 17 off-peak, weighted by wall-clock duration.
    expect(blended.cost).toBeCloseTo((7 * 0.44 + 17 * 0.22) / 24, 10)
    // The ends are real prices this row could have paid, not an error bar:
    // off-peak and peak, a factor of two apart.
    expect(blended.low).toBeCloseTo(0.22, 10)
    expect(blended.high).toBeCloseTo(0.44, 10)
    expect(blended.cost).toBeGreaterThan(blended.low)
    expect(blended.cost).toBeLessThan(blended.high)
  })

  it('does not widen the interval with periods the window never entered', () => {
    // A window wholly inside the off-peak hours blends only off-peak rates,
    // so there is nothing to bracket. Counting every card in the schedule
    // instead of the ones with weight would report a 2x range for a row
    // that could not have paid the peak rate.
    const noon = catalog.estimate({
      model: 'deepseek-v4-flash',
      ...MTOK,
      window: [Date.UTC(2026, 8, 1, 11), Date.UTC(2026, 8, 1, 13)],
    })
    expect(noon.low).toBeCloseTo(noon.high, 12)
    expect(noon.cost).toBeCloseTo(0.22, 10)
  })
})

/** Stands in for a lazily-read cursor: never materialised as an array. */
function* stream(): Generator<ReturnType<typeof catalog.estimate>> {
  for (let i = 0; i < 3; i++) {
    yield catalog.estimate({ model: 'claude-opus-5', ...MTOK })
  }
}

describe('sumestimates', () => {
  it('keeps every card that priced the total, not just the last one seen', () => {
    // The failure this exists to prevent: one model, two rate cards, and an
    // accumulator that reports whichever row happened to come last.
    const total = sumEstimates([
      catalog.estimate({ model: 'deepseek-v4-flash', ...MTOK, at: PEAK }),
      catalog.estimate({ model: 'deepseek-v4-flash', ...MTOK, at: OFF }),
    ])
    expect(total.cost).toBeCloseTo(0.66, 10)
    expect(total.cards).toHaveLength(2)
    // Most expensive first, each with what it actually contributed.
    expect(total.cards[0]!.cost).toBeCloseTo(0.44, 10)
    expect(total.cards[1]!.cost).toBeCloseTo(0.22, 10)
    expect(total.cards.map(c => c.count)).toEqual([1, 1])
  })

  it('collapses rows that shared a card into one entry', () => {
    const total = sumEstimates([
      catalog.estimate({ model: 'deepseek-v4-flash', ...MTOK, at: PEAK }),
      catalog.estimate({ model: 'deepseek-v4-flash', ...MTOK, at: PEAK }),
    ])
    expect(total.cards).toHaveLength(1)
    expect(total.cards[0]!.count).toBe(2)
    expect(total.cards[0]!.cost).toBeCloseTo(0.88, 10)
  })

  it('sums the interval, so a mixed total says how sharp it is', () => {
    const total = sumEstimates([
      catalog.estimate({ model: 'claude-opus-5', ...MTOK }), // $5, exact
      catalog.estimate({ model: 'deepseek-v4-flash', ...MTOK, window: DAY }),
    ])
    // The flat row contributes no width at all, so the interval is the
    // DeepSeek row's alone — which is the point: it localises the doubt.
    expect(total.low).toBeCloseTo(5 + 0.22, 10)
    expect(total.high).toBeCloseTo(5 + 0.44, 10)
    expect(total.cost).toBeGreaterThan(total.low)
    expect(total.cost).toBeLessThan(total.high)
  })

  it('splits cost by basis, so the blended share is visible', () => {
    const total = sumEstimates([
      catalog.estimate({ model: 'claude-opus-5', ...MTOK }),
      catalog.estimate({ model: 'deepseek-v4-flash', ...MTOK, at: PEAK }),
      catalog.estimate({ model: 'deepseek-v4-flash', ...MTOK, window: DAY }),
    ])
    expect(total.byBasis.flat).toBeCloseTo(5, 10)
    expect(total.byBasis.exact).toBeCloseTo(0.44, 10)
    expect(total.byBasis.blended).toBeCloseTo((7 * 0.44 + 17 * 0.22) / 24, 10)
    // The three shares are the whole cost — nothing is uncategorised.
    const { flat, exact, blended } = total.byBasis
    expect(flat + exact + blended).toBeCloseTo(total.cost, 10)
  })

  it('reports the usage an unpriced model contributed as zero', () => {
    const total = sumEstimates([
      catalog.estimate({ model: 'claude-opus-5', ...MTOK }),
      catalog.estimate({ model: 'nobody-lists-this', inputTokens: 3e6, cachedInputTokens: 0, outputTokens: 1e6 }),
    ])
    expect(total.cost).toBeCloseTo(5, 10)
    // Without this the total is just $5 and reads as complete. 4M tokens of
    // real spend are missing from it.
    expect(total.unpriced).toEqual({ count: 1, tokens: 4e6 })
    // Priced tokens exclude them, so the two never double-count.
    expect(total.tokens).toBe(1e6)
    expect(total.count).toBe(2)
    // An unpriced row has no card, so it cannot pollute the card list.
    expect(total.cards).toHaveLength(1)
  })

  it('folds an empty input into a zero total rather than throwing', () => {
    const total = sumEstimates([])
    expect(total).toEqual({
      cost: 0,
      low: 0,
      high: 0,
      count: 0,
      unpriced: { count: 0, tokens: 0 },
      tokens: 0,
      byBasis: { flat: 0, exact: 0, blended: 0 },
      cards: [],
    })
  })

  it('does not share state between calls', () => {
    // `byBasis`, `unpriced` and `cards` are mutable containers on the
    // result; a module-level template reused across calls would make each
    // total include every earlier one.
    const first = sumEstimates([catalog.estimate({ model: 'claude-opus-5', ...MTOK })])
    const second = sumEstimates([])
    expect(first.cost).toBeCloseTo(5, 10)
    expect(second.cost).toBe(0)
    expect(second.byBasis.flat).toBe(0)
    expect(second.cards).toHaveLength(0)
  })

  it('reports one card for many identical blended rows', () => {
    // A blend computes its rate card fresh every call, so each blended row
    // used to mint its own `ModelPrice` — and cards are identified by
    // object identity, so 1,000 identical rows reported 1,000 distinct
    // "rates". The card list is serialised into API responses; unbounded
    // growth there is the visible half of the bug.
    const many = Array.from({ length: 1000 }, () =>
      catalog.estimate({ model: 'deepseek-v4-flash', ...MTOK, window: DAY }))
    const total = sumEstimates(many)
    expect(total.cards).toHaveLength(1)
    expect(total.cards[0]!.count).toBe(1000)
    expect(total.cards[0]!.cost).toBeCloseTo(total.cost, 8)
  })

  it('groups by price, not by which object produced it', () => {
    // `sumEstimates` takes any iterable, so it cannot require that its
    // input came from one catalogue. Grouping on object identity would make
    // the answer depend on a private memo inside `PricingCatalog`: a second
    // instance, an evicted cache slot, or a trip through JSON would each
    // split one price into many entries — the exact failure this function
    // exists to prevent.
    const other = new PricingCatalog({ sources: [] })
    const mine = catalog.estimate({ model: 'claude-opus-5', ...MTOK })
    const total = sumEstimates([
      mine,
      other.estimate({ model: 'claude-opus-5', ...MTOK }),
      JSON.parse(JSON.stringify(mine)) as typeof mine,
    ])
    expect(total.cards).toHaveLength(1)
    expect(total.cards[0]!.count).toBe(3)
  })

  it('keeps genuinely different prices apart', () => {
    const total = sumEstimates([
      catalog.estimate({ model: 'claude-opus-5', ...MTOK }),
      catalog.estimate({ model: 'gpt-5.5', ...MTOK }),
    ])
    expect(total.cards).toHaveLength(2)
  })

  it('treats a window written backwards as the same window', () => {
    // `ratesFor` normalises a reversed window because an interval is not an
    // ordered pair. Anything downstream that keys on the window has to
    // agree, or one interval yields two "prices" that are the same number.
    const total = sumEstimates([
      catalog.estimate({ model: 'deepseek-v4-flash', ...MTOK, window: DAY }),
      catalog.estimate({ model: 'deepseek-v4-flash', ...MTOK, window: [DAY[1], DAY[0]] }),
    ])
    expect(total.cards).toHaveLength(1)
  })

  it('prices an open-ended window against the clock, not a stored answer', () => {
    // A window with an unparseable or missing bound sends `ratesFor` to the
    // rate in force *now* — a moving answer, so it must never be served
    // from the blend slot.
    const open = catalog.estimate({ model: 'deepseek-v4-flash', ...MTOK, window: [DAY[0], null] })
    expect(open.basis).toBe('blended')
    expect(Number.isFinite(open.cost)).toBe(true)
  })

  it('still separates blends that really are different prices', () => {
    // The memo is keyed by window, so two different windows must not
    // collapse into one card just because they share a schedule.
    const total = sumEstimates([
      catalog.estimate({ model: 'deepseek-v4-flash', ...MTOK, window: DAY }),
      catalog.estimate({ model: 'deepseek-v4-flash', ...MTOK, window: [Date.UTC(2026, 8, 1, 1), Date.UTC(2026, 8, 1, 4)] }),
    ])
    expect(total.cards).toHaveLength(2)
  })

  it('accepts any iterable, so a cursor never has to be materialised', () => {
    expect(sumEstimates(stream()).cost).toBeCloseTo(15, 10)
  })
})

describe('price provenance', () => {
  it('names the provider that quoted a live price, not just the feed', () => {
    const live = new PricingCatalog({
      sources: [{
        name: 'modelsdev',
        url: 'https://example.test/api.json',
        parse: () => new Map(),
      }],
    })
    // Parser-level provenance is covered in sources.test.ts; here the point
    // is that the card carries it through to the caller.
    const card = live.getPrice('claude-opus-5')
    expect(card?.source).toBe('fallback')
    // The built-in tables quote first-party rates and name no provider.
    expect(card?.providerId).toBeUndefined()
  })
})
