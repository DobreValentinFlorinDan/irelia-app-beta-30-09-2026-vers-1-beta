/**
 * Headless builder for the local cache ("database").
 *
 * This runs the *same* code path the desktop app runs when you press Scan: it
 * loads server/riotApi.ts through Vite's SSR loader exactly like
 * server/server.mjs does, then calls runKoreanScan. The only difference is that
 * there is no browser attached, so a multi-hour ladder sweep is not tied to an
 * open window and progress lands in stdout where it can be logged.
 *
 * Match bodies are cached permanently, so re-running is nearly free: anything
 * already on disk is reused and only new games cost Riot API calls.
 *
 * Usage (from the project root):
 *   node scripts/build-database.mjs [options]
 *
 * Options:
 *   --tier <all|challenger|grandmaster|master|emerald>   default: all
 *   --limit <n>          ladder entries read per region+tier      default: 20
 *   --sample <n>         recent ranked games pulled per candidate default: 40
 *   --threshold <0..1>   Irelia share required to count as an OTP default: 0.5
 *   --lane <TOP|MID>     restrict to one lane                     default: both
 *   --regions <csv>      KR,EUW,EUNE,NA                           default: all four
 *   --min-games <n>      Irelia games needed to enter the pool    default: 3
 *   --roster             deepen only the curated OTP roster, skip the ladders
 *   --deepen <n>         afterwards walk candidates until every matchup has n games
 *   --budget <n>         request cap for the deepen pass          default: 400
 *   --skip-scan          don't re-run the ladder scan; deepen using the cached one
 *   --prune <bytes>      afterwards drop the smallest matches while over this size
 *   --quiet              only print phase changes and the final summary
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer } from 'vite'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(2)

function flag(name) {
  return argv.includes(`--${name}`)
}

function option(name, fallback) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

function numberOption(name, fallback) {
  const value = Number(option(name, fallback))
  return Number.isFinite(value) ? value : fallback
}

const TIERS = ['all', 'challenger', 'grandmaster', 'master', 'emerald']
const REGIONS = ['KR', 'EUW', 'EUNE', 'NA']

const tier = String(option('tier', 'all'))
const laneRaw = String(option('lane', '')).toUpperCase()
const lane = laneRaw === 'TOP' || laneRaw === 'MID' ? laneRaw : null
const entryLimit = Math.min(Math.max(numberOption('limit', 20), 1), 40)
const sampleSize = Math.min(Math.max(numberOption('sample', 40), 1), 40)
const threshold = Math.min(Math.max(numberOption('threshold', 0.5), 0.3), 1)
const minIreliaGames = Math.min(Math.max(numberOption('min-games', 3), 1), 20)
const regions = String(option('regions', REGIONS.join(',')))
  .split(',')
  .map((value) => value.trim().toUpperCase())
  .filter((value) => value)
const rosterOnly = flag('roster')
const skipScan = flag('skip-scan')
const deepenTarget = Math.max(numberOption('deepen', 0), 0)
// A full coverage pass can legitimately need several thousand calls; the cap is
// only here to catch a typo, and every call is cached so a re-run is cheap.
const deepenBudget = Math.min(Math.max(numberOption('budget', 400), 20), 50_000)
const pruneBytes = Math.max(numberOption('prune', 0), 0)
const quiet = flag('quiet')

if (!TIERS.includes(tier)) {
  console.error(`[build] --tier must be one of ${TIERS.join(', ')}`)
  process.exit(2)
}
const unknownRegions = regions.filter((region) => !REGIONS.includes(region))
if (!regions.length || unknownRegions.length) {
  console.error(`[build] --regions must be a subset of ${REGIONS.join(', ')}`)
  process.exit(2)
}

/* ------------------------------------------------------------------ *
 * Environment (same minimal .env.local reader as server/server.mjs)
 * ------------------------------------------------------------------ */

function readEnvLocal() {
  const envPath = path.join(projectRoot, '.env.local')
  const values = {}
  if (!existsSync(envPath)) return values
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!match) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    values[match[1]] = value
  }
  return values
}

const fileEnv = readEnvLocal()
const apiKey = process.env.RIOT_API_KEY || fileEnv.RIOT_API_KEY || ''
if (!apiKey) {
  console.error('[build] No RIOT_API_KEY found. Put it in .env.local at the project root, or export it.')
  process.exit(2)
}

/* ------------------------------------------------------------------ *
 * Progress reporting
 * ------------------------------------------------------------------ */

const startedAt = Date.now()

function elapsed() {
  const total = Math.round((Date.now() - startedAt) / 1_000)
  const minutes = Math.floor(total / 60)
  return `${String(minutes).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

// The engine reports on every single match, which is far too chatty for a log
// that may run for an hour. Print a real phase change immediately, otherwise at
// most one line per interval.
//
// `ratelimit` is deliberately NOT treated as a phase change: the engine emits it
// every time the token bucket parks, and it interleaves with whatever phase was
// running, so counting it as a change made the log print every few seconds for
// the whole run.
const PRINT_INTERVAL_MS = quiet ? 30_000 : 5_000
let lastPrintAt = 0
let lastPhase = ''

function report(update) {
  const now = Date.now()
  const isRateLimit = update.phase === 'ratelimit'
  const phaseChanged = !isRateLimit && update.phase !== lastPhase
  if (!phaseChanged && now - lastPrintAt < PRINT_INTERVAL_MS) return
  if (!isRateLimit) lastPhase = update.phase
  lastPrintAt = now
  const progress = update.total ? ` (${update.done}/${update.total})` : ''
  console.log(`[${elapsed()}] ${update.phase}: ${update.message}${progress}`)
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

// A Vite server in middleware mode exists purely to compile and load the
// TypeScript engine. It must not watch the filesystem.
const loader = await createViteServer({
  root: projectRoot,
  configFile: false,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true },
})

const riot = await loader.ssrLoadModule('/server/riotApi.ts')
const engine = await loader.ssrLoadModule('/server/buildEngine.ts')
const disk = await loader.ssrLoadModule('/server/diskCache.ts')

riot.primeApiKey(apiKey)

console.log('[build] Irelia Fieldbook — headless cache builder')
console.log(`[build] cache dir : ${disk.cacheDirectory()}`)
console.log(`[build] scope     : tier=${tier} regions=${regions.join('+')} lane=${lane ?? 'BOTH'} limit=${entryLimit} sample=${sampleSize} threshold=${threshold} minGames=${minIreliaGames}${rosterOnly ? ' roster-only' : ''}`)

const scan = skipScan
  ? null
  : await riot.runKoreanScan(
    tier,
    entryLimit,
    sampleSize,
    threshold,
    lane,
    report,
    regions,
    minIreliaGames,
    rosterOnly,
  )

if (scan) {
  console.log('')
  console.log('[build] scan complete')
  console.log(`[build]   candidates found   : ${scan.masteryCandidates}`)
  console.log(`[build]   deepened           : ${scan.deepenedCandidates}`)
  console.log(`[build]   accepted OTPs      : ${scan.analyzed.length}`)
  console.log(`[build]   new games pulled   : ${scan.newGames}`)
  console.log(`[build]   reused from cache  : ${scan.cacheHits}`)
} else {
  console.log('')
  console.log('[build] --skip-scan: reusing the cached scan snapshot (candidates already known)')
}

if (deepenTarget > 0) {
  console.log('')
  console.log(`[build] deepening matchups to ${deepenTarget} games (budget ${deepenBudget} requests)…`)
  const deepened = await riot.deepenMatchups(lane, deepenTarget, report, { maxRequests: deepenBudget })
  console.log(`[build]   requests used      : ${deepened.requestsUsed}`)
  console.log(`[build]   matches added      : ${deepened.matchesAdded}`)
  console.log(`[build]   stop reason        : ${deepened.stopReason}`)
}

if (pruneBytes > 0) {
  console.log('')
  console.log(`[build] pruning while over ${(pruneBytes / 1024 / 1024).toFixed(0)} MB…`)
  const pruned = await riot.pruneLowQuality(pruneBytes, (message) => console.log(`[build]   ${message}`))
  console.log(`[build]   removed            : ${pruned.removedMatches} matches, ${(pruned.freedBytes / 1024 / 1024).toFixed(1)} MB freed`)
  console.log(`[build]   note               : ${pruned.note}`)
}

// Coverage is the honest progress measure: how many lane opponents have enough
// games to say anything about.
const coverage = await riot.computeCoverage(lane, 30)
console.log('')
console.log(`[build] coverage (target 30 games per opponent)`)
console.log(`[build]   opponents tracked  : ${coverage.totalCount}`)
console.log(`[build]   covered            : ${coverage.coveredCount}`)
console.log(`[build]   games still needed : ${coverage.gamesNeeded}`)

await engine.flushIreliaIndex()

const size = await disk.cacheSize()
console.log('')
console.log('[build] cache size')
for (const [bucket, bytes] of Object.entries(size.buckets).sort((a, b) => b[1] - a[1])) {
  const count = await disk.countCacheKeys(bucket)
  console.log(`[build]   ${bucket.padEnd(10)} ${String(count).padStart(6)} entries  ${(bytes / 1024 / 1024).toFixed(1)} MB`)
}
console.log(`[build]   ${'TOTAL'.padEnd(10)} ${''.padStart(6)}          ${(size.total / 1024 / 1024).toFixed(1)} MB`)
console.log(`[build] finished in ${elapsed()}`)

await loader.close()
process.exit(0)
