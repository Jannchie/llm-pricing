import type { ContextTier, PriceSchedule, Rates } from '../types'

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

export interface ModelsDevCost {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  reasoning?: number
  /**
   * Request-scale tiers. Each entry is a full cost block plus the threshold
   * that selects it; only `tier.type === 'context'` exists upstream today
   * (375 of 375 tiers across 360 models), and anything else is ignored
   * rather than guessed at.
   */
  tiers?: ModelsDevTier[]
}

export interface ModelsDevTier extends ModelsDevCost {
  tier?: { type?: string, size?: number }
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

/**
 * Whether a models.dev cost block may be priced against at all.
 *
 * The single definition of what is allowed into either the live index or the
 * archive — both read the same payload, and a rule enforced in only one of
 * them lets a row upstream rejects live still be written to disk forever.
 */
export function isUsableCost(cost: ModelsDevCost | undefined): cost is ModelsDevCost {
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
 * The cache rates a cost block implies, in whatever unit `divisor` selects
 * (1e6 for per-token, 1 to stay per-MTok as the archive does).
 *
 * Absent `cache_write` falls back to `cache_read`, absent `cache_read` to 10%
 * of input — the same convention the OpenRouter adapter applies. Shared so
 * the live index and the archive cannot default differently and turn one
 * quote into two.
 */
export function cacheRatesFrom(cost: ModelsDevCost, divisor: number): { cacheRead: number, cacheWrite: number } {
  const input = cost.input! / divisor
  const cacheRead = typeof cost.cache_read === 'number' && Number.isFinite(cost.cache_read)
    ? cost.cache_read / divisor
    : input * 0.1
  const cacheWrite = typeof cost.cache_write === 'number' && Number.isFinite(cost.cache_write)
    ? cost.cache_write / divisor
    : cacheRead
  return { cacheRead, cacheWrite }
}

/** The five rates a models.dev cost block implies, in `divisor`'s unit. */
export function ratesFromCost(cost: ModelsDevCost, divisor: number): Rates {
  const { cacheRead, cacheWrite } = cacheRatesFrom(cost, divisor)
  return {
    inputCostPerToken: cost.input! / divisor,
    cacheCreationInputCostPerToken: cacheWrite,
    cacheReadInputCostPerToken: cacheRead,
    cachedInputCostPerToken: cacheRead,
    outputCostPerToken: cost.output! / divisor,
  }
}

/**
 * The rates a long-context tier implies — the tier's own numbers where it
 * publishes them, and otherwise the base card's, scaled by how much the tier
 * moved input.
 *
 * A tier is a *variant* of the base card, not an independent quote, and the
 * generic defaults get that badly wrong when a tier is quoted partially.
 * `openrouter`'s `google/gemini-2.5-pro` publishes `cache_write: 0.375` on the
 * base and omits it on the >200k tier; `cacheRatesFrom` would then fall back
 * to the tier's own `cache_read` of 0.25 and bill long requests' cache writes
 * BELOW the base rate, while their input doubled. 11 listings upstream are
 * shaped that way.
 *
 * Scaling by the input ratio is the assumption these vendors actually
 * publish — every fully-quoted tier upstream moves its cache rates in step
 * with input — and it can only ever be applied to a number the tier did not
 * state, so an explicit upstream rate is never overridden. That matters for
 * the two listings whose tier is genuinely *cheaper* in one dimension
 * (`llmgateway`'s grok-4-20 pair): those numbers are quoted, so they stand.
 */
export function tierRatesFrom(base: ModelsDevCost, tier: ModelsDevTier, divisor: number): Rates {
  const input = tier.input! / divisor
  // A base input of 0 leaves no ratio to scale by; fall through to the
  // generic defaults rather than inventing one.
  const ratio = typeof base.input === 'number' && base.input > 0 ? tier.input! / base.input : null
  const inherited = (own: number | undefined, from: number | undefined): number | null => {
    if (typeof own === 'number' && Number.isFinite(own)) {
      return own / divisor
    }
    return ratio !== null && typeof from === 'number' && Number.isFinite(from) ? (from * ratio) / divisor : null
  }
  const cacheRead = inherited(tier.cache_read, base.cache_read) ?? input * 0.1
  const cacheWrite = inherited(tier.cache_write, base.cache_write) ?? cacheRead
  return {
    inputCostPerToken: input,
    cacheCreationInputCostPerToken: cacheWrite,
    cacheReadInputCostPerToken: cacheRead,
    cachedInputCostPerToken: cacheRead,
    outputCostPerToken: tier.output! / divisor,
  }
}

/**
 * The long-context tiers a models.dev cost block declares, ascending.
 *
 * Only `type: 'context'` is read. A tier's threshold is a **prompt** length,
 * so a differently-typed tier would be selected by something this package
 * does not measure; ignoring it prices those requests at the base rate,
 * which undercharges, where guessing could overcharge every request.
 *
 * Each tier must pass `isUsableCost` in its own right. That matters more
 * here than for a base quote: a tier quoting 0/0 would make every request
 * above the threshold free, turning the dearest requests into the cheapest.
 *
 * Rates a tier leaves out are inherited from `cost` rather than defaulted
 * generically — see `tierRatesFrom`.
 */
export function contextTiersFrom(cost: ModelsDevCost, divisor: number): ContextTier[] | undefined {
  const tiers: ContextTier[] = []
  for (const tier of cost.tiers ?? []) {
    const size = tier.tier?.size
    if (tier.tier?.type !== 'context' || typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
      continue
    }
    if (!isUsableCost(tier)) {
      continue
    }
    tiers.push({ abovePromptTokens: size, rates: tierRatesFrom(cost, tier, divisor) })
  }
  if (tiers.length === 0) {
    return undefined
  }
  return tiers.sort((a, b) => a.abovePromptTokens - b.abovePromptTokens)
}

/**
 * Turn a models.dev `api.json` payload into a lookup keyed by both
 * `provider/model` and the bare model id.
 *
 * models.dev quotes USD per **million** tokens; this converts to per-token
 * so every source in this package speaks the same unit.
 *
 * Long-context tiers are read from `cost.tiers`. The older
 * `context_over_200k` field is ignored: it is a redundant restatement of the
 * same numbers with the threshold baked into the key, and reading both would
 * risk quoting one model two thresholds.
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
      const schedule: PriceSchedule = {
        displayName: typeof model.name === 'string' ? model.name : undefined,
        source: 'modelsdev',
        providerId,
        tier: rank.has(providerId) ? 0 : 1,
        periods: [{
          from: Number.NEGATIVE_INFINITY,
          rates: ratesFromCost(cost, 1e6),
          contextTiers: contextTiersFrom(cost, 1e6),
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
