import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import https from 'node:https'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ViteDevServer } from 'vite'
import {
  aggregateProfile,
  buildMatchData,
  getCachedMatch,
  getPlayerPosition,
} from './buildEngine.js'
import type {
  BuildProfile,
  MatchBuildData,
  MatchRecord,
  OtpRole as EngineOtpRole,
  ProgressReporter,
} from './buildEngine.js'
import { cacheDirectory, readCache, writeCache } from './diskCache.js'

type Routing = 'EUROPE' | 'ASIA' | 'KR' | 'EUN1'
type OtpTier = 'all' | 'challenger' | 'grandmaster' | 'master'
type OtpRole = 'TOP' | 'MID'

type RiotOptions = {
  apiKey?: string
  lockfilePath?: string
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
}

const requestHistory = new Map<Routing, number[]>()
const lastRequestAt = new Map<Routing, number>()
const requestQueues = new Map<Routing, Promise<void>>()
const trackedRoutings: Routing[] = ['EUROPE', 'ASIA', 'KR', 'EUN1']
const localRequestBudget = { perSecond: 18, perTwoMinutes: 90 }

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

  return { localBudget: localRequestBudget, routes, measuredAt: now }
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitForRequestSlot(routing: Routing) {
  const previous = requestQueues.get(routing) ?? Promise.resolve()
  let release = () => {}
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  requestQueues.set(routing, previous.then(() => current))
  await previous

  try {
    while (true) {
      const now = Date.now()
      const recent = (requestHistory.get(routing) ?? []).filter((time) => now - time < 120_000)
      const recentSecond = recent.filter((time) => now - time < 1_000)
      const last = lastRequestAt.get(routing) ?? 0
      const waits = [Math.max(0, last + 75 - now)]

      if (recentSecond.length >= 18) {
        waits.push(recentSecond[0] + 1_000 - now)
      }
      if (recent.length >= 90) {
        waits.push(recent[0] + 120_000 - now)
      }

      const wait = Math.max(...waits)
      if (wait <= 0) {
        const timestamp = Date.now()
        recent.push(timestamp)
        requestHistory.set(routing, recent)
        lastRequestAt.set(routing, timestamp)
        return
      }
      await delay(wait)
    }
  } finally {
    release()
  }
}

async function riotGet<T>(apiKey: string, routing: Routing, endpoint: string): Promise<T> {
  await waitForRequestSlot(routing)
  const response = await fetch(`https://${apiHosts[routing]}${endpoint}`, {
    headers: { 'X-Riot-Token': apiKey },
  })

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('Retry-After') ?? 1)
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
): Promise<PlayerMatchSummary | null> {
  const data = await buildMatchData(fetchJson, match, puuid, { withTimeline })
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
    const match = await getCachedMatch(fetchJson, matchId)
    if (match.info.queueId !== 420) continue
    const summary = await summarizeParticipant(match, puuid, withTimeline)
    if (summary) summaries.push(summary)
  }
  summaries.sort((a, b) => b.gameCreation - a.gameCreation)
  return summaries
}

/* ------------------------------------------------------------------ *
 * KR OTP scan
 * ------------------------------------------------------------------ */

const tierPriority: Record<Exclude<OtpTier, 'all'>, number> = { challenger: 3, grandmaster: 2, master: 1 }
const leaguePaths: Record<Exclude<OtpTier, 'all'>, string> = {
  challenger: '/lol/league/v4/challengerleagues/by-queue/RANKED_SOLO_5x5',
  grandmaster: '/lol/league/v4/grandmasterleagues/by-queue/RANKED_SOLO_5x5',
  master: '/lol/league/v4/masterleagues/by-queue/RANKED_SOLO_5x5',
}

type Candidate = {
  puuid: string
  tier: Exclude<OtpTier, 'all'>
  leaguePoints: number
  masteryPoints: number
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
  tier: Exclude<OtpTier, 'all'>
  leaguePoints: number
  ireliaMasteryPoints: number
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
  threshold: number
  candidatePoolSize: number
  masteryCandidates: number
  deepenedCandidates: number
  cacheHits: number
  analyzed: ScannedCandidate[]
  note: string
}

const latestScanByKey = new Map<string, ScanResult>()

function scanCacheKey(tier: OtpTier, lane: OtpRole | null) {
  return `${tier}:${lane ?? 'ALL'}`
}

async function readScanFromDisk(tier: OtpTier, lane: OtpRole | null) {
  return readCache<ScanResult>('scans', scanCacheKey(tier, lane))
}

function collectIreliaMatches(matches: MatchBuildData[], role: EngineOtpRole | null) {
  return matches.filter((match) =>
    match.championId === IRELIA_ID && match.position !== 'UNKNOWN' && (role === null || match.position === role),
  )
}

function buildCandidateResult(candidate: {
  puuid: string
  tier: Exclude<OtpTier, 'all'>
  leaguePoints: number
  masteryPoints: number
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
    tier: candidate.tier,
    leaguePoints: candidate.leaguePoints,
    ireliaMasteryPoints: candidate.masteryPoints,
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
 * Runs a full KR scan. All match and timeline bodies are cached on disk, so a
 * repeat scan of the same tier/lane mostly reads from disk. Progress is emitted
 * through the supplied reporter so the UI can stream a live status.
 */
export async function runKoreanScan(
  tier: OtpTier,
  entryLimit: number,
  sampleSize: number,
  threshold: number,
  lane: OtpRole | null,
  report: ProgressReporter,
): Promise<ScanResult> {
  const tierValues: Array<Exclude<OtpTier, 'all'>> = tier === 'all'
    ? ['challenger', 'grandmaster', 'master']
    : [tier]

  report({ phase: 'ladder', message: 'Reading KR tier ladders…', done: 0, total: tierValues.length })
  const leagueEntries: Array<{ puuid: string; leaguePoints: number; rank: string; tier: Exclude<OtpTier, 'all'> }> = []
  for (const [index, tierValue] of tierValues.entries()) {
    const league = await riotGet<{ entries: Array<{ puuid: string; leaguePoints: number; rank: string }> }>(
      getActiveApiKey(),
      'KR',
      leaguePaths[tierValue],
    )
    leagueEntries.push(
      ...[...league.entries]
        .sort((a, b) => b.leaguePoints - a.leaguePoints)
        .slice(0, entryLimit)
        .map((entry) => ({ ...entry, tier: tierValue })),
    )
    report({ phase: 'ladder', message: `Read ${tierValue} ladder`, done: index + 1, total: tierValues.length })
  }

  const entries = [...new Map(leagueEntries.map((entry) => [entry.puuid, entry])).values()]

  report({ phase: 'mastery', message: 'Checking Irelia mastery on ladder accounts…', done: 0, total: entries.length })
  const candidates: Candidate[] = []
  for (const [index, entry] of entries.entries()) {
    if (entry.puuid) {
      try {
        const masteries = await riotGet<Array<{ championId: number; championPoints: number }>>(
          getActiveApiKey(),
          'KR',
          `/lol/champion-mastery/v4/champion-masteries/by-puuid/${encodeURIComponent(entry.puuid)}?count=10`,
        )
        const ireliaMastery = masteries.find((mastery) => mastery.championId === IRELIA_ID)
        if (ireliaMastery) {
          candidates.push({
            puuid: entry.puuid,
            tier: entry.tier,
            leaguePoints: entry.leaguePoints,
            masteryPoints: ireliaMastery.championPoints,
          })
        }
      } catch (error) {
        if (!(error instanceof ApiError) || error.statusCode !== 404) throw error
      }
    }
    report({ phase: 'mastery', message: `Checked ${index + 1}/${entries.length} accounts`, done: index + 1, total: entries.length })
  }

  // Deep pull: every candidate gets a full recent ranked pull. Each match and
  // timeline is cached to disk, so future scans and matchup lookups are instant.
  const totalScanSlots = candidates.reduce((total) => total + sampleSize + 1, 0)
  let scannedSlots = 0
  let cacheHits = 0
  const scanned: Array<{
    puuid: string
    tier: Exclude<OtpTier, 'all'>
    leaguePoints: number
    masteryPoints: number
    name: string
    matches: MatchBuildData[]
  }> = []

  report({ phase: 'matches', message: 'Pulling recent ranked games for each candidate…', done: 0, total: totalScanSlots })
  for (const candidate of candidates) {
    const matchIds = await riotGet<string[]>(
      getActiveApiKey(),
      'ASIA',
      `/lol/match/v5/matches/by-puuid/${encodeURIComponent(candidate.puuid)}/ids?queue=420&count=${sampleSize}`,
    )
    scannedSlots += 1
    const matches: MatchBuildData[] = []
    let name = `KR ${candidate.tier} candidate`
    for (const matchId of matchIds) {
      const alreadyCached = await readCache<MatchRecord>('matches', matchId)
      const match = await getCachedMatch(fetchJson, matchId)
      if (alreadyCached) cacheHits += 1
      if (match.info.queueId !== 420) {
        scannedSlots += 1
        continue
      }
      const data = await buildMatchData(fetchJson, match, candidate.puuid, { withTimeline: true })
      if (data) matches.push(data)
      const player = match.info.participants.find((entry) => entry.puuid === candidate.puuid)
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

  const analyzed = scanned
    .map((candidate) => buildCandidateResult(candidate, threshold))
    .sort((first, second) =>
      Number(second.isOtp) - Number(first.isOtp)
      || second.ireliaShare - first.ireliaShare
      || second.winRate - first.winRate
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

  const result: ScanResult = {
    scannedAt: Date.now(),
    tier,
    lane,
    threshold,
    candidatePoolSize: entries.length,
    masteryCandidates: candidates.length,
    deepenedCandidates: scanned.length,
    cacheHits,
    analyzed: laneFiltered,
    note: lane
      ? `Bounded KR ${lane} sample: screened ${candidates.length} Irelia-mastery accounts, analyzed ${scanned.length}. Results are cached on disk; refresh to pull the latest games.`
      : `Bounded KR sample across TOP and MID: screened ${candidates.length} Irelia-mastery accounts, analyzed ${scanned.length}. Verified OTPs rank first. Cached on disk; refresh to pull the latest games.`,
  }

  latestScanByKey.set(scanCacheKey(tier, lane), result)
  await writeCache('scans', scanCacheKey(tier, lane), result)
  if (lane === null) {
    await writeCache('scans', 'latest', { key: scanCacheKey(tier, lane), scannedAt: result.scannedAt })
  }
  report({ phase: 'done', message: `Scan complete · ${laneFiltered.length} candidates · ${cacheHits} cached matches reused`, done: totalScanSlots, total: totalScanSlots })
  return result
}

async function loadStoredScan(): Promise<ScanResult | null> {
  const pointer = await readCache<{ key: string; scannedAt: number }>('scans', 'latest')
  if (!pointer) return null
  const stored = await readCache<ScanResult>('scans', pointer.key)
  if (stored) latestScanByKey.set(pointer.key, stored)
  return stored
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
}

function collectVerifiedMatches(scan: ScanResult | null, lane: OtpRole) {
  if (!scan) return [] as MatchBuildData[]
  const out: MatchBuildData[] = []
  scan.analyzed
    .filter((candidate) => candidate.isOtp)
    .forEach((candidate) => {
      collectIreliaMatches(candidate.matches, lane).forEach((match) => out.push(match))
    })
  return out
}

export async function buildRecommendation(patch: string, request: BuildRequest): Promise<BuildResponse> {
  const scan = latestScanByKey.get(scanCacheKey('all', null)) ?? await loadStoredScan()
  const lane = request.lane
  const verified = collectVerifiedMatches(scan, lane)
  const exact = patch ? verified.filter((match) => match.patch === patch) : verified
  const patchExact = patch ? exact.length > 0 : false
  const pool = patchExact ? exact : verified

  let matches: MatchBuildData[]
  let reason: string
  if (request.source === 'lane') {
    if (!request.opponent) {
      matches = []
      reason = 'Pick a lane opponent to see matchup-specific builds.'
    } else {
      matches = pool.filter((match) => match.opponentChampionId === request.opponent)
      reason = matches.length
        ? `Games where KR Irelia OTPs faced your lane opponent${patchExact ? ` on patch ${patch}` : ' (most recent patch with data)'}.`
        : 'No verified KR OTP games against this opponent in the current sample yet. Scan again or try the composition view.'
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
      : 'No verified KR OTP games overlap this composition yet.'
  }

  return {
    source: request.source,
    lane,
    patch,
    patchExact,
    games: matches.length,
    profile: aggregateProfile(matches, request.source),
    reason,
  }
}

/* ------------------------------------------------------------------ *
 * Static (Data Dragon) data
 * ------------------------------------------------------------------ */

const staticDataCache = new Map<string, { expiresAt: number; value: unknown }>()

async function getStaticData() {
  const cacheKey = 'static-data'
  const cached = staticDataCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.value

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
    champions: Object.values(championData.data)
      .map((champion) => ({ id: Number(champion.key), name: champion.name }))
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
  if (!['all', 'challenger', 'grandmaster', 'master'].includes(tierValue)) {
    throw new ApiError('Tier must be all, challenger, grandmaster, or master.', 400)
  }
  const defaultLimit = tierValue === 'all' ? 9 : 8
  const entryLimit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? defaultLimit), 1), 40)
  const sampleSize = Math.min(Math.max(Number(url.searchParams.get('sampleSize') ?? 20), 1), 20)
  const threshold = Math.min(Math.max(Number(url.searchParams.get('threshold') ?? 0.5), 0.3), 1)
  const laneParam = (url.searchParams.get('lane') ?? '').toUpperCase()
  const lane: OtpRole | null = laneParam === 'TOP' || laneParam === 'MID' ? laneParam : null
  const force = url.searchParams.get('refresh') === '1'
  return { tier: tierValue as OtpTier, entryLimit, sampleSize, threshold, lane, force }
}

async function handleApiRequest(request: IncomingMessage, response: ServerResponse, options: RiotOptions) {
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
    const scan = latestScanByKey.get(scanCacheKey('all', null)) ?? await loadStoredScan()
    sendJson(response, 200, { scan })
    return
  }

  // Matchup / composition build recommendation built from the saved scan.
  if (url.pathname === '/riot/build') {
    const patch = String(url.searchParams.get('patch') ?? '')
    sendJson(response, 200, await buildRecommendation(patch, parseBuildRequest(url)))
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
      })
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
      const snapshot = latestScanByKey.get(scanCacheKey(params.tier, params.lane))
        ?? await readScanFromDisk(params.tier, params.lane)
      if (snapshot) {
        sendJson(response, 200, { ...snapshot, fromCache: true })
        return
      }
    }
    sendJson(response, 200, await runKoreanScan(params.tier, params.entryLimit, params.sampleSize, params.threshold, params.lane, () => {}))
    return
  }

  throw new ApiError('API route not found.', 404)
}

export function createRiotApiPlugin(options: RiotOptions) {
  return {
    name: 'local-riot-api',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api', (request, response) => {
        void handleApiRequest(request, response, options).catch((error: unknown) => {
          if (response.headersSent) {
            response.end()
            return
          }
          const statusCode = error instanceof ApiError ? error.statusCode : 502
          const message = error instanceof Error ? error.message : 'Unexpected local API error.'
          sendJson(response, statusCode, { error: message })
        })
      })
    },
  }
}
