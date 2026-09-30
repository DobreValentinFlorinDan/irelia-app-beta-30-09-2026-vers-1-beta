import { dedupe, readCache, writeCache } from './diskCache.js'

export type Routing = 'EUROPE' | 'ASIA' | 'KR' | 'EUN1'
export type OtpRole = 'TOP' | 'MID'
export type OtpTier = 'all' | 'challenger' | 'grandmaster' | 'master'

export type MatchRecord = {
  metadata: { matchId: string }
  info: {
    queueId: number
    gameVersion: string
    gameCreation: number
    participants: Array<Record<string, any>>
  }
}

export type TimelineRecord = {
  info: { frames: Array<{ timestamp: number; events: Array<Record<string, any>> }> }
}

/** Data-fetching primitives the engine depends on, injected by riotApi.ts. */
export type RiotFetch = <T>(routing: Routing, endpoint: string) => Promise<T>

export type ProgressReporter = (update: { phase: string; message: string; done: number; total: number }) => void

/* ------------------------------------------------------------------ *
 * Cached primitives
 * ------------------------------------------------------------------ */

export async function getCachedMatch(fetchJson: RiotFetch, matchId: string) {
  const cached = await readCache<MatchRecord>('matches', matchId)
  if (cached) return cached
  return dedupe(`match:${matchId}`, async () => {
    const fromDisk = await readCache<MatchRecord>('matches', matchId)
    if (fromDisk) return fromDisk
    const match = await fetchJson<MatchRecord>('ASIA', `/lol/match/v5/matches/${encodeURIComponent(matchId)}`)
    await writeCache('matches', matchId, match)
    return match
  })
}

export async function getCachedTimeline(fetchJson: RiotFetch, matchId: string) {
  const cached = await readCache<TimelineRecord>('timelines', matchId)
  if (cached) return cached
  return dedupe(`timeline:${matchId}`, async () => {
    const fromDisk = await readCache<TimelineRecord>('timelines', matchId)
    if (fromDisk) return fromDisk
    const timeline = await fetchJson<TimelineRecord>('ASIA', `/lol/match/v5/matches/${encodeURIComponent(matchId)}/timeline`)
    await writeCache('timelines', matchId, timeline)
    return timeline
  })
}

/* ------------------------------------------------------------------ *
 * Participant helpers
 * ------------------------------------------------------------------ */

export function getPlayerPosition(player: Record<string, any>) {
  const position = [player.teamPosition, player.individualPosition]
    .map((value) => String(value ?? '').toUpperCase())
    .find((value) => value && value !== 'UNKNOWN' && value !== 'NONE') ?? ''
  if (position === 'MIDDLE') return 'MID'
  if (position === 'BOTTOM') return 'BOT'
  if (position === 'UTILITY') return 'SUPPORT'
  return position || 'UNKNOWN'
}

export function getOtpRole(player: Record<string, any>): OtpRole | null {
  const position = getPlayerPosition(player)
  return position === 'TOP' || position === 'MID' ? position : null
}

function participantOf(match: MatchRecord, puuid: string) {
  return match.info.participants.find((entry) => entry.puuid === puuid)
}

function opponentOf(match: MatchRecord, player: Record<string, any>) {
  return match.info.participants.find(
    (entry) => entry.teamId !== player.teamId && getPlayerPosition(entry) === getPlayerPosition(player),
  )
}

/* ------------------------------------------------------------------ *
 * Timeline extraction
 * ------------------------------------------------------------------ */

export type PurchaseEvent = { id: number; minute: number }
export type MatchBuildData = {
  matchId: string
  win: boolean
  championId: number
  position: string
  patch: string
  gameCreation: number
  opponentChampionId: number | null
  allyChampionIds: number[]
  enemyChampionIds: number[]
  finalItems: number[]
  lanePurchases: PurchaseEvent[]
  skillOrder: string
  spells: number[]
  primaryStyle: number | null
  secondaryStyle: number | null
  keystoneId: number | null
  runeIds: number[]
  kills: number
  deaths: number
  assists: number
}

const PURCHASE_WINDOW_MS = 20 * 60_000

export async function buildMatchData(
  fetchJson: RiotFetch,
  match: MatchRecord,
  puuid: string,
  options: { withTimeline: boolean },
): Promise<MatchBuildData | null> {
  const player = participantOf(match, puuid)
  if (!player) return null
  const opponent = opponentOf(match, player)
  const primaryStyle = player.perks?.styles?.[0]
  const secondaryStyle = player.perks?.styles?.[1]

  const data: MatchBuildData = {
    matchId: match.metadata.matchId,
    win: Boolean(player.win),
    championId: player.championId,
    position: getPlayerPosition(player),
    patch: String(match.info.gameVersion ?? '').split('.').slice(0, 2).join('.'),
    gameCreation: Number(match.info.gameCreation ?? 0),
    opponentChampionId: opponent?.championId ?? null,
    allyChampionIds: match.info.participants
      .filter((entry) => entry.teamId === player.teamId && entry.puuid !== puuid)
      .map((entry) => entry.championId),
    enemyChampionIds: match.info.participants
      .filter((entry) => entry.teamId !== player.teamId)
      .map((entry) => entry.championId),
    finalItems: [0, 1, 2, 3, 4, 5].map((index) => player[`item${index}`]).filter((id) => id > 0),
    lanePurchases: [],
    skillOrder: '',
    spells: [player.summoner1Id, player.summoner2Id].filter((id) => typeof id === 'number' && id > 0).sort((a, b) => a - b),
    primaryStyle: primaryStyle?.style ?? null,
    secondaryStyle: secondaryStyle?.style ?? null,
    keystoneId: primaryStyle?.selections?.[0]?.perk ?? null,
    runeIds: (player.perks?.styles ?? []).flatMap((style: any) =>
      (style.selections ?? []).map((selection: { perk: number }) => selection.perk),
    ),
    kills: player.kills,
    deaths: player.deaths,
    assists: player.assists,
  }

  if (!options.withTimeline) return data

  try {
    const timeline = await getCachedTimeline(fetchJson, match.metadata.matchId)
    const participantId = player.participantId
    const events = timeline.info.frames.flatMap((frame) => frame.events)
    data.lanePurchases = events
      .filter((event) =>
        event.type === 'ITEM_PURCHASED'
        && event.participantId === participantId
        && event.timestamp <= PURCHASE_WINDOW_MS,
      )
      .map((event) => ({ id: event.itemId as number, minute: Math.floor(event.timestamp / 60_000) }))
    data.skillOrder = events
      .filter((event) => event.type === 'SKILL_LEVEL_UP' && event.participantId === participantId)
      .sort((first, second) => first.timestamp - second.timestamp)
      .map((event) => event.skillSlot as number)
      .join('')
  } catch {
    // Timeline unavailable; the rest of the match data is still useful.
  }

  return data
}

/* ------------------------------------------------------------------ *
 * Build aggregation
 * ------------------------------------------------------------------ */

export type ItemShare = { id: number; games: number; winRate: number; averageMinute: number | null }
export type RuneShare = { id: number; games: number }
export type SpellShare = { ids: number[]; games: number; winRate: number }
export type SkillOrderShare = { order: string; games: number }

export type BuildProfile = {
  source: 'lane' | 'comp'
  games: number
  wins: number
  winRate: number
  startingItems: ItemShare[]
  boots: ItemShare[]
  coreItems: ItemShare[]
  fullItems: ItemShare[]
  purchasePath: ItemShare[]
  skillOrder: SkillOrderShare[]
  spells: SpellShare[]
  primaryStyles: RuneShare[]
  secondaryStyles: RuneShare[]
  keystones: RuneShare[]
  runeShards: RuneShare[]
}

function itemAggregate(matches: MatchBuildData[], pick: (match: MatchBuildData) => number[]) {
  const counts = new Map<number, { games: number; wins: number }>()
  matches.forEach((match) => {
    new Set(pick(match)).forEach((id) => {
      const current = counts.get(id) ?? { games: 0, wins: 0 }
      current.games += 1
      if (match.win) current.wins += 1
      counts.set(id, current)
    })
  })
  return [...counts.entries()]
    .map(([id, value]) => ({ id, games: value.games, winRate: value.games ? value.wins / value.games : 0, averageMinute: null as number | null }))
    .sort((a, b) => b.games - a.games)
}

/** Aggregate items where each match contributes at most one id (e.g. a boots slot). */
function singleItemAggregate(matches: MatchBuildData[], pick: (match: MatchBuildData) => number | null) {
  const counts = new Map<number, { games: number; wins: number }>()
  matches.forEach((match) => {
    const id = pick(match)
    if (id === null) return
    const current = counts.get(id) ?? { games: 0, wins: 0 }
    current.games += 1
    if (match.win) current.wins += 1
    counts.set(id, current)
  })
  return [...counts.entries()]
    .map(([id, value]) => ({ id, games: value.games, winRate: value.games ? value.wins / value.games : 0, averageMinute: null as number | null }))
    .sort((a, b) => b.games - a.games)
}

function purchasePathAggregate(matches: MatchBuildData[]) {
  const groups = new Map<number, { matches: Set<string>; totalMinute: number; wins: number }>()
  matches.forEach((match) => {
    const earliest = new Map<number, number>()
    match.lanePurchases.forEach(({ id, minute }) => {
      const current = earliest.get(id)
      if (current === undefined || minute < current) earliest.set(id, minute)
    })
    earliest.forEach((minute, id) => {
      const group = groups.get(id) ?? { matches: new Set<string>(), totalMinute: 0, wins: 0 }
      if (!group.matches.has(match.matchId)) {
        group.matches.add(match.matchId)
        group.totalMinute += minute
        if (match.win) group.wins += 1
      }
      groups.set(id, group)
    })
  })
  return [...groups.entries()]
    .map(([id, value]) => ({
      id,
      games: value.matches.size,
      winRate: value.matches.size ? value.wins / value.matches.size : 0,
      averageMinute: value.matches.size ? value.totalMinute / value.matches.size : 0,
    }))
    .sort((a, b) => (a.averageMinute ?? 0) - (b.averageMinute ?? 0) || b.games - a.games)
}

function runeTreeAggregate(matches: MatchBuildData[], pick: (match: MatchBuildData) => number | null) {
  const counts = new Map<number, number>()
  matches.forEach((match) => {
    const value = pick(match)
    if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1)
  })
  return [...counts.entries()]
    .map(([id, games]) => ({ id, games }))
    .sort((a, b) => b.games - a.games)
}

function runeAggregate(matches: MatchBuildData[]) {
  const counts = new Map<number, number>()
  matches.forEach((match) => {
    new Set(match.runeIds).forEach((id) => counts.set(id, (counts.get(id) ?? 0) + 1))
  })
  return [...counts.entries()]
    .map(([id, games]) => ({ id, games }))
    .sort((a, b) => b.games - a.games)
}

function spellAggregate(matches: MatchBuildData[]) {
  const counts = new Map<string, { ids: number[]; games: number; wins: number }>()
  matches.forEach((match) => {
    if (!match.spells.length) return
    const key = match.spells.join('|')
    const current = counts.get(key) ?? { ids: match.spells, games: 0, wins: 0 }
    current.games += 1
    if (match.win) current.wins += 1
    counts.set(key, current)
  })
  return [...counts.values()]
    .map((value) => ({ ids: value.ids, games: value.games, winRate: value.games ? value.wins / value.games : 0 }))
    .sort((a, b) => b.games - a.games)
}

function skillOrderAggregate(matches: MatchBuildData[]) {
  const counts = new Map<string, number>()
  matches.forEach((match) => {
    if (match.skillOrder.length >= 6) counts.set(match.skillOrder, (counts.get(match.skillOrder) ?? 0) + 1)
  })
  return [...counts.entries()]
    .map(([order, games]) => ({ order, games }))
    .sort((a, b) => b.games - a.games)
}

export function aggregateProfile(matches: MatchBuildData[], source: 'lane' | 'comp'): BuildProfile {
  const wins = matches.filter((match) => match.win).length
  const withPurchases = matches.filter((match) => match.lanePurchases.length > 0)
  const bootIds = new Set([3006, 3009, 3020, 3047, 3111, 3117, 3153, 3172])

  return {
    source,
    games: matches.length,
    wins,
    winRate: matches.length ? wins / matches.length : 0,
    startingItems: itemAggregate(matches, (match) => match.lanePurchases.filter((purchase) => purchase.minute <= 2).map((purchase) => purchase.id)).slice(0, 4),
    boots: singleItemAggregate(matches, (match) => match.finalItems.find((id) => bootIds.has(id)) ?? null).slice(0, 3),
    coreItems: itemAggregate(matches, (match) => match.lanePurchases.map((purchase) => purchase.id)).slice(0, 8),
    fullItems: itemAggregate(matches, (match) => match.finalItems).slice(0, 8),
    purchasePath: withPurchases.length ? purchasePathAggregate(withPurchases) : [],
    skillOrder: skillOrderAggregate(matches).slice(0, 4),
    spells: spellAggregate(matches).slice(0, 4),
    primaryStyles: runeTreeAggregate(matches, (match) => match.primaryStyle).slice(0, 2),
    secondaryStyles: runeTreeAggregate(matches, (match) => match.secondaryStyle).slice(0, 2),
    keystones: runeTreeAggregate(matches, (match) => match.keystoneId).slice(0, 4),
    runeShards: runeAggregate(matches).slice(0, 8),
  }
}

/** Keeps the starting-item helper honest for empty input. */
export function hasEarlyItems(profile: BuildProfile) {
  return profile.startingItems.length > 0
}
