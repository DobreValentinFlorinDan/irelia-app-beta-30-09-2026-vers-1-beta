import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import https from 'node:https'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ViteDevServer } from 'vite'
import {
  aggregateProfile,
  buildMatchData,
  flushIreliaIndex,
  getCachedMatch,
  getCachedMatchForPlayer,
  getCachedTimeline,
  getPlayerPosition,
  loadCacheWideIreliaMatches,
} from './buildEngine.js'
import type {
  BuildProfile,
  MatchBuildData,
  MatchRecord,
  OtpRole as EngineOtpRole,
  ProgressReporter,
  Routing as EngineRouting,
} from './buildEngine.js'
import { cacheDirectory, cacheEntryMtime, cacheSize, clearCache, deleteCache, hasCache, listCacheKeys, readCache, writeCache } from './diskCache.js'
import {
  analyseSkillOrder,
  matchWeight,
  optimiseItemSets,
  shrinkWinRate,
  shrunkenInterval,
  weightedInterval,
  wilsonInterval,
  type ConfidenceInterval,
  type ItemSetEntry,
  type SkillOrderAnalysis,
} from './analytics.js'

type Routing = EngineRouting
/**
 * Ladder tiers the scanner can read. `emerald` is the widened fallback pool: it
 * is only consulted when the high-rank pass stops producing new games, so the
 * sparse matchups can still be filled.
 */
type OtpTier = 'all' | 'challenger' | 'grandmaster' | 'master' | 'emerald'
type OtpRole = 'TOP' | 'MID'
type ScanRegion = 'KR' | 'EUW' | 'EUNE' | 'NA'

export type RiotOptions = {
  apiKey?: string
  lockfilePath?: string
}

/**
 * Seeds the key the shared engine adapter resolves lazily. The Vite middleware
 * sets it per request, but a long-lived desktop server must set it at boot so
 * background scans and cache-wide builds can reach Riot before the first
 * request arrives.
 */
export function primeApiKey(apiKey: string | undefined) {
  if (apiKey) activeApiKey = apiKey
}

class ApiError extends Error {
  readonly statusCode: number

  constructor(message: string, statusCode: number) {
    super(message)
    this.statusCode = statusCode
  }
}

const apiHosts: Record<Routing, string> = {
  EUROPE: 'europe.api.riotgames.com',
  ASIA: 'asia.api.riotgames.com',
  KR: 'kr.api.riotgames.com',
  EUN1: 'eun1.api.riotgames.com',
  AMERICAS: 'americas.api.riotgames.com',
  EUW1: 'euw1.api.riotgames.com',
  NA1: 'na1.api.riotgames.com',
}

/**
 * Each scannable region maps a platform routing (ladder + mastery live on the
 * platform) to a regional routing (matches and timelines live on the regional
 * cluster). Irelia mains are denser in EUW/EUNE than in KR alone, so scanning a
 * region set gives a far better sample of active mains than a single ladder.
 */
const scanRegions: Record<ScanRegion, { platform: Routing; regional: Routing; label: string }> = {
  KR: { platform: 'KR', regional: 'ASIA', label: 'Korea' },
  EUW: { platform: 'EUW1', regional: 'EUROPE', label: 'EU West' },
  EUNE: { platform: 'EUN1', regional: 'EUROPE', label: 'EU Nordic & East' },
  NA: { platform: 'NA1', regional: 'AMERICAS', label: 'North America' },
}

const defaultScanRegions: ScanRegion[] = ['KR', 'EUW', 'EUNE', 'NA']

/**
 * Curated priority roster of Irelia one-tricks.
 *
 * Ladder discovery alone finds whatever happens to be on the sampled pages and
 * yields thin matchup coverage. These accounts are known, high-volume Irelia
 * specialists, so the scan resolves them by Riot ID and pulls their matches
 * *before* the ladder-derived candidates. That makes a short scan fill the
 * matchups these players actually cover.
 *
 * The LP / play-rate / games / win-rate / KDA figures are a reference snapshot
 * as published on onetricks.gg; the live scan recomputes games and win rate from
 * the matches it harvests.
 */
export type RosterEntry = {
  rank: number
  tier: string
  region: ScanRegion
  gameName: string
  tagLine: string
  leaguePoints: number
  /** Share of this player's ranked games played on Irelia (0..1). */
  playRate: number
  games: number
  winRate: number
  kda: number
}

export const PRIORITY_OTPS: RosterEntry[] = [
  { rank: 1, tier: 'Master', region: 'KR', gameName: '우주최강 고양이', tagLine: '냥냥펀치', leaguePoints: 1185, playRate: 0.72, games: 389, winRate: 0.54, kda: 1.78 },
  { rank: 2, tier: 'Master', region: 'KR', gameName: '연 두', tagLine: '1128', leaguePoints: 1061, playRate: 0.75, games: 178, winRate: 0.55, kda: 1.68 },
  { rank: 3, tier: 'Master', region: 'KR', gameName: '이아연의 첫사랑', tagLine: '5333', leaguePoints: 844, playRate: 0.63, games: 350, winRate: 0.59, kda: 1.58 },
  { rank: 4, tier: 'Master', region: 'KR', gameName: '쫑경이의 몽둥이', tagLine: 'kr2', leaguePoints: 780, playRate: 0.76, games: 274, winRate: 0.54, kda: 1.76 },
  { rank: 5, tier: 'Master', region: 'KR', gameName: 'zxc', tagLine: '660', leaguePoints: 752, playRate: 0.76, games: 182, winRate: 0.64, kda: 2.14 },
  { rank: 6, tier: 'Master', region: 'KR', gameName: 'KuhnX', tagLine: 'KR2', leaguePoints: 533, playRate: 0.71, games: 251, winRate: 0.53, kda: 1.68 },
  { rank: 7, tier: 'Master', region: 'KR', gameName: '나를 소모하지 않는 태도', tagLine: 'KR2', leaguePoints: 525, playRate: 0.62, games: 356, winRate: 0.54, kda: 1.64 },
  { rank: 8, tier: 'Master', region: 'KR', gameName: '유밍니', tagLine: 'KR1', leaguePoints: 523, playRate: 0.78, games: 139, winRate: 0.61, kda: 1.99 },
  { rank: 9, tier: 'Master', region: 'KR', gameName: '무꾸르가세상을바꿈', tagLine: '무꾸르만세', leaguePoints: 508, playRate: 0.73, games: 358, winRate: 0.55, kda: 1.98 },
  { rank: 10, tier: 'Master', region: 'KR', gameName: 'Weetae', tagLine: 'KR2', leaguePoints: 480, playRate: 0.65, games: 415, winRate: 0.55, kda: 1.59 },
  { rank: 11, tier: 'Master', region: 'KR', gameName: 'IRELKING', tagLine: '0729', leaguePoints: 447, playRate: 0.73, games: 75, winRate: 0.76, kda: 3.08 },
  { rank: 12, tier: 'Master', region: 'KR', gameName: '12월 1일에 복귀', tagLine: '아마도', leaguePoints: 424, playRate: 0.72, games: 378, winRate: 0.58, kda: 1.82 },
]

const requestHistory = new Map<Routing, number[]>()
const lastRequestAt = new Map<Routing, number>()
const requestQueues = new Map<Routing, Promise<void>>()
const trackedRoutings: Routing[] = ['EUROPE', 'ASIA', 'KR', 'EUN1', 'AMERICAS', 'EUW1', 'NA1']
// The developer key allows 100 requests / 120s and 20 / 1s app-wide (verified
// from `X-App-Rate-Limit: 100:120,20:1`). We stay just under it and prefer the
// live headers when present.
const localRequestBudget = { perSecond: 19, perTwoMinutes: 95 }

/**
 * App-wide token bucket. Riot's app limit is keyed to the API key, not the
 * route, so scanning several regions at once can exceed it even when every
 * per-route bucket stays green. This single bucket is the binding constraint.
 */
const appRequestHistory: number[] = []
let appLastRequestAt = 0
let appBudget = { perSecond: 19, perTwoMinutes: 95 }

/**
 * Parses `X-App-Rate-Limit` / `X-Method-Rate-Limit` response headers and nudges
 * the bucket toward the real limits. Header format is "count:seconds,..." e.g.
 * "100:120,20:1". Missing or malformed headers leave the defaults intact.
 */
function recordRateLimits(headers: Headers) {
  for (const header of ['x-app-rate-limit', 'x-method-rate-limit']) {
    const value = headers.get(header)
    if (!value) continue
    let perSecond: number | null = null
    let perLong: number | null = null
    for (const part of value.split(',')) {
      const [countText, secondsText] = part.split(':')
      const count = Number(countText)
      const seconds = Number(secondsText)
      if (!Number.isFinite(count) || !Number.isFinite(seconds)) continue
      if (seconds <= 1) perSecond = count
      else perLong = count
    }
    if (header === 'x-app-rate-limit' && perSecond && perLong) {
      appBudget = { perSecond: perSecond - 1, perTwoMinutes: perLong - 5 }
    }
  }
}

/**
 * Callbacks fired when the token bucket forces a request to wait for the rate
 * window to refresh. Scans subscribe so the UI can show "waiting Ns, then
 * continuing automatically" instead of appearing to freeze.
 */
const rateWaitListeners = new Set<(waitMs: number) => void>()

/** Subscribe to rate-limit waits; returns an unsubscribe function. */
export function onRateLimitWait(listener: (waitMs: number) => void): () => void {
  rateWaitListeners.add(listener)
  return () => rateWaitListeners.delete(listener)
}

/** Reserves an app-wide slot; returns once the key has budget to spare. */
async function acquireGlobalSlot() {
  while (true) {
    const now = Date.now()
    while (appRequestHistory.length && now - appRequestHistory[0] >= 120_000) appRequestHistory.shift()
    const recentSecond = appRequestHistory.filter((time) => now - time < 1_000)
    const waits = [Math.max(0, appLastRequestAt + 60 - now)]

    if (recentSecond.length >= appBudget.perSecond) waits.push(recentSecond[0] + 1_000 - now)
    if (appRequestHistory.length >= appBudget.perTwoMinutes) waits.push(appRequestHistory[0] + 120_000 - now)

    const wait = Math.max(...waits)
    if (wait <= 0) {
      appRequestHistory.push(now)
      appLastRequestAt = now
      return
    }
    // The scan is not stopping: it parks here until the window refreshes. Tell
    // the UI rather than letting the progress line sit frozen.
    if (wait > 250) rateWaitListeners.forEach((listener) => listener(wait))
    await delay(wait)
  }
}

// The plugin stores its key here so the shared engine fetch adapter can resolve
// it lazily without threading the key through every helper signature.
let activeApiKey: string | undefined

const IRELIA_ID = 39

function getActiveApiKey() {
  if (!activeApiKey) {
    throw new ApiError('Add RIOT_API_KEY to the local .env.local file, then restart the dev server.', 503)
  }
  return activeApiKey
}

function getApiUsage() {
  const now = Date.now()
  const routes = Object.fromEntries(trackedRoutings.map((routing) => {
    const recent = (requestHistory.get(routing) ?? []).filter((time) => now - time < 120_000)
    requestHistory.set(routing, recent)
    return [routing, {
      lastSecond: recent.filter((time) => now - time < 1_000).length,
      lastTwoMinutes: recent.length,
    }]
  }))

  // The app-wide counter is the number that actually matters: the key is limited
  // across every route, so the total is what the "X of N" readout must show.
  const recentApp = appRequestHistory.filter((time) => now - time < 120_000)
  while (appRequestHistory.length && now - appRequestHistory[0] >= 120_000) appRequestHistory.shift()

  return {
    localBudget: { perSecond: appBudget.perSecond, perTwoMinutes: appBudget.perTwoMinutes },
    app: {
      lastSecond: recentApp.filter((time) => now - time < 1_000).length,
      lastTwoMinutes: recentApp.length,
    },
    routes,
    measuredAt: now,
  }
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/**
 * Reserves a request slot for a routing and returns a release callback. The
 * slot is held until the caller releases it (after the request settles), so two
 * concurrent scans on the same routing cannot both occupy the same slot.
 */
async function acquireRequestSlot(routing: Routing) {
  const previous = requestQueues.get(routing) ?? Promise.resolve()
  let release = () => {}
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  requestQueues.set(routing, previous.then(() => current))
  await previous

  while (true) {
    const now = Date.now()
    const recent = (requestHistory.get(routing) ?? []).filter((time) => now - time < 120_000)
    const recentSecond = recent.filter((time) => now - time < 1_000)
    const last = lastRequestAt.get(routing) ?? 0
    const waits = [Math.max(0, last + 75 - now)]

    if (recentSecond.length >= localRequestBudget.perSecond) {
      waits.push(recentSecond[0] + 1_000 - now)
    }
    if (recent.length >= localRequestBudget.perTwoMinutes) {
      waits.push(recent[0] + 120_000 - now)
    }

    const wait = Math.max(...waits)
    if (wait <= 0) {
      const timestamp = Date.now()
      recent.push(timestamp)
      requestHistory.set(routing, recent)
      lastRequestAt.set(routing, timestamp)
      return release
    }
    await delay(wait)
  }
}

async function riotGet<T>(apiKey: string, routing: Routing, endpoint: string): Promise<T> {
  // App-wide budget first, then the per-route slot, so a multi-region scan never
  // blows past the key's global limit even when each route is individually idle.
  await acquireGlobalSlot()
  const release = await acquireRequestSlot(routing)
  try {
    const response = await fetch(`https://${apiHosts[routing]}${endpoint}`, {
      headers: { 'X-Riot-Token': apiKey },
    })
    recordRateLimits(response.headers)

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('Retry-After') ?? 1)
      release()
      await delay(Math.min(Math.max(retryAfter, 1), 120) * 1_000)
      return riotGet<T>(apiKey, routing, endpoint)
    }
    if (!response.ok) {
      const apiFamily = endpoint.split('?')[0].split('/').filter(Boolean).slice(0, 3).join('/')
      const messages: Record<number, string> = {
        401: 'Riot rejected the API key. Check that the local key is current.',
        403: `Riot rejected the ${routing} request to ${apiFamily}. Check the endpoint path and key access.`,
        404: 'Riot did not find that account or match.',
      }
      throw new ApiError(messages[response.status] ?? `Riot API returned ${response.status}.`, response.status)
    }

    return (await response.json()) as T
  } finally {
    release()
  }
}

/** Adapter handed to the build engine so its cached fetches share our throttle. */
const fetchJson = <T>(routing: Routing, endpoint: string): Promise<T> =>
  riotGet<T>(getActiveApiKey(), routing, endpoint)

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.end(JSON.stringify(payload))
}

function requireApiKey(apiKey: string | undefined): string {
  if (!apiKey) {
    throw new ApiError('Add RIOT_API_KEY to the local .env.local file, then restart the dev server.', 503)
  }
  return apiKey
}

function getRegionalRouting(value: string | null): 'EUROPE' | 'ASIA' {
  if (value === 'EUROPE' || value === 'ASIA') return value
  throw new ApiError('Region must be EUROPE or ASIA.', 400)
}

function accountPath(gameName: string, tagLine: string) {
  if (!gameName.trim() || !tagLine.trim()) {
    throw new ApiError('Both gameName and tagLine are required.', 400)
  }
  return `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName.trim())}/${encodeURIComponent(tagLine.trim())}`
}

async function getAccount(apiKey: string, gameName: string, tagLine: string, routing: Routing) {
  return riotGet<{ puuid: string; gameName: string; tagLine: string }>(
    apiKey,
    routing,
    accountPath(gameName, tagLine),
  )
}

/* ------------------------------------------------------------------ *
 * Roster store: defaults plus summoners added in the app
 * ------------------------------------------------------------------ */

const CUSTOM_ROSTER_KEY = 'custom-roster'

type StoredRoster = { entries?: RosterEntry[]; savedAt?: number }

async function readCustomRoster(): Promise<RosterEntry[]> {
  try {
    const stored = await readCache<StoredRoster>('scans', CUSTOM_ROSTER_KEY)
    return Array.isArray(stored?.entries) ? stored.entries : []
  } catch {
    return []
  }
}

async function saveCustomRoster(entries: RosterEntry[]): Promise<void> {
  await writeCache('scans', CUSTOM_ROSTER_KEY, { entries, savedAt: Date.now() } satisfies StoredRoster)
}

/** The scan roster: curated defaults first, then anything added in the app. */
export async function loadRoster(): Promise<RosterEntry[]> {
  return [...PRIORITY_OTPS, ...(await readCustomRoster())]
}

const riotIdKey = (gameName: string, tagLine: string) => `${gameName}#${tagLine}`.toLowerCase()

/**
 * Resolve a Riot ID and append it to the stored roster. Returns the updated
 * list. Adding an account that is already tracked is a no-op rather than an
 * error, so a double click cannot create duplicates.
 */
export async function addRosterMember(gameName: string, tagLine: string): Promise<RosterEntry[]> {
  const routing = scanRegions.KR
  const account = await getAccount(getActiveApiKey(), gameName, tagLine, routing.regional)
  const custom = await readCustomRoster()
  const key = riotIdKey(account.gameName, account.tagLine)
  const known = [...PRIORITY_OTPS, ...custom].some((entry) => riotIdKey(entry.gameName, entry.tagLine) === key)
  if (!known) {
    // Their current solo-queue rank, so the new row shows something real.
    let tier = 'Unranked'
    let leaguePoints = 0
    try {
      const league = await riotGet<Array<{ queueType: string; tier: string; leaguePoints: number }>>(
        getActiveApiKey(),
        routing.platform,
        `/lol/league/v4/entries/by-puuid/${encodeURIComponent(account.puuid)}`,
      )
      const solo = league.find((entry) => entry.queueType === 'RANKED_SOLO_5x5')
      if (solo) {
        tier = solo.tier.charAt(0) + solo.tier.slice(1).toLowerCase()
        leaguePoints = solo.leaguePoints
      }
    } catch {
      // An unranked or fresh account still belongs on the roster.
    }
    custom.push({
      rank: PRIORITY_OTPS.length + custom.length + 1,
      tier,
      region: 'KR',
      gameName: account.gameName,
      tagLine: account.tagLine,
      leaguePoints,
      playRate: 0,
      games: 0,
      winRate: 0,
      kda: 0,
    })
    await saveCustomRoster(custom)
  }
  return loadRoster()
}

/** Remove a summoner that was added in the app. Curated defaults are kept. */
export async function removeRosterMember(riotId: string): Promise<RosterEntry[]> {
  const key = riotId.toLowerCase()
  const custom = await readCustomRoster()
  await saveCustomRoster(custom.filter((entry) => riotIdKey(entry.gameName, entry.tagLine) !== key))
  return loadRoster()
}

/* ------------------------------------------------------------------ *
 * Matchup coverage and coverage-driven deepening
 * ------------------------------------------------------------------ */

const SCAN_CANDIDATES_KEY = 'scan-candidates'

/**
 * Games a single matchup needs before its win rate is worth reading at all
 * (95% Wilson half-width is ±17.9% at n=30, ±9.8% at n=100). Deepening targets
 * this floor per matchup rather than the whole-pool total.
 */
const MATCHUP_TARGET_GAMES = 30

export type CoverageEntry = {
  opponentChampionId: number
  opponentName: string
  games: number
  covered: boolean
}

export type CoverageReport = {
  lane: OtpRole | null
  /** The patch the counts below are restricted to — the newest patch with data. */
  patch: string
  target: number
  matchups: CoverageEntry[]
  coveredCount: number
  totalCount: number
  /** Total extra games required before every matchup reaches the target. */
  gamesNeeded: number
}

/**
 * How many cached Irelia games exist per lane opponent, against a target.
 *
 * Counts only games on the newest patch with data. Coverage exists to drive
 * *current* build evidence, so counting stale patches would both overstate the
 * pool and invite the deepen walk to fill the target with ancient games.
 */
export async function computeCoverage(lane: OtpRole | null, target: number): Promise<CoverageReport> {
  const matches = await loadCacheWideIreliaMatches()
  const patch = mostRecentPatch(matches)
  const scoped = matches.filter((match) =>
    (!patch || match.patch === patch)
    && (lane === null || match.position === lane),
  )
  const counts = new Map<number, number>()
  scoped.forEach((match) => {
    if (!match.opponentChampionId) return
    counts.set(match.opponentChampionId, (counts.get(match.opponentChampionId) ?? 0) + 1)
  })

  const staticData = await getStaticData()
  const names = new Map(staticData.champions.map((champion) => [champion.id, champion.name]))
  const matchups = [...counts.entries()]
    .map(([opponentChampionId, games]) => ({
      opponentChampionId,
      opponentName: names.get(opponentChampionId) ?? `#${opponentChampionId}`,
      games,
      covered: games >= target,
    }))
    .sort((a, b) => a.games - b.games || a.opponentName.localeCompare(b.opponentName))

  return {
    lane,
    patch,
    target,
    matchups,
    coveredCount: matchups.filter((entry) => entry.covered).length,
    totalCount: matchups.length,
    gamesNeeded: matchups.reduce((total, entry) => total + Math.max(0, target - entry.games), 0),
  }
}

type StoredCandidates = {
  candidates?: Array<{ puuid: string; region: ScanRegion }>
  savedAt?: number
  /** Deepest history page (of `pageSize`) already walked; deepening resumes here. */
  pageOffset?: number
}

export type DeepenResult = {
  coverage: CoverageReport
  requestsUsed: number
  matchesAdded: number
  pagesWalked: number
  /** Why it stopped: all-covered | budget | history-exhausted. */
  stopReason: string
  candidates: number
}

export type OpponentHarvestResult = {
  opponentChampionId: number
  lane: OtpRole | null
  matchesAdded: number
  requestsUsed: number
  gamesNow: number
  target: number
  stopReason: string
}

/**
 * Harvest a specific matchup from the *opponent's* side.
 *
 * Rare matchups stall because the Irelia candidates run out of relevant
 * history. The opponent mains have the reverse problem solved for us: a Zed
 * main plays Zed in most of their games, so their history is dense with
 * Zed-vs-everyone matches. Walking *their* recent games and keeping the ones
 * where Irelia faces them in the same lane finds the matchup at a far higher
 * rate than walking Irelia mains. Each kept match is stored from the Irelia
 * participant's perspective, so it feeds the normal analysis unchanged.
 */
export async function deepenOpponent(
  opponentChampionId: number,
  lane: OtpRole | null,
  target: number,
  report: ProgressReporter,
  options: { maxRequests?: number; pageSize?: number; maxMains?: number } = {},
): Promise<OpponentHarvestResult> {
  const maxRequests = options.maxRequests ?? 400
  const pageSize = Math.min(Math.max(options.pageSize ?? 100, 1), 100)
  const maxMains = options.maxMains ?? 30

  const staticData = await getStaticData()
  const opponentName = staticData.champions.find((champion) => champion.id === opponentChampionId)?.name ?? `#${opponentChampionId}`
  const coverage = await computeCoverage(lane, target)
  const current = coverage.matchups.find((entry) => entry.opponentChampionId === opponentChampionId)?.games ?? 0
  let need = Math.max(0, target - current)
  if (need === 0) {
    return { opponentChampionId, lane, matchesAdded: 0, requestsUsed: 0, gamesNow: current, target, stopReason: 'already-covered' }
  }

  report({ phase: 'ladder', message: `Screening the KR ladder for ${opponentName} mains…`, done: 0, total: 0 })
  const routing = scanRegions.KR
  const mains: string[] = []
  let requestsUsed = 0
  for (const tierPath of [leaguePaths.challenger, leaguePaths.grandmaster, leaguePaths.master]) {
    if (mains.length >= maxMains || requestsUsed >= maxRequests) break
    const league = await riotGet<{ entries: Array<{ puuid: string; leaguePoints: number }> }>(getActiveApiKey(), routing.platform, tierPath)
    requestsUsed += 1
    const entries = [...league.entries].sort((a, b) => b.leaguePoints - a.leaguePoints).slice(0, 80)
    for (const entry of entries) {
      if (mains.length >= maxMains || requestsUsed >= maxRequests) break
      const masteries = await riotGet<Array<{ championId: number }>>(
        getActiveApiKey(),
        routing.platform,
        `/lol/champion-mastery/v4/champion-masteries/by-puuid/${encodeURIComponent(entry.puuid)}?count=10`,
      )
      requestsUsed += 1
      if (masteries.slice(0, 3).some((mastery) => mastery.championId === opponentChampionId)) {
        mains.push(entry.puuid)
      }
    }
  }
  report({ phase: 'ladder', message: `${mains.length} ${opponentName} mains found — walking their recent games`, done: 1, total: 1 })

  let matchesAdded = 0
  let stopReason = 'history-exhausted'

  // Walk order matters: the freshest games — the ones most likely to be on the
  // patch coverage is measuring — are page 0 of EVERY main. Walking one main's
  // whole history before the next main's first page spends the budget on
  // stale-patch bodies that the patch guard then rejects.
  outer:
  for (let page = 0; page < 5; page += 1) {
    for (const puuid of mains) {
      if (requestsUsed >= maxRequests) { stopReason = 'budget'; break outer }
      const ids = await riotGet<string[]>(
        getActiveApiKey(),
        routing.regional,
        `/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?queue=420&count=${pageSize}&start=${page * pageSize}`,
      )
      requestsUsed += 1
      if (!ids.length) continue

      for (const matchId of ids) {
        if (requestsUsed >= maxRequests) { stopReason = 'budget'; break outer }
        if (await readCache<MatchRecord>('matches', matchId)) continue

        const match = await getCachedMatch(fetchJson, matchId, routing.regional)
        requestsUsed += 1
        if (match.info.queueId !== 420) continue

        const irelia = match.info.participants.find((entry) => entry.championId === IRELIA_ID)
        if (!irelia) continue
        const ireliaPosition = getPlayerPosition(irelia)
        if (lane && ireliaPosition !== lane) continue
        // Patch guard: same rule as deepenMatchups — only games on the patch
        // coverage is measuring may count toward the target.
        if (coverage.patch && String(match.info.gameVersion ?? '').split('.').slice(0, 2).join('.') !== coverage.patch) continue
        const faced = match.info.participants.find((entry) => entry.championId === opponentChampionId && getPlayerPosition(entry) === ireliaPosition)
        if (!faced) continue

        // Store from Irelia's perspective so the normal analysis consumes it.
        const data = await buildMatchData(fetchJson, match, irelia.puuid, { withTimeline: true, routing: routing.regional })
        requestsUsed += 1
        if (!data) continue

        matchesAdded += 1
        need -= 1
        report({
          phase: 'deepen',
          message: `${matchesAdded} ${opponentName} games added · ${Math.max(need, 0)} to go`,
          done: Math.min(matchesAdded, target - current),
          total: target - current,
        })
        if (need <= 0) { stopReason = 'target-reached'; break outer }
      }
    }
  }

  const after = await computeCoverage(lane, target)
  return {
    opponentChampionId,
    lane,
    matchesAdded,
    requestsUsed,
    gamesNow: after.matchups.find((entry) => entry.opponentChampionId === opponentChampionId)?.games ?? current,
    target,
    stopReason,
  }
}

/**
 * Coverage-driven deepening.
 *
 * A normal scan pulls each candidate's most recent 40 solo-queue games once.
 * That covers the common matchups and leaves rare ones at a handful of games.
 * This instead walks *backward* through the same candidates using the `start`
 * offset — with no time window at all — pulling older and older games until
 * every matchup in the lane reaches the target, the history runs out, or the
 * request budget is spent. Progress is reported per matchup so the extension is
 * visible rather than implied.
 */
export async function deepenMatchups(
  lane: OtpRole | null,
  target: number,
  report: ProgressReporter,
  options: { maxPages?: number; pageSize?: number; maxRequests?: number } = {},
): Promise<DeepenResult> {
  const maxPages = options.maxPages ?? 6
  const pageSize = Math.min(Math.max(options.pageSize ?? 100, 1), 100)
  const maxRequests = options.maxRequests ?? 400

  report({ phase: 'coverage', message: 'Measuring matchup coverage…', done: 0, total: 0 })
  let coverage = await computeCoverage(lane, target)

  const unsubscribeRate = onRateLimitWait((waitMs) => {
    report({
      phase: 'ratelimit',
      message: `Rate limit reached — waiting ${Math.ceil(waitMs / 1_000)}s for the window to refresh, then continuing automatically`,
      done: 0,
      total: 0,
    })
  })

  // Games still required per thin matchup.
  const need = new Map<number, number>()
  coverage.matchups.forEach((entry) => {
    if (!entry.covered) need.set(entry.opponentChampionId, target - entry.games)
  })
  const initialNeeded = [...need.values()].reduce((total, value) => total + value, 0)
  if (!need.size) {
    unsubscribeRate()
    return { coverage, requestsUsed: 0, matchesAdded: 0, pagesWalked: 0, stopReason: 'already-covered', candidates: 0 }
  }

  // Prefer the candidates the last scan actually used; fall back to the roster.
  const stored = await readCache<StoredCandidates>('scans', SCAN_CANDIDATES_KEY)
  const resolved: Array<{ puuid: string; region: ScanRegion }> = []

  if (stored?.candidates?.length) {
    stored.candidates.forEach((candidate) => resolved.push({ puuid: candidate.puuid, region: candidate.region }))
  } else {
    for (const entry of await loadRoster()) {
      try {
        const routing = scanRegions[entry.region]
        const account = await getAccount(getActiveApiKey(), entry.gameName, entry.tagLine, routing.regional)
        if (account?.puuid) resolved.push({ puuid: account.puuid, region: entry.region })
      } catch {
        // A renamed account must not abort the whole walk.
      }
    }
  }

  let requestsUsed = 0
  let matchesAdded = 0
  let pagesWalked = 0
  let stopReason = 'history-exhausted'

  // Candidate expansion: a handful of accounts (e.g. only the curated roster)
  // means the walk exhausts its recent history almost immediately, and recent
  // history is where thin matchups like Zed actually live. Fresh ladder accounts
  // are screened exactly like a scan — Irelia among the top-3 masteries — and
  // appended so their recent games can be harvested.
  let expandedNewCandidates = false
  if (resolved.length < 25) {
    report({ phase: 'ladder', message: 'Candidate pool small — screening fresh KR master accounts…', done: 0, total: 0 })
    try {
      const routing = scanRegions.KR
      const league = await riotGet<{ entries: Array<{ puuid: string; leaguePoints: number }> }>(
        getActiveApiKey(),
        routing.platform,
        leaguePaths.master,
      )
      requestsUsed += 1
      const known = new Set(resolved.map((candidate) => candidate.puuid))
      const fresh = [...league.entries].sort((a, b) => b.leaguePoints - a.leaguePoints).slice(0, 60)
      for (const entry of fresh) {
        if (known.has(entry.puuid)) continue
        const masteries = await riotGet<Array<{ championId: number }>>(
          getActiveApiKey(),
          routing.platform,
          `/lol/champion-mastery/v4/champion-masteries/by-puuid/${encodeURIComponent(entry.puuid)}?count=10`,
        )
        requestsUsed += 1
        const ireliaRank = masteries.map((mastery) => mastery.championId).indexOf(IRELIA_ID)
        if (ireliaRank >= 0 && ireliaRank < 3) {
          resolved.push({ puuid: entry.puuid, region: 'KR' })
          known.add(entry.puuid)
          expandedNewCandidates = true
        }
      }
      report({ phase: 'ladder', message: `${resolved.length} candidates after expansion`, done: 1, total: 1 })
    } catch (error) {
      // A missing ladder must not abort the walk.
      if (!(error instanceof ApiError)) throw error
    }
  }

  // Resume where the previous pass left off. Newly expanded candidates have not
  // been walked at all, so a persisted offset would skip their recent games —
  // reset it and let everyone walk from the top.
  const startPage = stored?.pageOffset && !expandedNewCandidates ? stored.pageOffset : 0
  let deepestPageStarted = startPage

  const stillNeeded = () => [...need.values()].reduce((total, value) => total + value, 0)

  outer:
  for (const candidate of resolved) {
    const routing = scanRegions[candidate.region]
    for (let page = startPage; page < startPage + maxPages; page += 1) {
      deepestPageStarted = Math.max(deepestPageStarted, page)
      if (requestsUsed >= maxRequests) { stopReason = 'budget'; break outer }

      const ids = await riotGet<string[]>(
        getActiveApiKey(),
        routing.regional,
        `/lol/match/v5/matches/by-puuid/${encodeURIComponent(candidate.puuid)}/ids?queue=420&count=${pageSize}&start=${page * pageSize}`,
      )
      requestsUsed += 1
      pagesWalked += 1
      // An empty page means this candidate has no deeper history to walk.
      if (!ids.length) break

      for (const matchId of ids) {
        if (requestsUsed >= maxRequests) { stopReason = 'budget'; break outer }
        // Already harvested: the matchup counts already include it.
        if (await readCache<MatchRecord>('matches', matchId)) continue

        const match = await getCachedMatch(fetchJson, matchId, routing.regional)
        requestsUsed += 1
        if (match.info.queueId !== 420) continue

        const player = match.info.participants.find((entry) => entry.puuid === candidate.puuid)
        if (!player || player.championId !== IRELIA_ID) continue
        const position = getPlayerPosition(player)
        if (lane && position !== lane) continue
        // Patch guard: coverage only measures the newest patch with data, so a
        // stale-patch game must not fill its target. Skipping it here keeps the
        // walk from re-polluting a clean cache with ancient evidence.
        if (coverage.patch && String(match.info.gameVersion ?? '').split('.').slice(0, 2).join('.') !== coverage.patch) continue

        const opponent = match.info.participants.find((entry) => entry.puuid !== candidate.puuid && getPlayerPosition(entry) === position)
        const opponentChampionId = opponent?.championId
        // Only keep games that actually advance a thin matchup.
        if (!opponentChampionId || !need.has(opponentChampionId)) continue

        const data = await buildMatchData(fetchJson, match, candidate.puuid, { withTimeline: true, routing: routing.regional })
        requestsUsed += 1
        if (!data) continue

        matchesAdded += 1
        const remaining = (need.get(opponentChampionId) ?? 0) - 1
        if (remaining <= 0) need.delete(opponentChampionId)
        else need.set(opponentChampionId, remaining)

        report({
          phase: 'deepen',
          message: `${matchesAdded} older games added · ${need.size} matchups still short · ${stillNeeded()} games to go`,
          done: Math.max(0, initialNeeded - stillNeeded()),
          total: initialNeeded,
        })

        if (!need.size) { stopReason = 'all-covered'; break outer }
      }
    }
  }

  coverage = await computeCoverage(lane, target)
  if (!need.size) stopReason = 'all-covered'
  else if (requestsUsed >= maxRequests) stopReason = 'budget'

  // Persist the resume point so the next pass continues deeper instead of
  // re-walking the cached window. A finished pass resets it to re-check recency.
  await writeCache('scans', SCAN_CANDIDATES_KEY, {
    candidates: resolved.map((candidate) => ({ puuid: candidate.puuid, region: candidate.region })),
    pageOffset: stopReason === 'budget' ? deepestPageStarted : 0,
    savedAt: Date.now(),
  } satisfies StoredCandidates)

  unsubscribeRate()
  return { coverage, requestsUsed, matchesAdded, pagesWalked, stopReason, candidates: resolved.length }
}

/* ------------------------------------------------------------------ *
 * OTP of choice: deep, patch-bounded harvest + consensus comparison
 * ------------------------------------------------------------------ */

/**
 * How strongly the OTP's agreement boosts an item's best-in-slot score. 0.5
 * means an item the OTP always takes scores 1.5x its aggregate share — enough
 * to settle close calls, never enough to crown a 5% item over a 60% one.
 */
const OTP_AGREEMENT_BOOST = 0.5

export type OtpProfile = {
  riotId: string
  puuid: string
  region: ScanRegion
  harvestedAt: number
  /** The patch the walk was scoped to; only games on it are kept. */
  patch: string
  /** Every on-patch ranked game of this player (Irelia and other champions). */
  matchIds: string[]
  /** Subset of matchIds where the player was on Irelia. */
  ireliaMatchIds: string[]
  games: number
  ireliaGames: number
}

export type OtpHarvestResult = OtpProfile & {
  pagesWalked: number
  requestsUsed: number
  matchesAdded: number
  stopReason: 'patch-boundary' | 'budget' | 'max-pages' | 'no-games'
}

/**
 * Walks one player's ranked history backward, page by page (100 games each),
 * and stops at the first page with zero games on the current patch. That page
 * IS the patch boundary: anything beyond it is last patch's meta, which can no
 * longer be trusted for a current build recommendation.
 */
export async function harvestPlayer(
  gameName: string,
  tagLine: string,
  region: ScanRegion,
  report: ProgressReporter,
  options: { maxRequests?: number; maxPages?: number } = {},
): Promise<OtpHarvestResult> {
  const maxRequests = options.maxRequests ?? 800
  const maxPages = options.maxPages ?? 15
  const routing = scanRegions[region]
  const account = await getAccount(getActiveApiKey(), gameName.trim(), tagLine.trim(), routing.regional)
  if (!account?.puuid) throw new ApiError('Riot could not resolve that Riot ID.', 404)
  const riotId = `${gameName.trim()}#${tagLine.trim()}`

  // Scope to the newest patch the cache already measures. When the cache is
  // empty the patch is derived from the first fetched page instead.
  const cached = await loadCacheWideIreliaMatches()
  let patch = mostRecentPatch(cached)

  let requestsUsed = 0
  let matchesAdded = 0
  let pagesWalked = 0
  let games = 0
  let ireliaGames = 0
  const matchIds: string[] = []
  const ireliaMatchIds: string[] = []
  let stopReason: OtpHarvestResult['stopReason'] = 'patch-boundary'

  report({
    phase: 'otp',
    message: `Resolved ${riotId} — walking ranked history back through patch ${patch || 'current'}…`,
    done: 0,
    total: 0,
  })

  for (let page = 0; page < maxPages; page += 1) {
    if (requestsUsed >= maxRequests) { stopReason = 'budget'; break }
    const ids = await riotGet<string[]>(
      getActiveApiKey(),
      routing.regional,
      `/lol/match/v5/matches/by-puuid/${encodeURIComponent(account.puuid)}/ids?queue=420&count=100&start=${page * 100}`,
    )
    requestsUsed += 1
    pagesWalked += 1
    if (!ids.length) break

    let pageOnPatch = 0
    for (const matchId of ids) {
      if (requestsUsed >= maxRequests) { stopReason = 'budget'; break }
      const wasCached = await hasCache('matches', matchId)
      const match = await getCachedMatchForPlayer(fetchJson, matchId, account.puuid, routing.regional)
      if (!wasCached) {
        requestsUsed += 1
        matchesAdded += 1
      }

      const bodyPatch = String(match.info.gameVersion ?? '').split('.').slice(0, 2).join('.')
      if (!patch) patch = bodyPatch
      if (bodyPatch !== patch) continue

      pageOnPatch += 1
      games += 1
      matchIds.push(matchId)
      const player = match.info.participants.find((entry) => entry.puuid === account.puuid)
      if (player?.championId === IRELIA_ID) {
        ireliaGames += 1
        ireliaMatchIds.push(matchId)
        await getCachedTimeline(fetchJson, matchId, routing.regional)
      }
      report({
        phase: 'otp',
        message: `${games} games on patch ${patch} · ${ireliaGames} on Irelia`,
        done: games,
        total: 0,
      })
    }
    if (pageOnPatch === 0) break
  }

  if (!games) stopReason = 'no-games'
  if (pagesWalked >= maxPages && stopReason === 'patch-boundary') stopReason = 'max-pages'

  const profile: OtpProfile = {
    riotId,
    puuid: account.puuid,
    region,
    harvestedAt: Date.now(),
    patch,
    matchIds,
    ireliaMatchIds,
    games,
    ireliaGames,
  }
  await writeCache('otp', account.puuid, profile)
  await writeCache('otp', 'active', { puuid: account.puuid, riotId, savedAt: Date.now() })

  return { ...profile, pagesWalked, requestsUsed, matchesAdded, stopReason }
}

/** Rebuilds one player's cached Irelia games into build data, offline. */
async function buildDataForPlayer(matchIds: string[], puuid: string, lane: OtpRole): Promise<MatchBuildData[]> {
  const out: MatchBuildData[] = []
  for (const id of matchIds) {
    const record = await readCache<MatchRecord>('matches', id)
    if (!record || record.info?.queueId !== 420) continue
    const player = record.info.participants.find((entry) => entry.puuid === puuid)
    if (!player || player.championId !== IRELIA_ID) continue
    if (getPlayerPosition(player) !== lane) continue
    const data = await buildMatchData(
      // Offline adapter: timelines come from the disk cache only.
      () => Promise.reject(new Error('offline')),
      record,
      puuid,
      { withTimeline: true },
    )
    if (data) out.push(data)
  }
  return out
}

export type OtpSlotOption = {
  id: number
  games: number
  share: number
  winRate: number
  /** How often the OTP takes this item in this slot (0..1). */
  otpRate: number
  agreement: boolean
  /** share * (1 + boost * otpRate): agreement settles close calls. */
  score: number
}

export type OtpCompare = {
  patch: string
  lane: OtpRole
  otp: {
    riotId: string
    games: number
    winRate: number
    profile: BuildProfile
    byOpponent: Record<string, BuildProfile>
  }
  baseline: {
    games: number
    winRate: number
    profile: BuildProfile
    byOpponent: Record<string, BuildProfile>
  }
  previous: {
    riotId: string
    patch: string
    harvestedAt: number
    ireliaGames: number
    profile: BuildProfile
  } | null
  slots: Array<{ slot: number; bestId: number | null; options: OtpSlotOption[] }>
}

/** The active OTP's build vs everyone else's, with consensus-scored slots. */
export async function compareOtpToBaseline(lane: OtpRole): Promise<OtpCompare> {
  const active = await readCache<{ puuid: string; riotId: string; savedAt: number }>('otp', 'active')
  if (!active) throw new ApiError('No OTP of choice sourced yet — add one on the Data page.', 404)
  const profile = await readCache<OtpProfile>('otp', active.puuid)
  if (!profile) throw new ApiError('The active OTP profile is missing — source it again.', 404)

  const otpMatches = await buildDataForPlayer(profile.ireliaMatchIds, profile.puuid, lane)

  // Everyone else: the whole cache-wide pool minus the OTP's own games. His
  // harvest covers page 0 onward, which includes his scan-window games, so
  // excluding these ids removes essentially all of his evidence.
  const exclude = new Set(profile.ireliaMatchIds)
  const baselineMatches = (await loadCacheWideIreliaMatches())
    .filter((match) => !exclude.has(match.matchId) && (!match.position || match.position === lane || match.position === 'UNKNOWN'))

  const otpProfile = aggregateProfile(otpMatches, 'lane')
  const baselineProfile = aggregateProfile(baselineMatches, 'lane')

  const groupByOpponent = (matches: MatchBuildData[]) => {
    const groups = new Map<number, MatchBuildData[]>()
    for (const match of matches) {
      if (match.opponentChampionId == null) continue
      const group = groups.get(match.opponentChampionId) ?? []
      group.push(match)
      groups.set(match.opponentChampionId, group)
    }
    const byOpponent: Record<string, BuildProfile> = {}
    groups.forEach((group, opponentId) => { byOpponent[String(opponentId)] = aggregateProfile(group, 'lane') })
    return byOpponent
  }

  // Previous OTP, when one was replaced: the "stack data over time" archive.
  let previous: OtpCompare['previous'] = null
  const keys = (await listCacheKeys('otp')).filter((key) => key !== 'active' && key !== active.puuid)
  if (keys.length) {
    const prior = await readCache<OtpProfile>('otp', keys.sort().pop() as string)
    if (prior) {
      const priorMatches = await buildDataForPlayer(prior.ireliaMatchIds, prior.puuid, lane)
      previous = {
        riotId: prior.riotId,
        patch: prior.patch,
        harvestedAt: prior.harvestedAt,
        ireliaGames: prior.ireliaGames,
        profile: aggregateProfile(priorMatches, 'lane'),
      }
    }
  }

  // Consensus scoring: aggregate options, boosted where the OTP converges.
  const otpSlotShares = new Map<number, Map<number, number>>()
  for (const slot of otpProfile.slots ?? []) {
    const shares = new Map<number, number>()
    for (const option of slot.options) shares.set(option.id, option.share)
    otpSlotShares.set(slot.slot, shares)
  }
  const slots = (baselineProfile.slots ?? []).map((slot) => {
    const otpShares = otpSlotShares.get(slot.slot) ?? new Map<number, number>()
    const options: OtpSlotOption[] = slot.options
      .map((option) => {
        const otpRate = otpShares.get(option.id) ?? 0
        return {
          id: option.id,
          games: option.games,
          share: option.share,
          winRate: option.winRate,
          otpRate,
          agreement: otpRate > 0,
          score: option.share * (1 + OTP_AGREEMENT_BOOST * otpRate),
        }
      })
      .sort((a, b) => b.score - a.score)
    return { slot: slot.slot, bestId: options[0]?.id ?? null, options }
  })

  return {
    patch: profile.patch,
    lane,
    otp: {
      riotId: profile.riotId,
      games: otpMatches.length,
      winRate: otpMatches.length ? otpMatches.filter((match) => match.win).length / otpMatches.length : 0,
      profile: otpProfile,
      byOpponent: groupByOpponent(otpMatches),
    },
    baseline: {
      games: baselineMatches.length,
      winRate: baselineMatches.length ? baselineMatches.filter((match) => match.win).length / baselineMatches.length : 0,
      profile: baselineProfile,
      byOpponent: groupByOpponent(baselineMatches),
    },
    previous,
    slots,
  }
}

/* ------------------------------------------------------------------ *
 * Storage cap and quality pruning
 * ------------------------------------------------------------------ */

/** The user-set ceiling: pruning only runs once the cache grows past this. */
const CACHE_SOFT_LIMIT_BYTES = 100 * 1024 * 1024 * 1024 // 100 GB

function patchNumber(version: string | undefined) {
  if (!version) return 0
  const parts = version.split('.').slice(0, 2).map(Number)
  return parts.length === 2 && parts.every((value) => Number.isFinite(value)) ? parts[0] * 100 + parts[1] : 0
}

function formatBytes(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/**
 * Ranks cached matches by how much of them is worth keeping, worst first:
 *  1. non-Irelia matches (only Irelia games feed the analysis),
 *  2. older patches (an old meta is less trustworthy for a current build),
 *  3. very short games (remakes/surrenders carry little signal),
 *  4. matchups already past their coverage target (surplus games are the least
 *     valuable marginal data).
 */
async function rankCacheQuality(): Promise<string[]> {
  const keys = await listCacheKeys('matches')
  const records: Array<{ key: string; record: MatchRecord }> = []
  for (const key of keys) {
    const record = await readCache<MatchRecord>('matches', key)
    if (record) records.push({ key, record })
  }
  if (!records.length) return []

  const maxPatch = Math.max(0, ...records.map(({ record }) => patchNumber(record.info?.gameVersion)))

  // Per-matchup game counts among the Irelia matches, so surplus coverage can
  // be deprioritised without losing the thin matchups.
  const opponentCounts = new Map<number, number>()
  records.forEach(({ record }) => {
    const player = record.info?.participants?.find((entry) => entry.championId === IRELIA_ID)
    if (!player) return
    const position = getPlayerPosition(player)
    const opponent = record.info.participants.find((entry) => entry.championId !== IRELIA_ID && getPlayerPosition(entry) === position)
    if (opponent) opponentCounts.set(opponent.championId, (opponentCounts.get(opponent.championId) ?? 0) + 1)
  })

  const scored = records.map(({ key, record }) => {
    const player = record.info?.participants?.find((entry) => entry.championId === IRELIA_ID)
    let score = 0
    if (!player) {
      score -= 10_000 // Non-Irelia matches go first; they never feed the analysis.
    } else {
      score -= Math.min(maxPatch - patchNumber(record.info?.gameVersion), 10) * 4
      const duration = record.info?.gameDuration ?? 0
      if (duration > 0 && duration < 15 * 60) score -= 6
      else if (duration > 0 && duration < 20 * 60) score -= 2
      const position = getPlayerPosition(player)
      const opponent = record.info.participants.find((entry) => entry.championId !== IRELIA_ID && getPlayerPosition(entry) === position)
      const surplus = Math.max(0, (opponent ? (opponentCounts.get(opponent.championId) ?? 0) : 0) - MATCHUP_TARGET_GAMES)
      score -= surplus
    }
    return { key, score }
  })

  return scored.sort((a, b) => a.score - b.score || a.key.localeCompare(b.key)).map((entry) => entry.key)
}

export type PruneResult = {
  beforeBytes: number
  afterBytes: number
  removedMatches: number
  freedBytes: number
  underBytes: number
  note: string
}

/** Deletes the lowest-quality matches until the cache fits under the cap. */
export async function pruneLowQuality(underBytes: number, report?: (message: string) => void): Promise<PruneResult> {
  const before = await cacheSize()
  if (before.total <= underBytes) {
    return { beforeBytes: before.total, afterBytes: before.total, removedMatches: 0, freedBytes: 0, underBytes, note: 'Cache is already under the cap — nothing pruned.' }
  }

  report?.(`Cache is ${formatBytes(before.total)} against a ${formatBytes(underBytes)} cap — ranking by quality…`)
  const ranked = await rankCacheQuality()

  let freed = 0
  let removed = 0
  for (const key of ranked) {
    if (before.total - freed <= underBytes) break
    freed += await deleteCache('matches', key)
    freed += await deleteCache('timelines', key)
    removed += 1
  }

  // Derived indexes reference deleted files; drop them so they rebuild from
  // whatever survived the prune.
  await deleteCache('scans', 'irelia-index')
  await deleteCache('scans', 'ban-index')

  const after = await cacheSize()
  report?.(`Removed ${removed} lowest-quality matches (${formatBytes(freed)}) — ${formatBytes(after.total)} remains.`)
  return {
    beforeBytes: before.total,
    afterBytes: after.total,
    removedMatches: removed,
    freedBytes: freed,
    underBytes,
    note: 'Kept recent patches, Irelia games and thin matchups; pruned the rest.',
  }
}

/* ------------------------------------------------------------------ *
 * Player baseline
 * ------------------------------------------------------------------ */

type PlayerMatchSummary = MatchBuildData & {
  champion: string
  opponent: string | null
  allies: Array<{ id: number; name: string }>
  enemies: Array<{ id: number; name: string }>
}

async function summarizeParticipant(
  match: MatchRecord,
  puuid: string,
  withTimeline: boolean,
  routing: Routing,
): Promise<PlayerMatchSummary | null> {
  const data = await buildMatchData(fetchJson, match, puuid, { withTimeline, routing })
  if (!data) return null
  const participant = match.info.participants.find((entry) => entry.puuid === puuid)
  const position = participant ? getPlayerPosition(participant) : 'UNKNOWN'
  const opponent = participant
    ? match.info.participants.find(
      (entry) => entry.teamId !== participant.teamId && getPlayerPosition(entry) === position,
    )
    : undefined

  return {
    ...data,
    champion: participant?.championName ?? 'Unknown',
    opponent: opponent?.championName ?? null,
    allies: match.info.participants
      .filter((entry) => entry.teamId === participant?.teamId && entry.puuid !== puuid)
      .map((entry) => ({ id: entry.championId, name: entry.championName })),
    enemies: match.info.participants
      .filter((entry) => entry.teamId !== participant?.teamId)
      .map((entry) => ({ id: entry.championId, name: entry.championName })),
  }
}

async function getPlayerReport(puuid: string, routing: 'EUROPE' | 'ASIA', count: number, withTimeline: boolean) {
  const matchIds = await riotGet<string[]>(
    getActiveApiKey(),
    routing,
    `/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?queue=420&count=${count}`,
  )
  const summaries: PlayerMatchSummary[] = []
  for (const matchId of matchIds) {
    const match = await getCachedMatch(fetchJson, matchId, routing)
    if (match.info.queueId !== 420) continue
    const summary = await summarizeParticipant(match, puuid, withTimeline, routing)
    if (summary) summaries.push(summary)
  }
  summaries.sort((a, b) => b.gameCreation - a.gameCreation)
  return summaries
}

/* ------------------------------------------------------------------ *
 * Regional ladder scan (KR + EUW + EUNE + NA)
 * ------------------------------------------------------------------ */

const tierPriority: Record<Exclude<OtpTier, 'all'>, number> = { challenger: 3, grandmaster: 2, master: 1, emerald: 0 }
/** Tiers with a dedicated apex-league endpoint; emerald has none (see below). */
type ApexTier = Exclude<OtpTier, 'all' | 'emerald'>
const leaguePaths: Record<ApexTier, string> = {
  challenger: '/lol/league/v4/challengerleagues/by-queue/RANKED_SOLO_5x5',
  grandmaster: '/lol/league/v4/grandmasterleagues/by-queue/RANKED_SOLO_5x5',
  master: '/lol/league/v4/masterleagues/by-queue/RANKED_SOLO_5x5',
}

type Candidate = {
  puuid: string
  region: ScanRegion
  routing: { platform: Routing; regional: Routing }
  tier: Exclude<OtpTier, 'all'>
  leaguePoints: number
  masteryPoints: number
  masteryRank: number
}

export type ScannedRole = {
  role: EngineOtpRole
  rankedGames: number
  ireliaGames: number
  ireliaShare: number
  winRate: number
  isOtp: boolean
}

export type ScannedCandidate = {
  name: string
  region: ScanRegion
  tier: Exclude<OtpTier, 'all'>
  leaguePoints: number
  ireliaMasteryPoints: number
  ireliaMasteryRank: number
  rankedSample: number
  ireliaGames: number
  ireliaShare: number
  winRate: number
  isOtp: boolean
  otpRole: EngineOtpRole | null
  otpRoles: EngineOtpRole[]
  roles: ScannedRole[]
  matches: MatchBuildData[]
  byOpponent: Record<string, BuildProfile>
}

export type ScanResult = {
  scannedAt: number
  tier: OtpTier
  lane: OtpRole | null
  regions: ScanRegion[]
  threshold: number
  minIreliaGames: number
  candidatePoolSize: number
  masteryCandidates: number
  deepenedCandidates: number
  cacheHits: number
  /** Matches downloaded that were not already cached — 0 means nothing new. */
  newGames: number
  analyzed: ScannedCandidate[]
  note: string
}

/**
 * In-process memo of the last-scanned snapshot, keyed by the snapshot file's
 * mtime. The builder script runs in its own process and rewrites the snapshot
 * on disk, so a server that memoised the value forever would keep serving a
 * stale scan until restarted. The mtime key makes the next request after a
 * rebuild serve the new snapshot while skipping the (multi-megabyte) disk read
 * in between.
 */
const scanSnapshotMemo = new Map<string, { mtime: number; value: ScanResult }>()

async function getStoredScan(): Promise<ScanResult | null> {
  const pointer = await readCache<{ key: string; scannedAt: number }>('scans', 'latest')
  if (!pointer) return null
  const mtime = (await cacheEntryMtime('scans', pointer.key)) ?? 0
  const memo = scanSnapshotMemo.get(pointer.key)
  if (memo && memo.mtime === mtime) return memo.value
  const stored = await readCache<ScanResult>('scans', pointer.key)
  if (stored) scanSnapshotMemo.set(pointer.key, { mtime, value: stored })
  return stored
}

function scanCacheKey(tier: OtpTier, lane: OtpRole | null, regions: ScanRegion[]) {
  return `${regions.join('+')}:${tier}:${lane ?? 'ALL'}`
}

async function readScanFromDisk(tier: OtpTier, lane: OtpRole | null, regions: ScanRegion[]) {
  return readCache<ScanResult>('scans', scanCacheKey(tier, lane, regions))
}

function collectIreliaMatches(matches: MatchBuildData[], role: EngineOtpRole | null) {
  return matches.filter((match) =>
    match.championId === IRELIA_ID && match.position !== 'UNKNOWN' && (role === null || match.position === role),
  )
}

function buildCandidateResult(candidate: {
  puuid: string
  region: ScanRegion
  tier: Exclude<OtpTier, 'all'>
  leaguePoints: number
  masteryPoints: number
  masteryRank: number
  name: string
  matches: MatchBuildData[]
}, threshold: number): ScannedCandidate {
  const roles = (['TOP', 'MID'] as const).map((role) => {
    const roleMatches = candidate.matches.filter((match) => match.position === role)
    const ireliaMatches = roleMatches.filter((match) => match.championId === IRELIA_ID)
    const wins = ireliaMatches.filter((match) => match.win).length
    const ireliaShare = roleMatches.length ? ireliaMatches.length / roleMatches.length : 0
    return {
      role,
      rankedGames: roleMatches.length,
      ireliaGames: ireliaMatches.length,
      ireliaShare,
      winRate: ireliaMatches.length ? wins / ireliaMatches.length : 0,
      isOtp: roleMatches.length >= 8 && ireliaShare >= threshold,
    }
  })
  const otpRoles = roles.filter((role) => role.isOtp).map((role) => role.role)
  const otpRole = roles
    .filter((role) => role.isOtp)
    .sort((first, second) => second.ireliaShare - first.ireliaShare || second.winRate - first.winRate)[0]?.role ?? null

  const allIrelia = collectIreliaMatches(candidate.matches, null)
  const scoped = otpRole ? collectIreliaMatches(candidate.matches, otpRole) : allIrelia
  const wins = allIrelia.filter((match) => match.win).length

  const byOpponent = new Map<number, MatchBuildData[]>()
  scoped.forEach((match) => {
    if (match.opponentChampionId === null) return
    const group = byOpponent.get(match.opponentChampionId) ?? []
    group.push(match)
    byOpponent.set(match.opponentChampionId, group)
  })
  const byOpponentProfile: Record<string, BuildProfile> = {}
  byOpponent.forEach((matches, opponentId) => {
    byOpponentProfile[String(opponentId)] = aggregateProfile(matches, 'lane')
  })

  const rankedMatches = candidate.matches.filter((match) => match.position === 'TOP' || match.position === 'MID')

  return {
    name: candidate.name,
    region: candidate.region,
    tier: candidate.tier,
    leaguePoints: candidate.leaguePoints,
    ireliaMasteryPoints: candidate.masteryPoints,
    ireliaMasteryRank: candidate.masteryRank,
    rankedSample: rankedMatches.length,
    ireliaGames: allIrelia.length,
    ireliaShare: rankedMatches.length ? allIrelia.length / rankedMatches.length : 0,
    winRate: allIrelia.length ? wins / allIrelia.length : 0,
    isOtp: otpRoles.length > 0,
    otpRole,
    otpRoles,
    roles,
    matches: candidate.matches,
    byOpponent: byOpponentProfile,
  }
}

/**
 * Scans one or more regional ladders for Irelia players. Targeting is
 * mastery-led, like onetricks.gg: a ladder entry only becomes a candidate when
 * Irelia is among the account's top mastery champions, which removes the vast
 * majority of non-Irelia accounts before any match pull. Candidates are then
 * deepened with recent solo-queue games and a minimum number of Irelia games is
 * required to enter the analysed pool.
 */
export async function runKoreanScan(
  tier: OtpTier,
  entryLimit: number,
  sampleSize: number,
  threshold: number,
  lane: OtpRole | null,
  report: ProgressReporter,
  regions: ScanRegion[] = defaultScanRegions,
  minIreliaGames = 3,
  rosterOnly = false,
): Promise<ScanResult> {
  const activeRegions = regions.length ? regions : defaultScanRegions

  // When the token bucket parks the scan at the rate limit, tell the UI the scan
  // is waiting — and will continue on its own unless the user stops it.
  const unsubscribeRate = onRateLimitWait((waitMs) => {
    report({
      phase: 'ratelimit',
      message: `Rate limit reached — waiting ${Math.ceil(waitMs / 1_000)}s for the window to refresh, then continuing automatically`,
      done: 0,
      total: 0,
    })
  })
  const tierValues: Array<Exclude<OtpTier, 'all'>> = tier === 'all'
    ? ['challenger', 'grandmaster', 'master']
    : [tier]

  report({
    phase: 'ladder',
    message: rosterOnly ? 'Roster scan: skipping the ladders…' : `Reading ${activeRegions.join(' + ')} tier ladders…`,
    done: 0,
    total: rosterOnly ? 0 : activeRegions.length * tierValues.length,
  })
  const leagueEntries: Array<{ puuid: string; leaguePoints: number; rank: string; tier: Exclude<OtpTier, 'all'>; region: ScanRegion }> = []
  let ladderSteps = 0
  for (const region of rosterOnly ? [] : activeRegions) {
    const routing = scanRegions[region]
    for (const tierValue of tierValues) {
      try {
        // Emerald is reached through the paginated division endpoint, not the
        // apex ladder endpoints, so the response shape differs.
        const isEmerald = tierValue === 'emerald'
        const league = await riotGet<{ entries: Array<{ puuid: string; leaguePoints: number; rank: string }> } | Array<{ puuid: string; leaguePoints: number; rank: string }>>(
          getActiveApiKey(),
          routing.platform,
          isEmerald
            ? '/lol/league/v4/entries/RANKED_SOLO_5x5/EMERALD/I?page=1'
            : leaguePaths[tierValue],
        )
        const list = Array.isArray(league) ? league : league.entries
        leagueEntries.push(
          ...[...list]
            .sort((a, b) => b.leaguePoints - a.leaguePoints)
            .slice(0, entryLimit)
            .map((entry) => ({ ...entry, tier: tierValue, region })),
        )
      } catch (error) {
        // A missing ladder (fresh season, region without masters yet) should not
        // abort the whole scan; skip it and keep going.
        if (!(error instanceof ApiError)) throw error
      }
      ladderSteps += 1
      report({ phase: 'ladder', message: `Read ${region} ${tierValue} (${routing.label})`, done: ladderSteps, total: activeRegions.length * tierValues.length })
    }
  }

  // Deduplicate across tiers, keeping the first (highest-LP ordering) sighting.
  const entryMap = new Map<string, { puuid: string; leaguePoints: number; rank: string; tier: Exclude<OtpTier, 'all'>; region: ScanRegion }>()
  leagueEntries.forEach((entry) => {
    if (!entry.puuid || entryMap.has(entry.puuid)) return
    entryMap.set(entry.puuid, entry)
  })
  const entries = [...entryMap.values()]

  // Priority roster first: curated one-tricks resolved by Riot ID. They enter
  // the candidate set ahead of ladder-derived accounts, so a partial scan still
  // deepens the matchups these specialists cover.
  const candidates: Candidate[] = []
  const rosterPuuids = new Set<string>()
  const roster = await loadRoster()
  report({ phase: 'roster', message: 'Resolving priority OTP roster…', done: 0, total: roster.length })
  for (const [index, otp] of roster.entries()) {
    try {
      const routing = scanRegions[otp.region]
      const account = await getAccount(getActiveApiKey(), otp.gameName, otp.tagLine, routing.regional)
      if (account?.puuid && !rosterPuuids.has(account.puuid)) {
        rosterPuuids.add(account.puuid)
        candidates.push({
          puuid: account.puuid,
          region: otp.region,
          routing,
          tier: 'master',
          leaguePoints: otp.leaguePoints,
          masteryPoints: 0,
          masteryRank: 0,
        })
      }
    } catch (error) {
      // A renamed or transferred account must not abort the whole scan.
      if (!(error instanceof ApiError)) throw error
    }
    report({
      phase: 'roster',
      message: `Resolved ${index + 1} of ${roster.length} priority one-tricks · ${candidates.length} ready`,
      done: index + 1,
      total: roster.length,
    })
  }

  report({ phase: 'mastery', message: 'Checking Irelia mastery on ladder accounts…', done: 0, total: entries.length })
  for (const [index, entry] of entries.entries()) {
    if (rosterPuuids.has(entry.puuid)) continue
    try {
      const masteries = await riotGet<Array<{ championId: number; championPoints: number }>>(
        getActiveApiKey(),
        scanRegions[entry.region].platform,
        `/lol/champion-mastery/v4/champion-masteries/by-puuid/${encodeURIComponent(entry.puuid)}?count=10`,
      )
      const ranked = [...masteries].sort((a, b) => b.championPoints - a.championPoints)
      const ireliaIndex = ranked.findIndex((mastery) => mastery.championId === IRELIA_ID)
      // Mastery-led targeting: only accounts with Irelia among their top 3
      // champions by points are kept. This is the onetricks.gg-style signal and
      // cuts the candidate set dramatically versus "has any Irelia mastery".
      if (ireliaIndex >= 0 && ireliaIndex < 3) {
        candidates.push({
          puuid: entry.puuid,
          region: entry.region,
          routing: scanRegions[entry.region],
          tier: entry.tier,
          leaguePoints: entry.leaguePoints,
          masteryPoints: ranked[ireliaIndex].championPoints,
          masteryRank: ireliaIndex + 1,
        })
      }
    } catch (error) {
      if (!(error instanceof ApiError) || error.statusCode !== 404) throw error
    }
    report({ phase: 'mastery', message: `Checked ${index + 1}/${entries.length} accounts · ${candidates.length} Irelia-led`, done: index + 1, total: entries.length })
  }

  // Remember who this scan used, so a later deepening pass walks the same people
  // backwards through their history instead of starting from a different pool.
  await writeCache('scans', SCAN_CANDIDATES_KEY, {
    candidates: candidates.map((candidate) => ({ puuid: candidate.puuid, region: candidate.region })),
    savedAt: Date.now(),
  } satisfies StoredCandidates)

  // Deep pull: every candidate gets a full recent ranked pull. Each match and
  // timeline is cached to disk, so future scans and matchup lookups are instant.
  const totalScanSlots = candidates.reduce((total) => total + sampleSize + 1, 0)
  let scannedSlots = 0
  let cacheHits = 0
  /** Matches pulled that were not already on disk — the signal for "anything new?". */
  let newGames = 0
  const scanned: Array<{
    puuid: string
    region: ScanRegion
    tier: Exclude<OtpTier, 'all'>
    leaguePoints: number
    masteryPoints: number
    masteryRank: number
    name: string
    matches: MatchBuildData[]
  }> = []

  report({ phase: 'matches', message: 'Pulling recent ranked games for each candidate…', done: 0, total: totalScanSlots })
  for (const candidate of candidates) {
    const matchIds = await riotGet<string[]>(
      getActiveApiKey(),
      candidate.routing.regional,
      `/lol/match/v5/matches/by-puuid/${encodeURIComponent(candidate.puuid)}/ids?queue=420&count=${sampleSize}`,
    )
    scannedSlots += 1
    const matches: MatchBuildData[] = []
    let name = `${candidate.region} ${candidate.tier} candidate`
    for (const matchId of matchIds) {
      // `getCachedMatch` already consults the disk cache, so reading the entry
      // here first only parsed every match body twice. `hasCache` answers the
      // hit/miss bookkeeping without the second JSON parse.
      const alreadyCached = await hasCache('matches', matchId)
      // Player-aware variant: a body cached before a Riot puuid migration no
      // longer contains the account's current puuid, so the plain cache read
      // would make the account look like it never played. This re-fetches and
      // overwrites the stale body once, on first contact.
      const match = await getCachedMatchForPlayer(fetchJson, matchId, candidate.puuid, candidate.routing.regional)
      if (alreadyCached) cacheHits += 1
      else newGames += 1
      if (match.info.queueId !== 420) {
        scannedSlots += 1
        continue
      }
      const player = match.info.participants.find((entry) => entry.puuid === candidate.puuid)
      // Only Irelia games are ever aggregated: `collectIreliaMatches` feeds every
      // profile, matchup and recommendation, and `loadCacheWideIreliaMatches`
      // skips non-Irelia records outright. Fetching a timeline for the rest of the
      // sample spent roughly half the key's budget on data nothing reads.
      const withTimeline = player?.championId === IRELIA_ID
      const data = await buildMatchData(fetchJson, match, candidate.puuid, { withTimeline, routing: candidate.routing.regional })
      if (data) matches.push(data)
      if (player?.riotIdGameName) {
        name = player.riotIdTagline ? `${player.riotIdGameName}#${player.riotIdTagline}` : String(player.riotIdGameName)
      }
      scannedSlots += 1
      report({
        phase: 'matches',
        message: `${matches.length} games pulled · ${cacheHits} reused from disk cache`,
        done: Math.min(scannedSlots, totalScanSlots),
        total: totalScanSlots,
      })
    }
    if (matches.length) scanned.push({ ...candidate, name, matches })
  }

  // The activity gate: a candidate only enters the analysed pool when they have
  // actually played Irelia in their recent ranked sample. This is what makes the
  // sample an "active Irelia mains" list rather than "accounts with mastery".
  const analyzed = scanned
    .map((candidate) => buildCandidateResult(candidate, threshold))
    .filter((candidate) => candidate.ireliaGames >= minIreliaGames)
    .sort((first, second) =>
      Number(second.isOtp) - Number(first.isOtp)
      || second.ireliaShare - first.ireliaShare
      || second.winRate - first.winRate
      || first.ireliaMasteryRank - second.ireliaMasteryRank
      || second.ireliaMasteryPoints - first.ireliaMasteryPoints
      || tierPriority[second.tier] - tierPriority[first.tier]
      || second.leaguePoints - first.leaguePoints,
    )

  const laneFiltered = lane
    ? analyzed
      .map((candidate) => {
        const role = candidate.roles.find((entry) => entry.role === lane)
        return { candidate, role }
      })
      .filter(({ role }) => (role?.ireliaGames ?? 0) > 0)
      .sort((first, second) =>
        (second.role?.ireliaShare ?? 0) - (first.role?.ireliaShare ?? 0)
        || (second.role?.winRate ?? 0) - (first.role?.winRate ?? 0)
        || (second.role?.ireliaGames ?? 0) - (first.role?.ireliaGames ?? 0),
      )
      .map(({ candidate }) => candidate)
    : analyzed

  unsubscribeRate()

  const result: ScanResult = {
    scannedAt: Date.now(),
    tier,
    lane,
    regions: activeRegions,
    threshold,
    minIreliaGames,
    candidatePoolSize: entries.length,
    masteryCandidates: candidates.length,
    deepenedCandidates: scanned.length,
    cacheHits,
    newGames,
    analyzed: laneFiltered,
    note: lane
      ? `Mastery-led sample across ${activeRegions.join(' + ')}: screened ${candidates.length} Irelia-led accounts, analysed ${scanned.length} with >=${minIreliaGames} recent solo-queue Irelia games (${lane}). Cached on disk; refresh to pull the latest games.`
      : `Mastery-led sample across ${activeRegions.join(' + ')}: screened ${candidates.length} Irelia-led accounts, analysed ${scanned.length} with >=${minIreliaGames} recent solo-queue Irelia games. Active mains rank first. Cached on disk; refresh to pull the latest games.`,
  }

  await flushIreliaIndex()
  await writeCache('scans', scanCacheKey(tier, lane, activeRegions), result)
  if (lane === null) {
    await writeCache('scans', 'latest', { key: scanCacheKey(tier, lane, activeRegions), scannedAt: result.scannedAt })
  }
  report({ phase: 'done', message: `Scan complete · ${laneFiltered.length} active mains · ${cacheHits} cached matches reused`, done: totalScanSlots, total: totalScanSlots })
  return result
}

/* ------------------------------------------------------------------ *
 * Build recommendation from a saved scan
 * ------------------------------------------------------------------ */

export type BuildRequest = {
  opponent: number | null
  allies: number[]
  enemies: number[]
  lane: OtpRole
  source: 'lane' | 'comp'
}

export type BuildResponse = {
  source: 'lane' | 'comp'
  lane: OtpRole
  patch: string
  patchExact: boolean
  games: number
  profile: BuildProfile
  reason: string
  /** Whole-build optimisation over completed inventories. */
  itemSets?: ItemSetEntry[]
  /** Per-level skill matrix, max order and early order. */
  skills?: SkillOrderAnalysis
  /** Context-weighted win rate, which may differ from the raw profile. */
  weighted?: ConfidenceInterval
  /** How much the context weighting actually concentrated the sample. */
  weighting?: {
    totalWeight: number
    effectiveSampleSize: number
    /** Highest-weighted match in the pool, for transparency. */
    topMatchId: string | null
  }
}

/**
 * Every analysed candidate carries Irelia champion mastery, so any Irelia game
 * they played is valid Irelia evidence. Verified OTPs are preferred, but the
 * pool widens to all Irelia games found in the scan so a build can always be
 * produced once any Irelia game has been captured.
 */
function collectVerifiedMatches(scan: ScanResult | null, lane: OtpRole) {
  if (!scan) return [] as MatchBuildData[]
  const otp: MatchBuildData[] = []
  const rest: MatchBuildData[] = []
  scan.analyzed.forEach((candidate) => {
    const bucket = candidate.isOtp ? otp : rest
    collectIreliaMatches(candidate.matches, lane).forEach((match) => bucket.push(match))
  })
  return [...otp, ...rest]
}

export async function buildRecommendation(patch: string, request: BuildRequest): Promise<BuildResponse> {
  const scan = await getStoredScan()
  const lane = request.lane

  // Two independent sources of evidence, and both are genuinely useful:
  //  - the scan snapshot: candidates verified as Irelia mains, refreshed on scan
  //  - the cache-wide index: every Irelia game ever written to disk
  // Previously the cache was consulted only when the scan produced nothing,
  // which starved the build whenever a scan held even one match.
  const fromScan = collectVerifiedMatches(scan, lane)
  const fromCache = (await loadCacheWideIreliaMatches())
    .filter((match) => !match.position || match.position === lane || match.position === 'UNKNOWN')

  // Scan entries win ties because they carry verified-mastery provenance.
  const byMatchId = new Map<string, MatchBuildData>()
  for (const match of fromCache) byMatchId.set(match.matchId, match)
  for (const match of fromScan) byMatchId.set(match.matchId, match)
  const verified = [...byMatchId.values()]

  // An empty patch means "the most recent patch with data", and that has to be
  // resolved BEFORE filtering. Resolving it only for the label (as this did)
  // left the pool spanning every patch on disk — including games many patches
  // old — while the response still described itself as the newest patch.
  const effectivePatch = patch || mostRecentPatch(verified)
  const exact = effectivePatch ? verified.filter((match) => match.patch === effectivePatch) : verified
  const patchExact = exact.length > 0
  // Never fall back to a wider pool than the one being described, so the
  // reported sample size always matches the matches actually aggregated.
  const pool = patchExact ? exact : verified

  let matches: MatchBuildData[]
  let reason: string
  if (!verified.length) {
    matches = []
    reason = 'No Irelia games captured yet. Run a scan once while the dev server is online, then pick a matchup.'
  } else if (request.source === 'lane') {
    if (!request.opponent) {
      // No opponent picked yet: show the whole lane route rather than nothing,
      // so the page always leads with a usable baseline build.
      matches = pool
      reason = pool.length
        ? `All Irelia ${lane} games captured${patchExact ? ` on patch ${effectivePatch}` : ' (most recent patch with data)'}. Pick a lane opponent to narrow this to the matchup.`
        : 'No Irelia games captured for this lane yet.'
    } else {
      matches = pool.filter((match) => match.opponentChampionId === request.opponent)
      reason = matches.length
        ? `Games where Irelia mains faced your lane opponent${patchExact ? ` on patch ${effectivePatch}` : ' (most recent patch with data)'}.`
        : 'No captured Irelia games against this opponent yet. Scan again or try the composition view.'
    }
  } else if (!request.allies.length && !request.enemies.length) {
    matches = []
    reason = 'Set allies or enemies to see composition-based builds.'
  } else {
    const enemySet = new Set(request.enemies)
    const allySet = new Set(request.allies)
    matches = pool
      .map((match) => {
        const enemyOverlap = match.enemyChampionIds.filter((id) => enemySet.has(id)).length
        const allyOverlap = match.allyChampionIds.filter((id) => allySet.has(id)).length
        return { match, score: enemyOverlap * 2 + allyOverlap }
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((entry) => entry.match)
    reason = matches.length
      ? 'Games whose teams most closely match your composition.'
      : 'No captured Irelia games overlap this composition yet.'
  }

  // Context-weighted view of the same pool. When no draft context was supplied
  // every game carries the baseline weight, so the weighted estimate equals the
  // raw one and the UI can safely show either.
  const context = {
    enemies: request.enemies,
    allies: request.allies,
    laneOpponent: request.opponent ?? null,
    position: lane,
    patch: patchExact ? patch : undefined,
  }
  const weightedPool = matches.map((match) => ({ match, weight: matchWeight(match, context) }))
  const weighted = weightedInterval(
    weightedPool.map((entry) => ({ success: entry.match.win, weight: entry.weight })),
  )
  const totalWeight = weightedPool.reduce((sum, entry) => sum + entry.weight, 0)
  const topMatch = weightedPool.slice().sort((a, b) => b.weight - a.weight)[0]

  // Item gold lets the profile tell finished items from components.
  const staticData = await getStaticData()
  const itemGold = new Map(staticData.items.map((item) => [item.id, item.gold]))

  return {
    source: request.source,
    lane,
    // Report which patch the evidence actually came from. When no patch filter
    // was supplied the caller still needs to know, so derive it from the matches
    // that were aggregated rather than echoing back an empty string.
    patch: effectivePatch,
    patchExact,
    games: matches.length,
    profile: aggregateProfile(matches, request.source, itemGold),
    reason,
    itemSets: optimiseItemSets(matches, { minGames: 2, maxSets: 8 }),
    skills: analyseSkillOrder(matches, { maxLevel: 13 }),
    weighted,
    weighting: {
      totalWeight,
      effectiveSampleSize: weighted.effectiveSampleSize,
      topMatchId: topMatch?.match.matchId ?? null,
    },
  }
}

/* ------------------------------------------------------------------ *
 * Recent games + sampled ban rate
 * ------------------------------------------------------------------ */

export type MetaGame = {
  matchId: string
  win: boolean
  championId: number
  position: string
  patch: string
  /** Unix epoch ms when the game started, for "8 hours ago" recency labels. */
  gameCreation: number
  duration: number
  summonerName: string | null
  opponentChampionId: number | null
  opponentName: string | null
  finalItems: number[]
  /** Ally + enemy champion ids, for the full-composition dropdown. */
  allyChampionIds: number[]
  enemyChampionIds: number[]
  /** Ordered item purchases with minutes, for the build timeline. */
  lanePurchases: Array<{ id: number; minute: number }>
  kills: number
  deaths: number
  assists: number
  cs: number
  killParticipation: number | null
  visionScore: number | null
  laneDeltas: { goldDiff15: number | null; xpDiff15: number | null; csDiff15: number | null }
  primaryStyle: number | null
  keystoneId: number | null
  region: string | null
}

export type MetaResponse = {
  lane: OtpRole
  patch: string
  patchExact: boolean
  /** Sampled ban rate across cached ranked games (not a global figure). */
  banRate: ConfidenceInterval
  /** Total cached ranked-solo games the ban rate was computed over. */
  banSampleGames: number
  games: MetaGame[]
}

const BAN_INDEX_KEY = 'ban-index'
const BAN_INDEX_TTL_MS = 12 * 60 * 60 * 1_000

type BanIndexFile = { games: number; banned: number; updatedAt: number }

/**
 * Sampled ban rate across every cached ranked-solo game.
 *
 * Ban data is only meaningful over the *whole* cache: a match that Irelia played
 * in can never have her banned, so the Irelia-only subset always reports 0%.
 *
 * Riot uses championId -1 as the "no ban" placeholder, so those entries must be
 * excluded or bans get counted that never happened.
 *
 * The disk index is re-read on every request — it is a tiny file — so a
 * headless rebuild is reflected immediately. Only the expensive full-cache walk
 * is gated by the TTL.
 */
async function sampledBanRate(): Promise<{ banRate: ConfidenceInterval; games: number }> {
  const stored = await readCache<BanIndexFile>('scans', BAN_INDEX_KEY)
  if (stored && Date.now() - stored.updatedAt < BAN_INDEX_TTL_MS && stored.games > 0) {
    return { banRate: wilsonInterval(stored.banned, stored.games), games: stored.games }
  }

  const keys = await listCacheKeys('matches')
  let games = 0
  let banned = 0
  for (const key of keys) {
    const record = await readCache<Record<string, any>>('matches', key)
    const teams = record?.info?.teams
    if (!Array.isArray(teams) || record?.info?.queueId !== 420) continue
    games += 1
    const isBanned = teams.some((team: any) =>
      Array.isArray(team?.bans)
      && team.bans.some((ban: any) => ban?.championId === IRELIA_ID),
    )
    if (isBanned) banned += 1
  }

  const result = { banRate: wilsonInterval(banned, games), games }
  await writeCache('scans', BAN_INDEX_KEY, { games, banned, updatedAt: Date.now() } satisfies BanIndexFile)
  return result
}

/** The game patch most of the given matches were played on. */
function mostRecentPatch(matches: MatchBuildData[]): string {
  const counts = new Map<string, number>()
  for (const match of matches) {
    if (!match.patch) continue
    counts.set(match.patch, (counts.get(match.patch) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
}

/* ------------------------------------------------------------------ *
 * Per-matchup builds (one profile per lane opponent)
 * ------------------------------------------------------------------ */

export type MatchupEntry = {
  opponentChampionId: number
  opponentName: string
  games: number
  wins: number
  rawWinRate: number
  /** Win rate shrunk toward Irelia's overall rate; honest at small n. */
  shrunkenWinRate: number
  shrunkenInterval: ConfidenceInterval
  profile: BuildProfile
}

export type MatchupsResponse = {
  lane: OtpRole
  patch: string
  baseGames: number
  baseWinRate: number
  matchups: MatchupEntry[]
}

async function buildMatchups(patch: string, lane: OtpRole): Promise<MatchupsResponse> {
  const all = (await loadCacheWideIreliaMatches())
    .filter((match) => !match.position || match.position === lane || match.position === 'UNKNOWN')

  // Same rule as buildRecommendation: resolve an empty patch to the newest one
  // with data before filtering, so the pool matches the patch being reported.
  const effectivePatch = patch || mostRecentPatch(all)
  const exact = effectivePatch ? all.filter((match) => match.patch === effectivePatch) : all
  const pool = exact.length ? exact : all

  const baseWins = pool.filter((match) => match.win).length
  const baseWinRate = pool.length ? baseWins / pool.length : 0

  const staticData = await getStaticData()
  const championNames = new Map<number, string>(
    staticData.champions.map((champion) => [champion.id, champion.name]),
  )

  const groups = new Map<number, MatchBuildData[]>()
  for (const match of pool) {
    if (match.opponentChampionId == null) continue
    const group = groups.get(match.opponentChampionId) ?? []
    group.push(match)
    groups.set(match.opponentChampionId, group)
  }

  const matchups: MatchupEntry[] = [...groups.entries()]
    .map(([opponentChampionId, matches]) => {
      const wins = matches.filter((match) => match.win).length
      return {
        opponentChampionId,
        opponentName: championNames.get(opponentChampionId) ?? String(opponentChampionId),
        games: matches.length,
        wins,
        rawWinRate: matches.length ? wins / matches.length : 0,
        shrunkenWinRate: shrinkWinRate(wins, matches.length, baseWinRate),
        shrunkenInterval: shrunkenInterval(wins, matches.length, baseWinRate),
        profile: aggregateProfile(matches, 'lane'),
      }
    })
    .sort((a, b) => b.games - a.games)

  return { lane, patch: effectivePatch, baseGames: pool.length, baseWinRate, matchups }
}

async function buildMeta(patch: string, lane: OtpRole, limit: number, sinceHours: number): Promise<MetaResponse> {
  const all = (await loadCacheWideIreliaMatches())
    .filter((match) => !match.position || match.position === lane || match.position === 'UNKNOWN')

  // A real time window, not a cosmetic one: only games started in the last N
  // hours survive, so the user can genuinely narrow to "last 24h" vs "all time".
  const sinceCutoff = sinceHours > 0 ? Date.now() - sinceHours * 3_600_000 : 0
  const inWindow = sinceHours > 0 ? all.filter((match) => match.gameCreation >= sinceCutoff) : all

  // Resolve an empty patch before filtering, for the same reason as
  // buildRecommendation: otherwise the pool spans every patch on disk while
  // the response advertises no patch at all.
  const effectivePatch = patch || mostRecentPatch(inWindow)
  const exact = effectivePatch ? inWindow.filter((match) => match.patch === effectivePatch) : inWindow
  const patchExact = exact.length > 0
  const pool = patchExact ? exact : inWindow

  const { banRate, games: banSampleGames } = await sampledBanRate()

  const games: MetaGame[] = pool
    .slice()
    .sort((a, b) => b.gameCreation - a.gameCreation)
    .slice(0, limit)
    .map((match) => ({
      matchId: match.matchId,
      win: match.win,
      championId: match.championId,
      position: match.position,
      patch: match.patch,
      gameCreation: match.gameCreation,
      duration: match.duration,
      summonerName: match.summonerName,
      opponentChampionId: match.opponentChampionId,
      opponentName: match.opponentName,
      finalItems: match.finalItems,
      allyChampionIds: match.allyChampionIds,
      enemyChampionIds: match.enemyChampionIds,
      lanePurchases: match.lanePurchases,
      kills: match.kills,
      deaths: match.deaths,
      assists: match.assists,
      cs: match.cs,
      killParticipation: match.killParticipation,
      visionScore: match.visionScore,
      laneDeltas: match.laneDeltas,
      primaryStyle: match.primaryStyle,
      keystoneId: match.keystoneId,
      region: match.region,
    }))

  return { lane, patch: effectivePatch, patchExact, banRate, banSampleGames, games }
}

/* ------------------------------------------------------------------ *
 * Static (Data Dragon) data
 * ------------------------------------------------------------------ */

/** One champion as normalised out of Data Dragon's champion.json. */
export type StaticChampion = { id: number; name: string; ddragonId: string }

/** One purchasable item as normalised out of Data Dragon's item.json. */
export type StaticItem = {
  id: number
  name: string
  plaintext: string
  description: string
  image: string
  stats: Record<string, number>
  gold: number
  purchasable: boolean
  maps: Record<string, boolean>
}

/** A rune tree (`isTree`) or one rune within a tree. */
export type StaticRune = { id: number; name: string; icon: string; isTree?: boolean; tree?: string }

/** Everything the client needs from Data Dragon, cached in memory and on disk. */
export type StaticData = {
  version: string
  champions: StaticChampion[]
  items: StaticItem[]
  runes: StaticRune[]
}

const staticDataCache = new Map<string, { expiresAt: number; value: StaticData }>()

async function getStaticData(): Promise<StaticData> {
  // Versioned key: the cached payload is trusted wholesale on a cold boot, so a
  // shape change (champions gained `ddragonId`) must invalidate it. Bump this
  // whenever the returned object's shape changes.
  const cacheKey = 'static-data-v2'
  const cached = staticDataCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  // Persist across restarts so a cold boot does not always re-hit Data Dragon —
  // but only trust the persisted payload while it matches the newest Data Dragon
  // version. The version moves on patch day, and this re-check (one tiny,
  // unthrottled versions.json fetch per cold boot) lets the catalog refresh
  // itself instead of needing a manual cache wipe.
  if (!cached) {
    const onDisk = await readCache<{ value: StaticData; savedAt?: number }>('scans', cacheKey)
    try {
      const versionsResponse = await fetch('https://ddragon.leagueoflegends.com/api/versions.json')
      if (versionsResponse.ok) {
        const versions = (await versionsResponse.json()) as string[]
        if (onDisk?.value?.version && versions[0] === onDisk.value.version) {
          // Still the current patch: reuse the persisted payload.
          await writeCache('scans', cacheKey, { value: onDisk.value, savedAt: Date.now() })
          staticDataCache.set(cacheKey, { expiresAt: Date.now() + 5 * 60 * 1_000, value: onDisk.value })
          return onDisk.value
        }
      }
      // The version moved on (or the check failed): fall through and refetch
      // the full payload below.
    } catch {
      // Data Dragon unreachable: keep serving the cached payload rather than
      // breaking item icons and champion data entirely.
      if (onDisk?.value?.version) {
        staticDataCache.set(cacheKey, { expiresAt: Date.now() + 5 * 60 * 1_000, value: onDisk.value })
        return onDisk.value
      }
    }
  }

  const versionsResponse = await fetch('https://ddragon.leagueoflegends.com/api/versions.json')
  if (!versionsResponse.ok) throw new ApiError('Could not load the latest game data.', 502)
  const versions = (await versionsResponse.json()) as string[]
  const version = versions[0]
  const [championsResponse, itemsResponse, runesResponse] = await Promise.all([
    fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`),
    fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/item.json`),
    fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/runesReforged.json`),
  ])
  if (!championsResponse.ok || !itemsResponse.ok || !runesResponse.ok) {
    throw new ApiError('Could not load current champion, item, and rune data.', 502)
  }
  const [championData, itemData, runeData] = await Promise.all([
    championsResponse.json(),
    itemsResponse.json(),
    runesResponse.json(),
  ]) as [
    { data: Record<string, { key: string; name: string }> },
    {
      data: Record<string, {
        name: string
        description: string
        plaintext: string
        image: { full: string }
        stats: Record<string, number>
        gold: { total: number; purchasable: boolean }
        maps: Record<string, boolean>
      }>
    },
    Array<{
      id: number
      name: string
      icon: string
      slots: Array<{ runes: Array<{ id: number; name: string; icon: string }> }>
    }>,
  ]
  const value = {
    version,
    // `ddragonId` is the key Data Dragon uses for image filenames, which is NOT
    // always derivable from the display name (Wukong -> MonkeyKing.png,
    // Nunu & Willump -> Nunu.png, Cho'Gath -> Chogath.png). Icon URLs must use it.
    champions: Object.entries(championData.data)
      .map(([ddragonId, champion]) => ({ id: Number(champion.key), name: champion.name, ddragonId }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    items: Object.entries(itemData.data)
      .map(([id, item]) => ({
        id: Number(id),
        name: item.name,
        plaintext: item.plaintext,
        description: item.description,
        image: item.image.full,
        stats: item.stats,
        gold: item.gold.total,
        purchasable: item.gold.purchasable,
        maps: item.maps,
      }))
      .filter((item) => item.id > 0 && item.purchasable && item.maps?.['11']),
    runes: runeData.flatMap((tree) => [
      { id: tree.id, name: tree.name, icon: tree.icon, isTree: true },
      ...tree.slots.flatMap((slot) => slot.runes.map((rune) => ({ ...rune, tree: tree.name }))),
    ]),
  }
  staticDataCache.set(cacheKey, { expiresAt: Date.now() + 5 * 60 * 1_000, value })
  await writeCache('scans', cacheKey, { value, savedAt: Date.now() })
  return value
}

/* ------------------------------------------------------------------ *
 * League Client (live champion select)
 * ------------------------------------------------------------------ */

function findLockfile(configuredPath?: string) {
  const candidates = [
    configuredPath,
    path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Riot Games', 'League of Legends', 'lockfile'),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Riot Games', 'League of Legends', 'lockfile'),
    'C:\\Riot Games\\League of Legends\\lockfile',
  ].filter((candidate): candidate is string => Boolean(candidate))

  return candidates.find((candidate) => existsSync(candidate))
}

/** Whether a live champion select is currently open in the League Client. */
async function hasChampSelect(lockfilePath: string) {
  try {
    await getLcuJson(lockfilePath, '/lol-champ-select/v1/session')
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * Live Client Data API (in-game CS / vision score)
 * ------------------------------------------------------------------ */

type LivePlayerScore = {
  creepScore: number
  wardScore: number
  kills: number
  deaths: number
  assists: number
}

type LiveClientData = {
  gameData?: { gameTime: number }
  activePlayer?: { summonerName: string }
  allPlayers?: Array<{
    summonerName: string
    championName: string
    team: string
    level: number
    isDead: boolean
    scores?: LivePlayerScore
  }>
}

/**
 * Reads Riot's official in-game API. It only listens while a real game is
 * running, on a self-signed localhost TLS socket, so TLS validation is disabled
 * and a refusal/timeout means "not in game" rather than an error.
 */
function getLiveClientData(): Promise<LiveClientData> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: '127.0.0.1',
        port: 2999,
        path: '/liveclientdata/allgamedata',
        method: 'GET',
        rejectUnauthorized: false,
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => (body += chunk))
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(new ApiError('No live game running.', 404))
            return
          }
          try {
            resolve(JSON.parse(body) as LiveClientData)
          } catch {
            reject(new ApiError('Unreadable live game data.', 502))
          }
        })
      },
    )
    request.on('error', () => reject(new ApiError('No live game running.', 404)))
    request.setTimeout(2_000, () => {
      request.destroy()
      reject(new ApiError('Live client data timed out.', 504))
    })
    request.end()
  })
}

async function getLcuJson(lockfilePath: string, endpoint: string) {
  const lockfile = (await readFile(lockfilePath, 'utf8')).trim().split(':')
  const port = Number(lockfile[2])
  const password = lockfile[3]
  if (!Number.isInteger(port) || !password) throw new ApiError('The League Client lockfile is invalid.', 500)

  return new Promise<unknown>((resolve, reject) => {
    const request = https.request(
      {
        hostname: '127.0.0.1',
        port,
        path: endpoint,
        method: 'GET',
        rejectUnauthorized: false,
        headers: {
          Authorization: `Basic ${Buffer.from(`riot:${password}`).toString('base64')}`,
          Accept: 'application/json',
        },
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => (body += chunk))
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(new ApiError('The League Client did not return a champion-select session.', 404))
            return
          }
          try {
            resolve(JSON.parse(body))
          } catch {
            reject(new ApiError('The League Client returned unreadable session data.', 502))
          }
        })
      },
    )
    request.setTimeout(3_000, () => request.destroy(new Error('League Client request timed out.')))
    request.on('error', () => reject(new ApiError('Could not connect to the local League Client.', 503)))
    request.end()
  })
}

/* ------------------------------------------------------------------ *
 * Server-sent events for scan progress
 * ------------------------------------------------------------------ */

function openEventStream(response: ServerResponse) {
  response.statusCode = 200
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  response.setHeader('Cache-Control', 'no-cache, no-transform')
  response.setHeader('Connection', 'keep-alive')
  response.flushHeaders?.()
  return (payload: unknown) => {
    response.write(`data: ${JSON.stringify(payload)}\n\n`)
  }
}

/* ------------------------------------------------------------------ *
 * Request handling
 * ------------------------------------------------------------------ */

function parseBuildRequest(url: URL): BuildRequest {
  const laneParam = (url.searchParams.get('lane') ?? 'TOP').toUpperCase()
  const lane: OtpRole = laneParam === 'MID' ? 'MID' : 'TOP'
  const opponent = Number(url.searchParams.get('opponent') ?? 0)
  const allies = (url.searchParams.get('allies') ?? '').split(',').map(Number).filter((id) => id > 0)
  const enemies = (url.searchParams.get('enemies') ?? '').split(',').map(Number).filter((id) => id > 0)
  const source = url.searchParams.get('source') === 'comp' ? 'comp' : 'lane'
  return { opponent: opponent > 0 ? opponent : null, allies, enemies, lane, source }
}

function parseScanParams(url: URL) {
  const tierValue = url.searchParams.get('tier') ?? 'all'
  if (!['all', 'challenger', 'grandmaster', 'master', 'emerald'].includes(tierValue)) {
    throw new ApiError('Tier must be all, challenger, grandmaster, master, or emerald.', 400)
  }
  const defaultLimit = tierValue === 'all' ? 20 : 12
  const entryLimit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? defaultLimit), 1), 40)
  const sampleSize = Math.min(Math.max(Number(url.searchParams.get('sampleSize') ?? 40), 1), 40)
  const threshold = Math.min(Math.max(Number(url.searchParams.get('threshold') ?? 0.5), 0.3), 1)
  const laneParam = (url.searchParams.get('lane') ?? '').toUpperCase()
  const lane: OtpRole | null = laneParam === 'TOP' || laneParam === 'MID' ? laneParam : null
  const force = url.searchParams.get('refresh') === '1'
  const regionsParam = (url.searchParams.get('regions') ?? '').toUpperCase()
  const regions = regionsParam
    .split(',')
    .map((value) => value.trim())
    .filter((value): value is ScanRegion => value in scanRegions)
  const minIreliaGames = Math.min(Math.max(Number(url.searchParams.get('minGames') ?? 3), 1), 20)
  // source=roster deepens only the tracked one-tricks, skipping the ladder read.
  const rosterOnly = url.searchParams.get('source') === 'roster'
  return {
    tier: tierValue as OtpTier,
    entryLimit,
    sampleSize,
    threshold,
    lane,
    force,
    regions: regions.length ? regions : defaultScanRegions,
    minIreliaGames,
    rosterOnly,
  }
}

export async function handleApiRequest(request: IncomingMessage, response: ServerResponse, options: RiotOptions) {
  const url = new URL(request.url ?? '/', 'http://localhost')
  if (request.method !== 'GET') throw new ApiError('Only GET requests are supported.', 405)

  if (url.pathname === '/status') {
    sendJson(response, 200, { configured: Boolean(options.apiKey), mode: 'local', usage: getApiUsage(), cacheDir: cacheDirectory() })
    return
  }

  if (url.pathname === '/champions') {
    sendJson(response, 200, await getStaticData())
    return
  }

  if (url.pathname === '/client/champ-select') {
    const lockfilePath = findLockfile(options.lockfilePath)
    if (!lockfilePath) {
      throw new ApiError('League Client not found. Start the client or set LEAGUE_CLIENT_LOCKFILE in .env.local.', 404)
    }
    sendJson(response, 200, await getLcuJson(lockfilePath, '/lol-champ-select/v1/session'))
    return
  }

  requireApiKey(options.apiKey)
  activeApiKey = options.apiKey

  if (url.pathname === '/riot/account') {
    const routing = getRegionalRouting(url.searchParams.get('region'))
    const account = await getAccount(
      getActiveApiKey(),
      url.searchParams.get('gameName') ?? '',
      url.searchParams.get('tagLine') ?? '',
      routing,
    )
    sendJson(response, 200, account)
    return
  }

  if (url.pathname === '/riot/player') {
    const routing = getRegionalRouting(url.searchParams.get('region'))
    const account = await getAccount(
      getActiveApiKey(),
      url.searchParams.get('gameName') ?? '',
      url.searchParams.get('tagLine') ?? '',
      routing,
    )
    const count = Math.min(Math.max(Number(url.searchParams.get('count') ?? 20), 1), 20)
    const matches = await getPlayerReport(account.puuid, routing, count, false)
    const ireliaGames = matches.filter((match) => match.championId === IRELIA_ID)
    sendJson(response, 200, {
      account: { gameName: account.gameName, tagLine: account.tagLine },
      rankedSample: matches.length,
      ireliaGames: ireliaGames.length,
      ireliaShare: matches.length ? ireliaGames.length / matches.length : 0,
      winRateOnIrelia: ireliaGames.length ? ireliaGames.filter((match) => match.win).length / ireliaGames.length : 0,
      matches,
    })
    return
  }

  // Saved scan snapshot (instant, offline-friendly).
  if (url.pathname === '/riot/scan') {
    const scan = await getStoredScan()
    sendJson(response, 200, { scan })
    return
  }

  // Matchup / composition build recommendation built from the saved scan.
  if (url.pathname === '/riot/build') {
    const patch = String(url.searchParams.get('patch') ?? '')
    sendJson(response, 200, await buildRecommendation(patch, parseBuildRequest(url)))
    return
  }

  // Recent Irelia games plus a sampled ban rate, for the stats page.
  if (url.pathname === '/riot/meta') {
    const laneParam = (url.searchParams.get('lane') ?? 'TOP').toUpperCase()
    const lane: OtpRole = laneParam === 'MID' ? 'MID' : 'TOP'
    const patch = String(url.searchParams.get('patch') ?? '')
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 25), 1), 50)
    const sinceHours = Math.max(Number(url.searchParams.get('since') ?? 0), 0)
    sendJson(response, 200, await buildMeta(patch, lane, limit, sinceHours))
    return
  }

  // Per-lane-opponent build profiles for the "every matchup" view.
  if (url.pathname === '/riot/matchups') {
    const laneParam = (url.searchParams.get('lane') ?? 'TOP').toUpperCase()
    const lane: OtpRole = laneParam === 'MID' ? 'MID' : 'TOP'
    const patch = String(url.searchParams.get('patch') ?? '')
    sendJson(response, 200, await buildMatchups(patch, lane))
    return
  }

  // League Client presence: is the client running and is a champ select open?
  if (url.pathname === '/client/status') {
    const lockfilePath = findLockfile(options.lockfilePath)
    sendJson(response, 200, {
      connected: Boolean(lockfilePath),
      lockfilePath: lockfilePath ?? null,
      inChampSelect: lockfilePath ? await hasChampSelect(lockfilePath) : false,
    })
    return
  }

  // Live in-game CS + vision score via Riot's Live Client Data API.
  if (url.pathname === '/live/game') {
    try {
      const data = await getLiveClientData()
      const activeName = data.activePlayer?.summonerName
      const players = data.allPlayers ?? []
      const me = players.find((player) => player.summonerName === activeName)
        ?? players.find((player) => player.championName === 'Irelia')

      const gameTime = data.gameData?.gameTime ?? 0
      const creepScore = me?.scores?.creepScore ?? 0
      const wardScore = me?.scores?.wardScore ?? 0
      const csPerMin = gameTime > 60 ? creepScore / (gameTime / 60) : 0

      // Benchmark the live CS/vision against the cached Irelia pool.
      const cached = await loadCacheWideIreliaMatches()
      const timed = cached.filter((match) => match.duration > 60)
      const avgCsPerMin = timed.length
        ? timed.reduce((sum, match) => sum + match.cs / (match.duration / 60), 0) / timed.length
        : 0
      const avgVisionPerMin = timed.length
        ? timed.reduce((sum, match) => sum + (match.visionScore ?? 0) / (match.duration / 60), 0) / timed.length
        : 0

      sendJson(response, 200, {
        inGame: true,
        gameTime,
        player: me ? {
          summonerName: me.summonerName,
          championName: me.championName,
          team: me.team,
          level: me.level,
          creepScore,
          wardScore,
          kills: me.scores?.kills ?? 0,
          deaths: me.scores?.deaths ?? 0,
          assists: me.scores?.assists ?? 0,
          csPerMin,
        } : null,
        benchmark: { avgCsPerMin, avgVisionPerMin, sampleGames: timed.length },
      })
    } catch {
      sendJson(response, 200, { inGame: false, gameTime: 0, player: null, benchmark: null })
    }
    return
  }

  // How many cached games exist per lane opponent, against the statistical target.
  if (url.pathname === '/riot/coverage') {
    const laneParam = (url.searchParams.get('lane') ?? '').toUpperCase()
    const lane: OtpRole | null = laneParam === 'TOP' || laneParam === 'MID' ? laneParam : null
    const target = Math.min(Math.max(Number(url.searchParams.get('target') ?? MATCHUP_TARGET_GAMES), 1), 500)
    sendJson(response, 200, await computeCoverage(lane, target))
    return
  }

  // Walks the last scan's candidates backwards until every matchup is covered.
  if (url.pathname === '/riot/deepen-stream') {
    const laneParam = (url.searchParams.get('lane') ?? '').toUpperCase()
    const lane: OtpRole | null = laneParam === 'TOP' || laneParam === 'MID' ? laneParam : null
    const target = Math.min(Math.max(Number(url.searchParams.get('target') ?? MATCHUP_TARGET_GAMES), 1), 500)
    const maxRequests = Math.min(Math.max(Number(url.searchParams.get('budget') ?? 400), 20), 2000)
    // focus=<championId> harvests that matchup from the opponent mains' side,
    // which finds rare matchups far faster than walking Irelia histories.
    const focus = Number(url.searchParams.get('focus') ?? 0)
    const send = openEventStream(response)
    const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 15_000)
    try {
      const report = (update: { phase: string; message: string; done: number; total: number }) => {
        send({ type: 'progress', ...update })
      }
      const result = focus > 0
        ? await deepenOpponent(focus, lane, target, report, { maxRequests })
        : await deepenMatchups(lane, target, report, { maxRequests })
      send({ type: 'result', result })
    } catch (error) {
      send({ type: 'error', message: error instanceof Error ? error.message : 'Deepening failed.' })
    } finally {
      clearInterval(heartbeat)
      response.end()
    }
    return
  }

  /**
   * Wipes harvested data to start fresh. Destructive, so it requires an explicit
   * confirm token rather than firing on an accidental request. The user's own
   * roster additions are preserved: this clears evidence, not settings.
   */
  if (url.pathname === '/riot/cache/clear') {
    if (url.searchParams.get('confirm') !== 'DELETE') {
      throw new ApiError('Refusing to clear the cache without confirm=DELETE.', 400)
    }
    const removed = await clearCache({ keepKeys: [CUSTOM_ROSTER_KEY] })
    const filesRemoved = Object.values(removed).reduce((total, count) => total + count, 0)
    sendJson(response, 200, { filesRemoved, removed, kept: ['custom roster'] })
    return
  }

  /**
   * Quality pruning. When the cache outgrows the cap, the lowest-quality matches
   * go first: non-Irelia games, old patches, short games and surplus coverage.
   * Destructive, so it requires an explicit confirm token.
   */
  if (url.pathname === '/riot/cache/prune') {
    // Read-only preview of the quality ranking, for verifying the order.
    if (url.searchParams.get('dry') === '1') {
      const ranked = await rankCacheQuality()
      sendJson(response, 200, { dry: true, worstFirst: ranked.slice(0, 12), totalRanked: ranked.length })
      return
    }
    if (url.searchParams.get('confirm') !== 'PRUNE') {
      throw new ApiError('Refusing to prune without confirm=PRUNE.', 400)
    }
    const underBytes = Math.min(Math.max(Number(url.searchParams.get('under') ?? CACHE_SOFT_LIMIT_BYTES), 1024 * 1024), CACHE_SOFT_LIMIT_BYTES)
    const result = await pruneLowQuality(underBytes)
    sendJson(response, 200, result)
    return
  }

  // Curated priority one-trick roster shown in the Onetrick tab.
  if (url.pathname === '/riot/roster') {
    sendJson(response, 200, { roster: await loadRoster(), curated: PRIORITY_OTPS.length })
    return
  }

  if (url.pathname === '/riot/roster/add') {
    const raw = url.searchParams.get('riotId') ?? ''
    const separator = raw.lastIndexOf('#')
    const gameName = separator > 0 ? raw.slice(0, separator).trim() : ''
    const tagLine = separator > 0 ? raw.slice(separator + 1).trim() : ''
    if (!gameName || !tagLine) throw new ApiError('Give the summoner as Name#TAG.', 400)
    sendJson(response, 200, { roster: await addRosterMember(gameName, tagLine), curated: PRIORITY_OTPS.length })
    return
  }

  if (url.pathname === '/riot/roster/remove') {
    const riotId = url.searchParams.get('riotId') ?? ''
    if (!riotId.trim()) throw new ApiError('Which summoner should be removed?', 400)
    sendJson(response, 200, { roster: await removeRosterMember(riotId), curated: PRIORITY_OTPS.length })
    return
  }

  // Cache stats for the Data Management tab: how much evidence is harvested.
  if (url.pathname === '/riot/stats') {
    const matches = await loadCacheWideIreliaMatches()
    const topCount = matches.filter((match) => match.position === 'TOP').length
    const midCount = matches.filter((match) => match.position === 'MID').length
    const matchupCount = new Set(
      matches.map((match) => match.opponentChampionId).filter((id): id is number => id != null),
    ).size
    const matchFiles = (await listCacheKeys('matches')).length
    const timelineFiles = (await listCacheKeys('timelines')).length
    const size = await cacheSize()
    sendJson(response, 200, {
      matchFiles,
      timelineFiles,
      ireliaGames: matches.length,
      topGames: topCount,
      midGames: midCount,
      matchupCount,
      target: 385,
      cacheBytes: size.total,
      cacheLimitBytes: CACHE_SOFT_LIMIT_BYTES,
    })
    return
  }

  // Streamed scan with progress events.
  if (url.pathname === '/riot/kr-scan-stream') {
    const params = parseScanParams(url)
    const send = openEventStream(response)
    const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 15_000)
    try {
      const result = await runKoreanScan(params.tier, params.entryLimit, params.sampleSize, params.threshold, params.lane, (update) => {
        send({ type: 'progress', ...update })
      }, params.regions, params.minIreliaGames, params.rosterOnly)
      send({ type: 'result', result })
    } catch (error) {
      send({ type: 'error', message: error instanceof Error ? error.message : 'Scan failed.' })
    } finally {
      clearInterval(heartbeat)
      response.end()
    }
    return
  }

  // Single-shot scan (also used as a fallback when SSE is unavailable).
  if (url.pathname === '/riot/kr-scan') {
    const params = parseScanParams(url)
    if (!params.force) {
      const snapshot = await readScanFromDisk(params.tier, params.lane, params.regions)
      if (snapshot) {
        sendJson(response, 200, { ...snapshot, fromCache: true })
        return
      }
    }
    sendJson(response, 200, await runKoreanScan(params.tier, params.entryLimit, params.sampleSize, params.threshold, params.lane, () => {}, params.regions, params.minIreliaGames, params.rosterOnly))
    return
  }

  // Deep, patch-bounded harvest of one chosen OTP's match history.
  if (url.pathname === '/riot/otp-harvest-stream') {
    const gameName = String(url.searchParams.get('gameName') ?? '').trim()
    const tagLine = String(url.searchParams.get('tagLine') ?? '').trim()
    const regionParam = (url.searchParams.get('region') ?? 'KR').toUpperCase()
    const region = (regionParam in scanRegions ? regionParam : 'KR') as ScanRegion
    if (!gameName || !tagLine) throw new ApiError('Give the OTP as Name#TAG.', 400)
    const maxRequests = Math.min(Math.max(Number(url.searchParams.get('budget') ?? 800), 20), 2000)
    const send = openEventStream(response)
    const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 15_000)
    try {
      const report = (update: { phase: string; message: string; done: number; total: number }) => {
        send({ type: 'progress', ...update })
      }
      const result = await harvestPlayer(gameName, tagLine, region, report, { maxRequests })
      send({ type: 'result', result })
    } catch (error) {
      send({ type: 'error', message: error instanceof Error ? error.message : 'OTP harvest failed.' })
    } finally {
      clearInterval(heartbeat)
      response.end()
    }
    return
  }

  // The active OTP of choice plus the archive of previously sourced profiles.
  if (url.pathname === '/riot/otp-profile') {
    const active = await readCache<{ puuid: string; riotId: string; savedAt: number }>('otp', 'active')
    const profiles: Array<OtpProfile> = []
    for (const key of await listCacheKeys('otp')) {
      if (key === 'active') continue
      const profile = await readCache<OtpProfile>('otp', key)
      if (profile) profiles.push(profile)
    }
    profiles.sort((a, b) => b.harvestedAt - a.harvestedAt)
    sendJson(response, 200, { active, profiles })
    return
  }

  // The OTP's build vs everyone else's, with consensus-scored slots.
  if (url.pathname === '/riot/otp-compare') {
    const laneParam = (url.searchParams.get('lane') ?? 'TOP').toUpperCase()
    const lane: OtpRole = laneParam === 'MID' ? 'MID' : 'TOP'
    sendJson(response, 200, await compareOtpToBaseline(lane))
    return
  }

  throw new ApiError('API route not found.', 404)
}

/**
 * A plain node:http request listener for the Riot routes.
 *
 * Deliberately free of any Vite or connect dependency so the desktop server can
 * mount it directly, while the Vite plugin below reuses the exact same handler.
 */
export function createRiotApiListener(options: RiotOptions) {
  return (request: IncomingMessage, response: ServerResponse) => {
    void handleApiRequest(request, response, options).catch((error: unknown) => {
      if (response.headersSent) {
        response.end()
        return
      }
      const statusCode = error instanceof ApiError ? error.statusCode : 502
      const message = error instanceof Error ? error.message : 'Unexpected local API error.'
      sendJson(response, statusCode, { error: message })
    })
  }
}

export function createRiotApiPlugin(options: RiotOptions) {
  return {
    name: 'local-riot-api',
    configureServer(server: ViteDevServer) {
      // connect strips the mount path from request.url before dispatch, which is
      // exactly the shape handleApiRequest expects.
      server.middlewares.use('/api', createRiotApiListener(options))
    },
  }
}
