import type { PricingCache } from './cache'
import type { BilledTokens, TokenCounts } from './estimate'
import type { RowOptions } from './row'
import type { RequestFacts, ResolvedRates } from './schedule'
import type { PricingSource } from './sources'
import type { CostEstimate, ModelPrice, NormalizedSchedule, PriceSchedule, Rates, TimeInput } from './types'
import { decodeCacheEntry, encodeCacheEntry } from './cache'
import { FALLBACK, FAST_BY_ID, scaleSchedule, SNAPSHOT_SYNCED_AT_MS } from './catalog/fallback'
import { OVERRIDES } from './catalog/overrides'
import { billedTokens, costFromBilled, promptOfBilled, totalOfBilled, usedReasoning } from './estimate'
import { normalizeSchedule } from './normalize'
import { mergeLiveQuote } from './rates'
import { pricingCandidates } from './resolve'
import { estimateCostFromRow as estimateRow } from './row'
import { isTimeSensitive, NOTHING_KNOWN, pricesByRequest, ratesFor, toMs } from './schedule'
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
  /**
   * Whether these counts describe **one request**. Defaults to false.
   *
   * This is the gate on long-context tiers (see `ContextTier`), and it has
   * to be stated rather than inferred, because the threshold is per request
   * and a sum destroys exactly that: ten 30k requests plus one 500k request
   * add up to the same input as eleven 70k requests, and only the first has
   * a row that crossed 272k. Dividing by a request count does not recover
   * it either — an average is not a distribution.
   *
   * Defaulting to false keeps an aggregated row on the base card, which
   * undercharges the rare long request rather than overcharging every short
   * one. Rows that really are per-request — an agent CLI's message log, a
   * request-level API table — should set it and get the tier.
   */
  perRequest?: boolean
  /**
   * The prompt length to select a long-context tier against, overriding what
   * the counts imply. Passing it implies `perRequest`.
   *
   * For rows that carry the context length directly but whose component
   * counts are unreliable — a producer that stores `context_tokens` but
   * folds its cache counts together, say. Without it the length is derived
   * from the same quantities that get billed at the input rates
   * (`promptTokensBilled`), which is right whenever those counts are.
   */
  promptTokens?: number
}

/**
 * Cap on the resolved-lookup memo. It is keyed by the raw stored model
 * string, so anywhere a name reaches it from user input an unbounded Map is
 * a leak that outlives every request. Cleared wholesale rather than evicted
 * one at a time: the working set of a real deployment is a few hundred
 * names, so hitting this at all means the keys are not model names.
 */
const RESOLVED_LIMIT = 50_000

/** Normalise a whole table, dropping the schedules that cannot price. */
function normalizeTable(
  table: Record<string, PriceSchedule>,
  onWarn: (message: string, error: unknown) => void,
): Record<string, NormalizedSchedule> {
  const out: Record<string, NormalizedSchedule> = {}
  for (const [id, schedule] of Object.entries(table)) {
    const normalized = normalizeSchedule(schedule, onWarn, id)
    if (normalized) {
      out[id] = normalized
    }
  }
  return out
}

export class PricingCatalog {
  private readonly sources: PricingSource[]
  private readonly refreshMs: number
  private readonly retryMs: number
  private readonly cache: PricingCache | undefined
  private readonly cacheTtlMs: number
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly timeoutMs: number
  private readonly overrides: Record<string, NormalizedSchedule>
  private readonly fallback: Record<string, NormalizedSchedule>
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
  private readonly resolved = new Map<string, NormalizedSchedule | null>()

  /** Entries currently memoised. Exposed for tests and diagnostics. */
  get resolvedSize(): number {
    return this.resolved.size
  }

  constructor(options: PricingCatalogOptions = {}) {
    this.onWarn = options.onWarn ?? ((message, error) => {
      console.warn(`[llm-pricing] ${message}:`, error instanceof Error ? error.message : error)
    })
    this.sources = options.sources ?? [modelsDevSource()]
    this.refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS
    this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS
    this.cache = options.cache
    this.cacheTtlMs = options.cacheTtlMs ?? this.refreshMs
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    // Normalised at ingest, not per lookup: the pricing primitives run once
    // per row and check nothing, so this is the only place the invariants
    // they assume can be enforced.
    this.overrides = normalizeTable({ ...OVERRIDES, ...options.overrides }, this.onWarn)
    this.fallback = normalizeTable({ ...FALLBACK, ...options.fallback }, this.onWarn)
    this.archiveObservedAt = options.archiveObservedAt ?? SNAPSHOT_SYNCED_AT_MS
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
          if (merged.has(key)) {
            continue
          }
          const normalized = normalizeSchedule(schedule, this.onWarn, key)
          if (normalized) {
            merged.set(key, normalized)
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

  getSchedule(model: string): NormalizedSchedule | null {
    if (!model) {
      return null
    }
    const cached = this.resolved.get(model)
    if (cached !== undefined) {
      return cached
    }
    // The single gate every schedule leaves through, rather than one at each
    // table that feeds it. Two of the producers below *create* the shapes the
    // invariants exist for: `mergeLiveQuote` turns a flat archive plus a live
    // quote into a two-period schedule, and `scaleSchedule` copies whatever
    // its base was. Normalising here covers both, and covers whatever
    // produces a schedule next, by construction.
    const resolved = this.resolveSchedule(model)
    const schedule = resolved ? normalizeSchedule(resolved, this.onWarn, model) : null
    if (this.resolved.size >= RESOLVED_LIMIT) {
      this.resolved.clear()
    }
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

  /**
   * The last blend computed for each schedule.
   *
   * Purely an allocation optimisation. `weightedRates` builds a fresh
   * `Rates` per call, so without this a request folding 93,000 blended rows
   * allocates 93,000 rate cards and 93,000 `ModelPrice` wrappers where one
   * of each would do — the memo above is keyed on the `Rates` object, so it
   * cannot help. Nothing depends on the sharing being achieved:
   * `sumEstimates` groups cards by value, so a miss costs time and never
   * changes an answer.
   *
   * One slot, not a map. A request folds every row against a single
   * window, so a second slot would never be read, and a map keyed by
   * request parameters is an unbounded structure hanging off schedules that
   * — for flat models — the constructor owns and never releases.
   */
  private readonly lastBlend = new WeakMap<NormalizedSchedule, {
    from: number
    to: number
    promptTokens: number | undefined
    usedReasoning: boolean | undefined
    resolved: ResolvedRates
  }>()

  /**
   * What this row says about the single request behind it — nothing at all
   * unless the caller declared it to be one.
   *
   * `promptTokens` implies `perRequest`: a caller who states the prompt length
   * has necessarily told us the row describes one prompt. `usedReasoning` is
   * always derived, never asserted by the caller, because the counts answer it
   * directly and a producer that reports no reasoning tokens has said as much.
   */
  private factsFor(args: EstimateArgs, billed: BilledTokens): RequestFacts {
    if (args.promptTokens === undefined && !args.perRequest) {
      return NOTHING_KNOWN
    }
    let promptTokens: number
    if (args.promptTokens === undefined) {
      promptTokens = promptOfBilled(billed)
    }
    else {
      const n = Number(args.promptTokens)
      promptTokens = Number.isFinite(n) && n > 0 ? n : 0
    }
    return { promptTokens, usedReasoning: usedReasoning(args) }
  }

  private ratesForMemo(schedule: NormalizedSchedule, args: EstimateArgs, facts: RequestFacts): ResolvedRates {
    // Before anything else: a flat schedule ignores time entirely and
    // returns its one card, so every step below would be work spent to
    // memoise a `periods.length` check — and would pin a WeakMap entry to a
    // schedule the constructor holds forever. Flat is nearly every model.
    const window = args.window
    if (!window || !isTimeSensitive(schedule) || toMs(args.at) !== null) {
      return ratesFor(schedule, args.at, window, Date.now(), facts)
    }
    const a = toMs(window[0])
    const b = toMs(window[1])
    // An open-ended or unparseable bound sends `ratesFor` to the rate in
    // force *now*, which is a moving answer and so must never be stored.
    // Only a fully-bounded window makes the result a pure function of the
    // key.
    if (a === null || b === null) {
      return ratesFor(schedule, args.at, window, Date.now(), facts)
    }
    // A window is an interval, not an ordered pair — `ratesFor` says so and
    // normalises it, so the slot has to agree or the same interval written
    // backwards misses.
    const from = Math.min(a, b)
    const to = Math.max(a, b)
    // The request facts are part of the key, not just the window: two rows over
    // the same window can land in different long-context tiers or differ on
    // thinking, and a slot keyed on the window alone would hand the second row
    // the first one's card. Dropped from the key entirely for a schedule
    // priced by neither — nearly all of them — where they cannot change the
    // answer and would otherwise turn every row into a miss.
    // Compared field by field rather than through a composed key, because a
    // key would be a string allocated once per row to answer a two-field
    // question.
    const keyed = pricesByRequest(schedule)
    const promptTokens = keyed ? facts.promptTokens : undefined
    const usedReasoning = keyed ? facts.usedReasoning : undefined
    const hit = this.lastBlend.get(schedule)
    if (hit && hit.from === from && hit.to === to && hit.promptTokens === promptTokens && hit.usedReasoning === usedReasoning) {
      return hit.resolved
    }
    const resolved = ratesFor(schedule, undefined, window, Date.now(), facts)
    this.lastBlend.set(schedule, { from, to, promptTokens, usedReasoning, resolved })
    return resolved
  }

  private priceCardFor(schedule: PriceSchedule, resolved: ResolvedRates): ModelPrice {
    const cached = this.priceCards.get(resolved.rates)
    if (cached) {
      return cached
    }
    const card: ModelPrice = {
      ...resolved.rates,
      displayName: schedule.displayName,
      source: schedule.source,
      providerId: schedule.providerId,
      // Safe to memoise on the rates object even though these are further
      // keys: every variant card is a distinct object owned by exactly one
      // tier and one mode, so a given `Rates` can never be reached twice.
      contextTierAbove: resolved.tierAbove,
      reasoningMode: resolved.reasoningMode,
    }
    this.priceCards.set(resolved.rates, card)
    return card
  }

  /**
   * Resolve a model to the flat rate card that applies at `at` (default: now).
   *
   * `facts` selects a per-request variant, for showing what a request of that
   * shape would be charged — `{ promptTokens }` for a long-context tier,
   * `{ usedReasoning: true }` for thinking mode. Omitted, the base card is
   * returned, which is the right answer for "what does this model cost".
   */
  getPrice(model: string, at?: TimeInput, facts?: RequestFacts): ModelPrice | null {
    const schedule = this.getSchedule(model)
    if (!schedule) {
      return null
    }
    return this.priceCardFor(schedule, ratesFor(schedule, at ?? Date.now(), undefined, Date.now(), facts))
  }

  /**
   * Price a set of token counts.
   *
   * An unknown model returns cost 0 with `pricing: null` — the pair is what
   * separates "we do not know" from "it was free", and `tokens` records how
   * much usage that $0 is standing in for. Feed the results to
   * `sumEstimates` rather than adding `cost` up by hand, which throws that
   * distinction away along with the basis and the cards.
   */
  estimate(args: EstimateArgs): CostEstimate {
    // Reduced once and passed down. A row needs the same struct for its cost,
    // its billed total, the prompt length a tier is selected against, and
    // every card a cost interval is bounded by; each of those used to reduce
    // the raw counts again from scratch.
    const billed = billedTokens(args)
    const tokens = totalOfBilled(billed)
    const schedule = this.getSchedule(args.model)
    if (!schedule) {
      return { cost: 0, pricing: null, basis: 'flat', low: 0, high: 0, tokens }
    }
    const resolved = this.ratesForMemo(schedule, args, this.factsFor(args, billed))
    const { rates, basis, cards } = resolved
    const cost = costFromBilled(rates, billed)
    // Every card this row could have been charged at, priced against the same
    // counts: the ends of a blend, and any long-context tier the caller did
    // not rule out. These are reachable prices rather than a nominal error
    // bar — and for a blend the bound is tight, because cost is linear in the
    // rates, so the blended cost is the same weighted average of the cards'
    // costs and cannot fall outside them.
    let low = cost
    let high = cost
    if (cards) {
      for (const card of cards) {
        // The card that was actually applied is in here whenever a blend
        // averaged it, and pricing it again would only reproduce `cost`.
        if (card === rates) {
          continue
        }
        const bound = costFromBilled(card, billed)
        if (bound < low) {
          low = bound
        }
        if (bound > high) {
          high = bound
        }
      }
    }
    return { cost, pricing: this.priceCardFor(schedule, resolved), basis, low, high, tokens }
  }

  /**
   * Price a raw SQL row using snake_case `*_tokens` column names — the same
   * thing `estimateCostFromRow` does, against this catalogue rather than
   * the default one.
   *
   * Pass `columns` when your table spells them differently, `shape` when
   * the rows come from a producer that nests its counts differently — that
   * travels with whoever wrote the row, not with the model — and
   * `inferShape` to let each row's own total correct the half of `shape`
   * that is recoverable.
   */
  estimateFromRow(row: Record<string, unknown>, options?: RowOptions): CostEstimate {
    return estimateRow(this, row, options)
  }
}
