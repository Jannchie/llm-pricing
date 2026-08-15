import type { TokenCounts } from './estimate'
import type { PricingSource } from './sources'
import type { CostEstimate, ModelPrice, PriceSchedule, Rates, TimeInput } from './types'
import { FALLBACK, FAST_BY_ID, scaleSchedule, SNAPSHOT_SYNCED_AT_MS } from './catalog/fallback'
import { OVERRIDES } from './catalog/overrides'
import { costFromRates } from './estimate'
import { mergeLiveQuote } from './rates'
import { pricingCandidates } from './resolve'
import { isTimeSensitive, ratesFor } from './schedule'
import { modelsDevSource } from './sources'

const DEFAULT_REFRESH_MS = 24 * 60 * 60 * 1000
const DEFAULT_RETRY_MS = 5 * 60 * 1000

export interface PricingCatalogOptions {
  /**
   * Remote catalogues to consult, best first. A model resolves against the
   * first source that lists it. Defaults to `[modelsDevSource()]`, which
   * quotes each provider separately so first-party rates are reachable.
   *
   * Add `openRouterSource()` after it to fill in models models.dev does not
   * list, or put it first to price everything the way OpenRouter would
   * route it.
   *
   * Pass `[]` for a fully offline catalogue that only ever uses the bundled
   * snapshot and the overrides.
   */
  sources?: PricingSource[]
  /** How long a successful load stays fresh. Default: 24h. */
  refreshMs?: number
  /**
   * How long to wait before retrying after every source failed. Default:
   * 5 minutes.
   *
   * Without this, `ensureLoaded()` on a per-request path re-attempts the
   * full download on every request for as long as the upstream is down,
   * adding its latency and bandwidth to each one. The bundled archive is
   * answering those requests correctly in the meantime, so there is no
   * urgency.
   */
  retryMs?: number
  /** Injected for tests and for runtimes with a non-global fetch. */
  fetch?: typeof globalThis.fetch
  /**
   * Extra schedules that outrank every remote source, merged over the
   * built-in overrides. Keys are lowercase model ids.
   */
  overrides?: Record<string, PriceSchedule>
  /**
   * Extra schedules consulted after every remote source, merged over the
   * built-in fallback table. Keys are lowercase model ids.
   */
  fallback?: Record<string, PriceSchedule>
  /** Called when a source fails to load. Defaults to `console.warn`. */
  onWarn?: (message: string, error: unknown) => void
  /**
   * The moment the bundled archive was last known to be accurate, as epoch
   * ms. A live quote is grafted on as the period starting here, so history
   * before it keeps the rates the archive recorded. Defaults to the bundled
   * archive's sync date; override it when you supply your own `fallback`.
   */
  archiveObservedAt?: number
}

export interface PricingCatalogState {
  status: 'ready' | 'stale' | 'missing'
  loadedAt: number
  source: string
  size: number
}

export type EstimateArgs = TokenCounts & {
  model: string
  /**
   * When these tokens were spent. Pass `at` whenever the row is anchored to
   * a real instant; pass `window` — the request's [since, until] — when it
   * is a sum over a range. Both are ignored for models with a flat
   * schedule, which is nearly all of them.
   */
  at?: TimeInput
  window?: readonly [TimeInput, TimeInput]
}

export class PricingCatalog {
  private readonly sources: PricingSource[]
  private readonly refreshMs: number
  private readonly retryMs: number
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly overrides: Record<string, PriceSchedule>
  private readonly fallback: Record<string, PriceSchedule>
  private readonly onWarn: (message: string, error: unknown) => void
  private readonly archiveObservedAt: number

  private loadedAt = 0
  private failedAt = 0
  private status: PricingCatalogState['status'] = 'missing'
  private sourceName = 'fallback'
  private remote = new Map<string, PriceSchedule>()
  private inflight: Promise<void> | null = null

  /**
   * Resolved lookups, keyed by the raw stored model string. A dashboard
   * request resolves thousands of rows across a handful of distinct models,
   * and every miss re-runs the whole candidate expansion. Invalidated
   * wherever `remote` is reassigned.
   */
  private readonly resolved = new Map<string, PriceSchedule | null>()

  constructor(options: PricingCatalogOptions = {}) {
    this.sources = options.sources ?? [modelsDevSource()]
    this.refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS
    this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.overrides = { ...OVERRIDES, ...options.overrides }
    this.fallback = { ...FALLBACK, ...options.fallback }
    this.archiveObservedAt = options.archiveObservedAt ?? SNAPSHOT_SYNCED_AT_MS
    this.onWarn = options.onWarn ?? ((message, error) => {
      console.warn(`[llm-pricing] ${message}:`, error instanceof Error ? error.message : error)
    })
  }

  /**
   * Every LIKE pattern a query layer must split by UTC hour, derived from
   * the schedules themselves so the two can never drift: a vendor that
   * gains a peak schedule declares `sqlMatch` next to its periods and the
   * query layer follows automatically.
   */
  get timeSensitiveSqlPatterns(): readonly string[] {
    return [...new Set([
      ...[...Object.values(this.overrides), ...Object.values(this.fallback)]
        .filter(schedule => isTimeSensitive(schedule))
        .flatMap(schedule => schedule.sqlMatch ?? []),
      ...this.livePatterns,
    ])]
  }

  /**
   * Patterns for models the *live* catalogue has repriced since the archive
   * was synced — they are time-sensitive only once a source is loaded, so
   * they cannot be derived from the static tables. Recomputed on each load.
   *
   * Looks each archive id up in the remote map directly rather than through
   * `pricingCandidates`: both are keyed by the same catalogue ids, and a
   * miss here only means the model blends across the request window instead
   * of pricing exactly.
   */
  private livePatterns: string[] = []

  private recomputeLivePatterns(): void {
    const patterns = new Set<string>()
    for (const [id, archived] of Object.entries(this.fallback)) {
      const live = this.remote.get(id)
      if (!live) {
        continue
      }
      const merged = mergeLiveQuote(archived, live, this.archiveObservedAt, [`%${id}%`])
      if (isTimeSensitive(merged)) {
        for (const pattern of merged.sqlMatch ?? []) {
          patterns.add(pattern)
        }
      }
    }
    this.livePatterns = [...patterns]
  }

  /**
   * Load the remote catalogue if it is missing or stale. Safe to call on
   * every request: it resolves immediately while fresh and de-duplicates
   * concurrent loads.
   */
  ensureLoaded(): Promise<void> {
    const now = Date.now()
    if (this.status === 'ready' && now - this.loadedAt < this.refreshMs) {
      return Promise.resolve()
    }
    // Back off after a total failure so a downed upstream cannot put its
    // timeout in front of every request.
    if (this.failedAt !== 0 && now - this.failedAt < this.retryMs) {
      return Promise.resolve()
    }
    this.inflight ??= this.load().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async load(): Promise<void> {
    const merged = new Map<string, PriceSchedule>()
    const loaded: string[] = []
    // Best source first: a later source only fills ids no earlier one had.
    for (const source of this.sources) {
      try {
        const response = await this.fetchImpl(source.url, { headers: { accept: 'application/json' } })
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        const parsed = source.parse(await response.json())
        for (const [key, schedule] of parsed) {
          if (!merged.has(key)) {
            merged.set(key, schedule)
          }
        }
        loaded.push(source.name)
      }
      catch (error) {
        this.onWarn(`source "${source.name}" failed to load`, error)
      }
    }
    if (loaded.length === 0) {
      // Keep serving whatever was already loaded; only the freshness label
      // degrades. With nothing loaded ever, we are on the fallback table.
      this.status = this.status === 'ready' ? 'stale' : 'missing'
      this.sourceName = 'fallback'
      this.failedAt = Date.now()
    }
    else {
      this.remote = merged
      this.status = 'ready'
      this.sourceName = loaded.join('+')
      this.failedAt = 0
    }
    this.loadedAt = Date.now()
    this.resolved.clear()
    this.recomputeLivePatterns()
  }

  state(): PricingCatalogState {
    return {
      status: this.status,
      loadedAt: this.loadedAt,
      source: this.sourceName,
      size: this.remote.size,
    }
  }

  getSchedule(model: string): PriceSchedule | null {
    if (!model) {
      return null
    }
    const cached = this.resolved.get(model)
    if (cached !== undefined) {
      return cached
    }
    const schedule = this.resolveSchedule(model)
    this.resolved.set(model, schedule)
    return schedule
  }

  private resolveSchedule(model: string): PriceSchedule | null {
    const candidates = pricingCandidates(model)
    // Overrides first: they exist precisely because a catalogue's answer
    // for these models is wrong (reseller rate) or unrepresentable
    // (peak/off-peak).
    for (const candidate of candidates) {
      const override = this.overrides[candidate]
      if (override) {
        return override
      }
    }
    // Fast tiers are derived from the base model rather than looked up: see
    // FAST_BY_ID. This runs before any catalogue so a reseller's marked-up
    // `-fast` listing cannot win.
    for (const candidate of candidates) {
      const fast = FAST_BY_ID[candidate]
      if (fast) {
        const base = this.getSchedule(fast.base)
        return base ? scaleSchedule(base, fast.multiplier, 'Fast') : null
      }
    }
    let live: PriceSchedule | null = null
    for (const candidate of candidates) {
      const fromRemote = this.remote.get(candidate)
      if (fromRemote) {
        live = fromRemote
        break
      }
    }
    let archived: PriceSchedule | null = null
    let archivedId = ''
    for (const candidate of candidates) {
      const fallback = this.fallback[candidate]
      if (fallback) {
        archived = fallback
        archivedId = candidate
        break
      }
    }
    if (!live) {
      return archived
    }
    // A live quote prices *now*, not the past. Graft it onto whatever
    // history the archive has instead of letting one number cover all time.
    return mergeLiveQuote(archived, live, this.archiveObservedAt, archivedId ? [`%${archivedId}%`] : undefined)
  }

  /**
   * The `pricing` block handed back per row, memoised on the rate card so a
   * request pricing thousands of rows against the same card allocates one
   * object rather than thousands. A rate card belongs to exactly one
   * schedule, so its name and provenance can never disagree.
   */
  private readonly priceCards = new WeakMap<Rates, ModelPrice>()

  private priceCardFor(schedule: PriceSchedule, rates: Rates): ModelPrice {
    const cached = this.priceCards.get(rates)
    if (cached) {
      return cached
    }
    const card: ModelPrice = { ...rates, displayName: schedule.displayName, source: schedule.source }
    this.priceCards.set(rates, card)
    return card
  }

  /** Resolve a model to the flat rate card that applies at `at` (default: now). */
  getPrice(model: string, at?: TimeInput): ModelPrice | null {
    const schedule = this.getSchedule(model)
    if (!schedule) {
      return null
    }
    return this.priceCardFor(schedule, ratesFor(schedule, at ?? Date.now(), undefined).rates)
  }

  /** Price a set of token counts. Returns cost 0 for an unknown model. */
  estimate(args: EstimateArgs): CostEstimate {
    const schedule = this.getSchedule(args.model)
    if (!schedule) {
      return { cost: 0, pricing: null, basis: 'flat' }
    }
    const { rates, basis } = ratesFor(schedule, args.at, args.window)
    return { cost: costFromRates(rates, args), pricing: this.priceCardFor(schedule, rates), basis }
  }
}
