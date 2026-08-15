/**
 * Somewhere to keep a fetched catalogue between process lifetimes.
 *
 * Deliberately a two-method string store, so a filesystem, Redis, a
 * Cloudflare KV namespace or a test double all satisfy it without an
 * adapter. TTL is handled by the catalogue, not the store — entries carry
 * their own timestamp — so a dumb `Map` is a complete implementation.
 *
 * Keys are source URLs. Values are opaque; do not parse them.
 */
export interface PricingCache {
  get: (key: string) => Promise<string | null | undefined> | string | null | undefined
  set: (key: string, value: string) => Promise<void> | void
}

/** What we actually store under a key. */
interface CacheEntry {
  fetchedAt: number
  body: string
}

export function encodeCacheEntry(fetchedAt: number, body: string): string {
  return JSON.stringify({ fetchedAt, body } satisfies CacheEntry)
}

export function decodeCacheEntry(raw: string | null | undefined): CacheEntry | null {
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CacheEntry>
    if (typeof parsed.body !== 'string' || typeof parsed.fetchedAt !== 'number') {
      return null
    }
    return { fetchedAt: parsed.fetchedAt, body: parsed.body }
  }
  catch {
    // A corrupt entry is a cache miss, never an error: the catalogue can
    // always fall back to the network and then to the bundled archive.
    return null
  }
}

/**
 * An in-process cache. Useful for tests and for sharing one download
 * between several `PricingCatalog` instances in the same process; it buys
 * nothing across restarts — use a file or KV store for that.
 */
export function memoryCache(store: Map<string, string> = new Map()): PricingCache {
  return {
    get: key => store.get(key) ?? null,
    set: (key, value) => {
      store.set(key, value)
    },
  }
}
