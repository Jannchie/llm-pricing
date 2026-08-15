import type { ModelsDevResponse, ParseModelsDevOptions } from './catalog/modelsdev'
import type { OpenRouterModelsResponse } from './catalog/openrouter'
import type { PriceSchedule } from './types'
import { MODELS_DEV_URL, parseModelsDev } from './catalog/modelsdev'
import { OPENROUTER_MODELS_URL, parseOpenRouterModels } from './catalog/openrouter'

/**
 * A remote price catalogue: where to fetch it and how to read it.
 *
 * Adapters exist so the choice of upstream is a caller decision rather than
 * a hard-coded dependency. Every adapter must return per-token USD rates
 * keyed by lowercase model id, ideally indexed by both `vendor/model` and
 * the bare model name.
 */
export interface PricingSource {
  name: string
  url: string
  parse: (json: any) => Map<string, PriceSchedule>
}

/**
 * OpenRouter's `/models`. One quote per model, reflecting whichever
 * endpoint OpenRouter would route to by default — which is NOT always the
 * first-party price (see `catalog/overrides.ts`).
 */
export function openRouterSource(url: string = OPENROUTER_MODELS_URL): PricingSource {
  return {
    name: 'openrouter',
    url,
    parse: (json: OpenRouterModelsResponse) => parseOpenRouterModels(json),
  }
}

/**
 * models.dev's `api.json` — the dataset behind llmpricing.dev. Quotes every
 * provider separately, so first-party rates are actually reachable, at the
 * cost of a ~4 MB payload and a provider-priority decision.
 */
export function modelsDevSource(options: ParseModelsDevOptions & { url?: string } = {}): PricingSource {
  const { url = MODELS_DEV_URL, ...parseOptions } = options
  return {
    name: 'modelsdev',
    url,
    parse: (json: ModelsDevResponse) => parseModelsDev(json, parseOptions),
  }
}
