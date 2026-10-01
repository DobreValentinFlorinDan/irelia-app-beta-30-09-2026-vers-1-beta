import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Tiny JSON-on-disk cache used to keep Riot match/timeline data between runs.
 *
 * Match bodies and timelines are immutable, so once a match is written it never
 * needs re-fetching. Scan result snapshots carry a timestamp and expire, so the
 * user can "refresh" to pull newer games without throwing away the whole cache.
 *
 * Everything lives under `<projectRoot>/cache` and is written atomically
 * (temp file + rename) so an interrupted write cannot corrupt a cached entry.
 */

const projectRoot = process.cwd()
const cacheRoot = path.join(projectRoot, 'cache')

function bucketPath(bucket: string) {
  return path.join(cacheRoot, bucket)
}

function entryPath(bucket: string, key: string) {
  const safeKey = key.replace(/[^a-zA-Z0-9._-]/g, '_')
  return path.join(bucketPath(bucket), `${safeKey}.json`)
}

export function cacheDirectory() {
  return cacheRoot
}

async function ensureBucket(bucket: string) {
  await mkdir(bucketPath(bucket), { recursive: true })
}

export async function readCache<T>(bucket: string, key: string): Promise<T | null> {
  const file = entryPath(bucket, key)
  try {
    const raw = await readFile(file, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/**
 * Atomic write: serialise to a sibling temp file, then rename over the target.
 * A rename is atomic on NTFS and POSIX, so readers either see the old complete
 * file or the new complete file - never a half-written one. The previous
 * implementation removed the target first, which opened a window where the
 * entry did not exist at all.
 */
export async function writeCache(bucket: string, key: string, value: unknown) {
  await ensureBucket(bucket)
  const file = entryPath(bucket, key)
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(value), 'utf8')
  await rename(temp, file)
}

export async function hasCache(bucket: string, key: string) {
  return existsSync(entryPath(bucket, key))
}

/** Lists the cache keys (without the .json extension) stored in a bucket. */
export async function listCacheKeys(bucket: string): Promise<string[]> {
  try {
    const entries = await readdir(bucketPath(bucket))
    return entries
      .filter((entry) => entry.endsWith('.json') && !entry.endsWith('.tmp'))
      .map((entry) => entry.slice(0, -'.json'.length))
  } catch {
    return []
  }
}

/** Counts the cached JSON entries in a bucket without reading their bodies. */
export async function countCacheKeys(bucket: string): Promise<number> {
  try {
    const entries = await readdir(bucketPath(bucket))
    return entries.filter((entry) => entry.endsWith('.json') && !entry.endsWith('.tmp')).length
  } catch {
    return 0
  }
}

/**
 * Deletes cached entries so harvesting can start from scratch.
 *
 * This clears *evidence*, not settings: keys listed in `keepKeys` survive, which
 * is how the user's own roster additions outlive a wipe. Directories are walked
 * rather than hard-coded so a bucket added later is covered automatically.
 *
 * Returns a per-bucket count of what was removed.
 */
export async function clearCache(options: { keepKeys?: string[] } = {}): Promise<Record<string, number>> {
  const keep = new Set(options.keepKeys ?? [])
  const removed: Record<string, number> = {}
  let buckets: string[]
  try {
    buckets = await readdir(cacheRoot)
  } catch {
    // No cache directory at all: nothing to clear.
    return removed
  }

  for (const bucket of buckets) {
    const full = path.join(cacheRoot, bucket)
    try {
      if (!(await stat(full)).isDirectory()) continue
    } catch {
      continue
    }
    let count = 0
    for (const file of await readdir(full)) {
      if (!file.endsWith('.json') || file.endsWith('.tmp')) continue
      const key = file.slice(0, -'.json'.length)
      if (keep.has(key)) continue
      try {
        await unlink(path.join(full, file))
        count += 1
      } catch {
        // A file locked by another process should not abort the whole wipe.
      }
    }
    removed[bucket] = count
  }

  return removed
}

/**
 * Total bytes on disk per bucket plus the overall total. Used for the storage
 * cap readout and to decide when quality pruning must run.
 */
export async function cacheSize(): Promise<{ total: number; buckets: Record<string, number> }> {
  const buckets: Record<string, number> = {}
  let total = 0
  let entries: string[]
  try {
    entries = await readdir(cacheRoot)
  } catch {
    return { total: 0, buckets }
  }
  for (const bucket of entries) {
    const full = path.join(cacheRoot, bucket)
    try {
      if (!(await stat(full)).isDirectory()) continue
    } catch {
      continue
    }
    let sum = 0
    for (const file of await readdir(full)) {
      try {
        sum += (await stat(path.join(full, file))).size
      } catch {
        // A file deleted mid-walk simply does not count.
      }
    }
    buckets[bucket] = sum
    total += sum
  }
  return { total, buckets }
}

/**
 * Deletes one cache entry and returns how many bytes were on disk, so the
 * caller can track how much room the deletion actually freed.
 */
export async function deleteCache(bucket: string, key: string): Promise<number> {
  const file = entryPath(bucket, key)
  try {
    const size = (await stat(file)).size
    await unlink(file)
    return size
  } catch {
    return 0
  }
}

/**
 * Serialise concurrent writers to the same logical resource. Riot match data is
 * shared across scans, so two scans touching the same match should not clobber
 * each other's writes.
 */
const inFlight = new Map<string, Promise<unknown>>()

export function dedupe<T>(key: string, factory: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key)
  if (existing) return existing as Promise<T>
  const promise = factory().finally(() => inFlight.delete(key))
  inFlight.set(key, promise)
  return promise
}