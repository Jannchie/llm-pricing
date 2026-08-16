import type { PriceSchedule } from '../types'

export const MODELS_DEV_URL = 'https://models.dev/api.json'

// models.dev lists ~185 providers, most of them resellers and routers that
// re-quote the same model id at their own margin (or at a placeholder $0).
// A bare model name therefore collides 15-25 ways, so "first wins" is only
// safe once providers are ordered — this is exactly the reseller-rate trap
// that made DeepSeek's first-party prices worth overriding in the first
// place.
//
// Providers listed here win the bare-name index, in this order. Everything
// else is appended in alphabetical order so the result is deterministic
// regardless of JSON key order.
export const DEFAULT_PROVIDER_PRIORITY: readonly string[] = [
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'xai',
  'meta',
  'mistral',
  'cohere',
  'alibaba',
  'zai',
  'moonshotai',
  'llama',
  'google-vertex',
  'amazon-bedrock',
  'azure',
]

interface ModelsDevCost {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  reasoning?: number
}

interface ModelsDevModel {
  id?: string
  name?: string
  cost?: ModelsDevCost
}

export type ModelsDevResponse = Record<string, {
  id?: string
  name?: string
  models?: Record<string, ModelsDevModel>
}>

export interface ParseModelsDevOptions {
  /** Provider ids that win the bare-name index, best first. */
  providerPriority?: readonly string[]
}

function isUsableCost(cost: ModelsDevCost | undefined): cost is ModelsDevCost {
  if (!cost) {
    return false
  }
  const { input, output } = cost
  if (typeof input !== 'number' || typeof output !== 'number') {
    return false
  }
  if (!Number.isFinite(input) || !Number.isFinite(output)) {
    return false
  }
  // A negative rate is never a real quote, and it does not merely mis-price
  // its own model: summed into a total it credits back other models' cost.
  if (input < 0 || output < 0) {
    return false
  }
  // Placeholder rows: several aggregators list a model at 0/0 to advertise
  // availability. Pricing a real workload against those silently reports
  // $0 spend, which is worse than reporting nothing.
  return input > 0 || output > 0
}

/**
 * Turn a models.dev `api.json` payload into a lookup keyed by both
 * `provider/model` and the bare model id.
 *
 * models.dev quotes USD per **million** tokens; this converts to per-token
 * so every source in this package speaks the same unit.
 *
 * Long-context tiers (`tiers` / `context_over_200k`) are deliberately
 * ignored: selecting between them needs the context length of each
 * individual request, which aggregated usage rows no longer carry.
 */
export function parseModelsDev(json: ModelsDevResponse, options: ParseModelsDevOptions = {}): Map<string, PriceSchedule> {
  const priority = options.providerPriority ?? DEFAULT_PROVIDER_PRIORITY
  const rank = new Map(priority.map((id, i) => [id, i]))
  const providers = Object.keys(json).sort((a, b) => {
    const ra = rank.get(a) ?? Number.POSITIVE_INFINITY
    const rb = rank.get(b) ?? Number.POSITIVE_INFINITY
    return ra === rb ? a.localeCompare(b) : ra - rb
  })

  const map = new Map<string, PriceSchedule>()
  // Held aside until every provider has been read, so a real listing always
  // gets to claim the key first. Insertion order is already best-provider
  // first, so the first compound quote for a key is the best one.
  const compound = new Map<string, PriceSchedule>()
  for (const providerId of providers) {
    const models = json[providerId]?.models
    if (!models) {
      continue
    }
    for (const [modelId, model] of Object.entries(models)) {
      const cost = model?.cost
      if (!isUsableCost(cost)) {
        continue
      }
      const input = cost.input! / 1e6
      const output = cost.output! / 1e6
      // Same defaulting rule as the OpenRouter adapter: absent cache_write
      // falls back to cache_read, absent cache_read to 10% of input.
      const cacheRead = typeof cost.cache_read === 'number' && Number.isFinite(cost.cache_read)
        ? cost.cache_read / 1e6
        : input * 0.1
      const cacheWrite = typeof cost.cache_write === 'number' && Number.isFinite(cost.cache_write)
        ? cost.cache_write / 1e6
        : cacheRead
      const schedule: PriceSchedule = {
        displayName: typeof model.name === 'string' ? model.name : undefined,
        source: 'modelsdev',
        tier: rank.has(providerId) ? 0 : 1,
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
      const bare = modelId.toLowerCase()
      map.set(`${providerId.toLowerCase()}/${bare}`, schedule)
      // Routers file models under a compound id that already carries a
      // vendor prefix — `llmgateway` sells one called `z-ai/glm-4.6`. That
      // lands in the same flat namespace as a real `vendor/model` key, so
      // a caller asking for `z-ai/glm-4.6` gets the router's margin instead
      // of Z.ai's own price. Keep them (for models no vendor lists
      // directly, they are the only quote there is) but never let one
      // outrank a first-party listing.
      if (bare.includes('/')) {
        if (!compound.has(bare)) {
          compound.set(bare, { ...schedule, tier: 1 })
        }
      }
      else if (!map.has(bare)) {
        map.set(bare, schedule)
      }
    }
  }
  for (const [key, schedule] of compound) {
    if (!map.has(key)) {
      map.set(key, schedule)
    }
  }
  return map
}
