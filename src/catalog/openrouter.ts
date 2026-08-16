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
 * A quoted rate, or null when the field is absent/unparseable.
 *
 * `parseFloat(x) || fallback` cannot tell "free" from "missing", and a
 * quoted $0 cache read is real — implicit caching is free on some vendors.
 * Reading it as missing bills those reads at 10% of input.
 */
function num(value: unknown): number | null {
  const parsed = Number.parseFloat(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : null
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
    const input = Number.parseFloat(String(pricing.prompt ?? ''))
    const output = Number.parseFloat(String(pricing.completion ?? ''))
    if (!Number.isFinite(input) || !Number.isFinite(output)) {
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
    const schedule: PriceSchedule = {
      displayName: typeof model.name === 'string' ? model.name : undefined,
      source: 'openrouter',
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
    const key = id.toLowerCase()
    map.set(key, schedule)
    const bare = key.slice(key.indexOf('/') + 1)
    if (bare !== key && !map.has(bare)) {
      map.set(bare, schedule)
    }
  }
  return map
}
