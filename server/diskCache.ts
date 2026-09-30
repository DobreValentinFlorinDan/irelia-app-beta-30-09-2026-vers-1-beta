import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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

export async function writeCache(bucket: string, key: string, value: unknown) {
  await ensureBucket(bucket)
  const file = entryPath(bucket, key)
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, JSON.stringify(value), 'utf8')
  await rm(file, { force: true })
  await writeFile(file, JSON.stringify(value), 'utf8')
  await rm(temp, { force: true })
}

export async function hasCache(bucket: string, key: string) {
  return existsSync(entryPath(bucket, key))
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
