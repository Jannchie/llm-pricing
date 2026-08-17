import type { PricingCache } from './cache'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Node-only entry point: `import { fileCache } from 'llm-pricing/node'`.
 *
 * Kept out of the main entry so the core stays free of `node:` imports and
 * still bundles for workers and the browser.
 */

/** Distinguishes concurrent writes to one key within a process. */
let writes = 0

/**
 * A catalogue cache backed by files on disk.
 *
 * Survives restarts, and is shared by every process pointed at the same
 * directory — a PM2 cluster downloads the catalogue once rather than once
 * per worker.
 *
 * Writes are atomic (write to a temp name, then rename), so a process
 * killed mid-write leaves the previous entry intact rather than a
 * truncated one. A missing, unreadable or corrupt file is a cache miss.
 */
export function fileCache(dir: string = path.join(tmpdir(), 'llm-pricing-cache')): PricingCache {
  // The key is a URL; hash it so it is a safe, fixed-length filename.
  const pathFor = (key: string): string => path.join(dir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`)
  return {
    async get(key) {
      try {
        return await readFile(pathFor(key), 'utf8')
      }
      catch {
        return null
      }
    },
    async set(key, value) {
      const target = pathFor(key)
      // Unique per write, not just per process: two concurrent writes of
      // the same key inside one process would otherwise interleave through
      // a single temp file and rename a splice of both into place.
      const temp = `${target}.${process.pid}.${(writes++).toString(36)}.tmp`
      try {
        await mkdir(dir, { recursive: true })
        await writeFile(temp, value, 'utf8')
        await rename(temp, target)
      }
      catch {
        // A cache that cannot be written is not an error — the catalogue
        // has the network and then the bundled archive behind it.
        //
        // The temp file is another matter: a `rename` that fails after the
        // write succeeded leaves a full copy of a ~4 MB catalogue behind, in
        // a directory nothing else prunes, once per attempt. Swallow the
        // unlink too — it fails precisely when there was nothing to remove.
        await unlink(temp).catch(() => {})
      }
    },
  }
}
