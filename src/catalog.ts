import type { PricingCache } from './cache'
import type { TokenCounts } from './estimate'
import type { RowColumns } from './row'
import type { PricingSource } from './sources'
import type { CostEstimate, ModelPrice, PriceSchedule, Rates, TimeInput } from './types'
import { decodeCacheEntry, encodeCacheEntry } from './cache'
import { FALLBACK, FAST_BY_ID, scaleSchedule, SNAPSHOT_SYNCED_AT_MS } from './catalog/fallback'
import { OVERRIDES } from './catalog/overrides'
import { costFromRates } from './estimate'
import { mergeLiveQuote } from './rates'
import { pricingCandidates } from './resolve'
import { estimateCostFromRow as estimateRow } from './row'
import { isTimeSensitive, ratesFor } from './schedule'
import { modelsDevSource } from './sources'

const DEFAULT_REFRESH_MS = 24 * 60 * 60 * 1000
const DEFAULT_RETRY_MS = 5 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 30 * 1000

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
  /**
   * Where to keep fetched catalogues between process lifetimes. Without
   * one, every restart re-downloads — and models.dev is ~4 MB, so a PM2
   * cluster pays that per worker per boot.
   *
   * `fileCache()` from `llm-pricing/node` is the usual choice; any string
   * store (Redis, KV, a `Map`) satisfies the interface.
   */
  cache?: PricingCache
  /**
   * How long a cached copy may be used without re-fetching. Defaults to
   * `refreshMs`. A copy older than this is still kept as a last resort
   * when the network is down.
   */
  cacheTtlMs?: number
  /** Injected for tests and for runtimes with a non-global fetch. */
  fetch?: typeof globalThis.fetch
  /**
   * How long to wait for a source before giving up on it. Default: 30s.
   *
   * `ensureLoaded()` is meant to be safe on a per-request path, and an
   * upstream that accepts the connection and then never answers would
   * otherwise hang every caller indefinitely.
   */
  timeoutMs?: number
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
  private readonly cache: PricingCache | undefined
  private readonly cacheTtlMs: number
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly timeoutMs: number
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
    this.cache = options.cache
    this.cacheTtlMs = options.cacheTtlMs ?? this.refreshMs
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
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
  timeSensitiveSqlPatterns(): readonly string[] {
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
  ensureLoaded(options: { force?: boolean } = {}): Promise<void> {
    const now = Date.now()
    if (!options.force) {
      if (this.status === 'ready' && now - this.loadedAt < this.refreshMs) {
        return Promise.resolve()
      }
      // Back off after a total failure so a downed upstream cannot put its
      // timeout in front of every request.
      if (this.failedAt !== 0 && now - this.failedAt < this.retryMs) {
        return Promise.resolve()
      }
      this.inflight ??= this.track(this.load(false))
      return this.inflight
    }
    // A forced load cannot join one already in flight: that one may be
    // serving from cache, which is precisely what `force` exists to
    // bypass. Chain after it instead, so the two do not race for `remote`.
    this.inflight = this.track((this.inflight ?? Promise.resolve()).then(async () => this.load(true)))
    return this.inflight
  }

  /** Hold a load as the in-flight one until it settles. */
  private track(load: Promise<void>): Promise<void> {
    const tracked = load.finally(() => {
      if (this.inflight === tracked) {
        this.inflight = null
      }
    })
    return tracked
  }

  /**
   * Reload now, ignoring the freshness window, the failure backoff and any
   * cached copy. For a "prices look wrong" button, a deploy hook, or a cron
   * that wants the catalogue warm before traffic arrives.
   */
  refresh(): Promise<void> {
    return this.ensureLoaded({ force: true })
  }

  /**
   * Fetch one source, or read it from the cache when a fresh copy is
   * there. Returns the response body plus the time it was actually
   * retrieved from the network.
   */
  private async fetchSource(source: PricingSource, force: boolean): Promise<{ body: string, fetchedAt: number, rescued?: boolean }> {
    const cached = await this.readCache(source)
    if (!force && cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
      return cached
    }
    try {
      // A source that never answers would otherwise hang every request that
      // called `ensureLoaded()`, which is documented as safe on a
      // per-request path. Falling back to the archive beats hanging.
      const response = await this.withTimeout(this.fetchImpl(source.url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      }))
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const body = await response.text()
      const fetchedAt = Date.now()
      await this.writeCache(source, fetchedAt, body)
      return { body, fetchedAt }
    }
    catch (error) {
      // A stale cached copy beats no copy: last week's catalogue is much
      // closer to the truth than the bundled archive, and the schedule
      // machinery keeps history on its own rates either way.
      if (cached) {
        this.onWarn(`source "${source.name}" unreachable, using cached copy`, error)
        // Flagged, because the upstream is down: without this the rescue
        // reads as a successful load, `retryMs` never engages, and every
        // request pays the dead upstream's timeout to be rescued again.
        return { ...cached, rescued: true }
      }
      throw error
    }
  }

  /**
   * Enforce the deadline ourselves as well as passing the signal.
   *
   * `AbortSignal` only helps if the fetch implementation honours it — a
   * custom or mocked one need not, and then the timeout protects nobody.
   * The timer is cleared on settle so it cannot hold the process open.
   */
  private async withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${this.timeoutMs}ms`)), this.timeoutMs)
        }),
      ])
    }
    finally {
      clearTimeout(timer)
    }
  }

  /**
   * A cache is an optimisation, so neither half of it may take the
   * catalogue down. A Redis client rejects when Redis is down; without
   * these guards an unreachable cache would stop the source from being
   * fetched at all, and a failed write-through would throw away a download
   * that had already succeeded.
   */
  private async readCache(source: PricingSource): Promise<{ body: string, fetchedAt: number } | null> {
    if (!this.cache) {
      return null
    }
    try {
      return decodeCacheEntry(await this.cache.get(source.url))
    }
    catch (error) {
      this.onWarn(`cache unreadable for "${source.name}"`, error)
      return null
    }
  }

  private async writeCache(source: PricingSource, fetchedAt: number, body: string): Promise<void> {
    if (!this.cache) {
      return
    }
    try {
      await this.cache.set(source.url, encodeCacheEntry(fetchedAt, body))
    }
    catch (error) {
      this.onWarn(`cache unwritable for "${source.name}"`, error)
    }
  }

  private async load(force: boolean): Promise<void> {
    const merged = new Map<string, PriceSchedule>()
    const loaded: string[] = []
    // The freshness of the whole catalogue is that of its oldest part.
    let oldestFetchedAt = Number.POSITIVE_INFINITY
    let rescued = false
    // Best source first: a later source only fills ids no earlier one had.
    for (const source of this.sources) {
      try {
        const result = await this.fetchSource(source, force)
        const parsed = source.parse(JSON.parse(result.body))
        for (const [key, schedule] of parsed) {
          if (!merged.has(key)) {
            merged.set(key, schedule)
          }
        }
        loaded.push(source.name)
        oldestFetchedAt = Math.min(oldestFetchedAt, result.fetchedAt)
        rescued ||= result.rescued === true
      }
      catch (error) {
        this.onWarn(`source "${source.name}" failed to load`, error)
      }
    }
    const complete = loaded.length === this.sources.length && !rescued
    if (loaded.length === 0) {
      // Keep serving whatever was already loaded; only the freshness label
      // degrades. With nothing loaded ever, we are on the fallback table.
      this.status = this.status === 'ready' ? 'stale' : 'missing'
      this.sourceName = 'fallback'
      this.failedAt = Date.now()
      this.loadedAt = Date.now()
    }
    else {
      if (!complete) {
        // One flaky source must not delete the models only it listed. They
        // would fall through to the archive — or to nothing, priced at $0 —
        // while `state()` still claimed the catalogue was ready. Carry the
        // previous load's entries into the gaps; fresh data still wins.
        for (const [key, schedule] of this.remote) {
          if (!merged.has(key)) {
            merged.set(key, schedule)
          }
        }
      }
      this.remote = merged
      this.status = complete ? 'ready' : 'stale'
      this.sourceName = loaded.join('+')
      // A load that only got through on cached copies, or that lost a
      // source, is a failure for backoff purposes even though it produced a
      // usable catalogue.
      this.failedAt = complete ? 0 : Date.now()
      // Dated by when the data was retrieved, not when it was read from
      // disk — otherwise reading a cache entry would reset the refresh
      // clock and the catalogue could never age out.
      this.loadedAt = oldestFetchedAt
    }
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
    // Best hit, not first hit. Candidates run most-exact-first, but an
    // exact spelling only resellers stock (`gpt-5-5`) has to lose to a
    // normalized one the vendor itself lists (`gpt-5.5`). Ties fall back to
    // candidate order, so a name that resolves cleanly — nearly all of
    // them — behaves exactly as before.
    let live: PriceSchedule | null = null
    let liveTier = Number.POSITIVE_INFINITY
    for (const candidate of candidates) {
      const fromRemote = this.remote.get(candidate)
      if (fromRemote && (fromRemote.tier ?? 1) < liveTier) {
        live = fromRemote
        liveTier = fromRemote.tier ?? 1
        if (liveTier === 0) {
          break
        }
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

  /**
   * Price a raw SQL row using snake_case `*_tokens` column names — the same
   * thing `estimateCostFromRow` does, against this catalogue rather than
   * the default one.
   *
   * Pass `columns` when your table spells them differently.
   */
  estimateFromRow(
    row: Record<string, unknown>,
    window?: readonly [TimeInput, TimeInput],
    columns?: RowColumns,
  ): CostEstimate {
    return estimateRow(this, row, window, columns)
  }
}
