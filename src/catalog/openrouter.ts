import type { PriceSchedule } from '../types'

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'

export interface OpenRouterModelsResponse {
  data?: Array<Record<string, unknown>>
}

/**
 * Turn an OpenRouter `/models` payload into a lookup keyed by both the full
 * `vendor/model` id and the bare model name.
 *
 * The bare-name index is what lets any vendor resolve without a
 * hand-written prefix rule: callers store model ids without OpenRouter's
 * mandatory `vendor/` prefix. Bare names cannot collide with full ids —
 * those always contain a slash — and first-wins keeps a future duplicate
 * bare name from silently flipping an already-resolved price.
 */
/**
 * A quoted rate, or null when the field is absent, unparseable, or
 * negative.
 *
 * `parseFloat(x) || fallback` cannot tell "free" from "missing", and a
 * quoted $0 cache read is real — implicit caching is free on some vendors,
 * and 19 of OpenRouter's 413 listings quote 0/0 in earnest (16 carry the
 * `:free` suffix; the rest are `openrouter/free` and the Lyria models,
 * which bill per second rather than per token). Reading those as missing
 * bills their reads at 10% of input.
 *
 * A negative quote is neither free nor missing. OpenRouter uses `-1` as a
 * sentinel on the meta-models whose endpoint — and therefore price — the
 * router only picks at request time: `openrouter/auto`, `auto-beta`,
 * `fusion`, `pareto-code`, `bodybuilder`. Taken literally that is a rate
 * of minus one dollar per token, which does not merely mis-price its own
 * model — summed into a total it credits back everything else. Measured
 * against a real store, 14 aggregated rows of `openrouter/auto` came to
 * -$9,625,814 and turned a $645k account total negative.
 *
 * `parseModelsDev` has rejected negative quotes since it was written (see
 * `isUsableCost`); this adapter simply missed the same rule. It stops
 * short of that one's 0/0 rejection on purpose — models.dev has real
 * placeholder rows quoting 0/0 to advertise availability, and OpenRouter,
 * as counted above, does not.
 */
function num(value: unknown): number | null {
  const parsed = Number.parseFloat(String(value ?? ''))
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

export function parseOpenRouterModels(json: OpenRouterModelsResponse): Map<string, PriceSchedule> {
  const map = new Map<string, PriceSchedule>()
  for (const model of json.data ?? []) {
    const id = model.id
    if (!id || typeof id !== 'string') {
      continue
    }
    const pricing = model.pricing as Record<string, unknown> | undefined
    if (!pricing || typeof pricing !== 'object') {
      continue
    }
    // A listing whose own input/output rate is missing or negative has no
    // usable quote at all. Drop the entry rather than clamping the rate to
    // 0: an id that resolves to a free model is the same bug wearing a
    // plausible number, and a resolved id shadows both the fallback table
    // and every later source in the chain. Dropped ids fall through to
    // those instead, or stay honestly unpriced and visible as such.
    const input = num(pricing.prompt)
    const output = num(pricing.completion)
    if (input === null || output === null) {
      continue
    }
    // Read both cache-read and cache-write. They are distinct on Claude
    // (cache_write ~ 1.25x input, cache_read ~ 0.1x input) — reusing the
    // cache_read rate for creation would under-charge cache creation by
    // ~12.5x. Fall back to cache_read when write is absent (most
    // OpenAI/DeepSeek entries have no input_cache_write).
    const cacheRead = num(pricing.input_cache_read) ?? input * 0.1
    const cacheWrite = num(pricing.input_cache_write) ?? cacheRead
    // OpenRouter is a point-in-time quote: one rate, valid now. It is
    // therefore always a single open-ended period.
    const key = id.toLowerCase()
    const slash = key.indexOf('/')
    const schedule: PriceSchedule = {
      displayName: typeof model.name === 'string' ? model.name : undefined,
      source: 'openrouter',
      // OpenRouter's ids are always `vendor/model`, so the prefix names the
      // vendor whose endpoint it would route to.
      providerId: slash > 0 ? key.slice(0, slash) : undefined,
      periods: [{
        from: Number.NEGATIVE_INFINITY,
        rates: {
          inputCostPerToken: input,
          cacheCreationInputCostPerToken: cacheWrite,
          cacheReadInputCostPerToken: cacheRead,
          cachedInputCostPerToken: cacheRead,
          outputCostPerToken: output,
        },
      }],
    }
    map.set(key, schedule)
    const bare = key.slice(slash + 1)
    if (bare !== key && !map.has(bare)) {
      map.set(bare, schedule)
    }
  }
  return map
}
