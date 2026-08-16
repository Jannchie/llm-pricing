import type { PricingSource } from '../src/sources'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { memoryCache } from '../src/cache'
import { PricingCatalog } from '../src/catalog'
import { fileCache } from '../src/node'
import { flatSchedule } from '../src/rates'

// The price travels in the fetch stub's payload, so a test can change what
// upstream reports between calls and watch what the catalogue does.
function source(): PricingSource {
  return {
    name: 'remote',
    url: 'https://example.test/models',
    parse: (json: { input: number }) => new Map([
      ['model-a', flatSchedule('Model A', json.input, json.input / 10, json.input * 5, undefined, 'modelsdev')],
    ]),
  }
}

/** A fetch stub whose payload can change between calls. */
function stubFetch(price: { value: number }, calls: { n: number }): typeof globalThis.fetch {
  return (async () => {
    calls.n++
    return Response.json({ input: price.value }, { status: 200 })
  }) as unknown as typeof globalThis.fetch
}

describe('caching', () => {
  it('serves a second catalogue from the cache without re-fetching', async () => {
    const cache = memoryCache()
    const price = { value: 1e-6 }
    const calls = { n: 0 }
    const options = { sources: [source()], cache, fetch: stubFetch(price, calls) }

    const first = new PricingCatalog(options)
    await first.ensureLoaded()
    const second = new PricingCatalog(options)
    await second.ensureLoaded()

    expect(calls.n).toBe(1)
    expect(second.getPrice('model-a')?.inputCostPerToken).toBe(1e-6)
  })

  it('does not let a cache read reset the refresh clock', async () => {
    const cache = memoryCache()
    const price = { value: 1e-6 }
    const calls = { n: 0 }
    const fetch = stubFetch(price, calls)

    await new PricingCatalog({ sources: [source()], cache, fetch }).ensureLoaded()
    // A catalogue whose refresh window has already passed must re-fetch
    // even though a cache entry exists.
    const stale = new PricingCatalog({ sources: [source()], cache, fetch, refreshMs: -1, cacheTtlMs: -1 })
    await stale.ensureLoaded()
    expect(calls.n).toBe(2)
  })

  it('falls back to a stale cached copy when the network is down', async () => {
    const cache = memoryCache()
    const price = { value: 1e-6 }
    const calls = { n: 0 }
    await new PricingCatalog({ sources: [source()], cache, fetch: stubFetch(price, calls) }).ensureLoaded()

    const warn = vi.fn()
    const offline = new PricingCatalog({
      sources: [source()],
      cache,
      cacheTtlMs: -1, // force the cache to look stale
      fetch: (async () => new Response('nope', { status: 503 })) as unknown as typeof globalThis.fetch,
      onWarn: warn,
    })
    await offline.ensureLoaded()

    expect(offline.state().status).toBe('ready')
    expect(offline.getPrice('model-a')?.inputCostPerToken).toBe(1e-6)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('survives a corrupt cache entry', async () => {
    const store = new Map([['https://example.test/models', 'not json at all']])
    const price = { value: 2e-6 }
    const calls = { n: 0 }
    const catalog = new PricingCatalog({
      sources: [source()],
      cache: memoryCache(store),
      fetch: stubFetch(price, calls),
    })
    await catalog.ensureLoaded()
    expect(calls.n).toBe(1)
    expect(catalog.getPrice('model-a')?.inputCostPerToken).toBe(2e-6)
  })
})

describe('force refresh', () => {
  it('re-fetches even while the catalogue is fresh', async () => {
    const price = { value: 1e-6 }
    const calls = { n: 0 }
    const catalog = new PricingCatalog({ sources: [source()], cache: memoryCache(), fetch: stubFetch(price, calls) })

    await catalog.ensureLoaded()
    await catalog.ensureLoaded() // fresh: no-op
    expect(calls.n).toBe(1)

    price.value = 9e-6
    await catalog.refresh()
    expect(calls.n).toBe(2)
    expect(catalog.getPrice('model-a')?.inputCostPerToken).toBe(9e-6)
  })

  it('ignores the failure backoff', async () => {
    const calls = { n: 0 }
    const catalog = new PricingCatalog({
      sources: [source()],
      fetch: (async () => {
        calls.n++
        return new Response('nope', { status: 503 })
      }) as unknown as typeof globalThis.fetch,
      onWarn: () => {},
    })
    await catalog.ensureLoaded()
    await catalog.ensureLoaded() // backed off
    expect(calls.n).toBe(1)
    await catalog.refresh()
    expect(calls.n).toBe(2)
  })
})

describe('filecache', () => {
  const dirs: string[] = []
  afterAll(async () => {
    await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
  })

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'llm-pricing-test-'))
    dirs.push(dir)
    return dir
  }

  it('round-trips through disk', async () => {
    const cache = fileCache(await tempDir())
    await cache.set('https://example.test/a', 'hello')
    expect(await cache.get('https://example.test/a')).toBe('hello')
  })

  it('reports a miss for an unknown key', async () => {
    expect(await fileCache(await tempDir()).get('https://example.test/nope')).toBeNull()
  })

  it('survives a directory it cannot write', async () => {
    // Point the cache at a path that is a *file*, so mkdir fails with
    // ENOTDIR. A permission-denied path would do too, but the obvious
    // candidates are not portable: /proc exists only on Linux, and on the
    // CI runner mkdir under it hangs rather than erroring.
    const file = path.join(await tempDir(), 'not-a-directory')
    await writeFile(file, '')
    const cache = fileCache(file)
    await expect(cache.set('k', 'v')).resolves.toBeUndefined()
    expect(await cache.get('k')).toBeNull()
  })

  it('shares a download between two catalogues in different processes', async () => {
    const cache = fileCache(await tempDir())
    const price = { value: 3e-6 }
    const calls = { n: 0 }
    const options = { sources: [source()], cache, fetch: stubFetch(price, calls) }

    await new PricingCatalog(options).ensureLoaded()
    const rebooted = new PricingCatalog(options)
    await rebooted.ensureLoaded()

    expect(calls.n).toBe(1)
    expect(rebooted.getPrice('model-a')?.inputCostPerToken).toBe(3e-6)
  })
})
