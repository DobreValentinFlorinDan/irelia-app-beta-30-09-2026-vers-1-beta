import { dedupe, listCacheKeys, readCache, writeCache } from './diskCache.js'

export type Routing = 'EUROPE' | 'ASIA' | 'KR' | 'EUN1' | 'AMERICAS' | 'EUW1' | 'NA1'
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

export async function getCachedMatch(fetchJson: RiotFetch, matchId: string, routing: Routing = 'ASIA') {
  const cached = await readCache<MatchRecord>('matches', matchId)
  if (cached) {
    noteIreliaMatch(cached)
    return cached
  }
  return dedupe(`match:${matchId}`, async () => {
    const fromDisk = await readCache<MatchRecord>('matches', matchId)
    if (fromDisk) {
      noteIreliaMatch(fromDisk)
      return fromDisk
    }
    const match = await fetchJson<MatchRecord>(routing, `/lol/match/v5/matches/${encodeURIComponent(matchId)}`)
    await writeCache('matches', matchId, match)
    noteIreliaMatch(match)
    return match
  })
}

export async function getCachedTimeline(fetchJson: RiotFetch, matchId: string, routing: Routing = 'ASIA') {
  const cached = await readCache<TimelineRecord>('timelines', matchId)
  if (cached) return cached
  return dedupe(`timeline:${matchId}`, async () => {
    const fromDisk = await readCache<TimelineRecord>('timelines', matchId)
    if (fromDisk) return fromDisk
    const timeline = await fetchJson<TimelineRecord>(routing, `/lol/match/v5/matches/${encodeURIComponent(matchId)}/timeline`)
    // The full timeline is ~680 KB per game but we only ever read three things:
    // item-purchase events, skill level-ups, and the 15-minute lane frame.
    // Store only those; the raw frame-by-frame combat log is never used again.
    const trimmed = trimTimeline(timeline)
    await writeCache('timelines', matchId, trimmed)
    return trimmed
  })
}

/**
 * Collapses a full match timeline to the fields the build engine actually
 * consumes: ITEM_PURCHASED and SKILL_LEVEL_UP events (all frames) plus the
 * 15-minute participantFrames (for lane gold/xp/cs differentials). Everything
 * else — the combat log, champion-kill events, per-frame positions — is dropped.
 * This turns a ~680 KB payload into ~15 KB.
 */
export function trimTimeline(record: TimelineRecord): TimelineRecord {
  const frames = record.info.frames
  const fifteenMinuteIndex = frames.findIndex((frame) => frame.timestamp >= 15 * 60_000)
  return {
    info: {
      frames: frames.map((frame, index) => {
        const raw = frame as Record<string, unknown>
        const events = Array.isArray(raw.events)
          ? (raw.events as Array<Record<string, unknown>>).filter((event) =>
            event.type === 'ITEM_PURCHASED' || event.type === 'SKILL_LEVEL_UP')
          : []
        const keepParticipantFrames = index === fifteenMinuteIndex && raw.participantFrames
        return {
          timestamp: frame.timestamp,
          events,
          ...(keepParticipantFrames ? { participantFrames: raw.participantFrames } : {}),
        }
      }),
    },
  }
}

/** Whether a cached timeline is already trimmed (participantFrames only on the 15-min frame). */
export function isTrimmedTimeline(record: TimelineRecord): boolean {
  let framesWithParticipants = 0
  for (const frame of record.info.frames) {
    if ((frame as Record<string, unknown>).participantFrames) framesWithParticipants += 1
    if (framesWithParticipants > 1) return false
  }
  return true
}

/**
 * One-time compaction of the timeline cache: trims every cached timeline that
 * still holds the full combat log. Runs in the background at startup so an
 * existing multi-hundred-megabyte cache shrinks without blocking requests.
 */
export async function compactTimelineCache(onProgress?: (message: string) => void): Promise<number> {
  const keys = await listCacheKeys('timelines')
  let trimmed = 0
  for (const key of keys) {
    const record = await readCache<TimelineRecord>('timelines', key)
    if (!record || isTrimmedTimeline(record)) continue
    await writeCache('timelines', key, trimTimeline(record))
    trimmed += 1
    if (onProgress && trimmed % 100 === 0) onProgress(`Compacted ${trimmed} timelines…`)
  }
  return trimmed
}

/* ------------------------------------------------------------------ *
 * Irelia index (which cached matches contain an Irelia participant)
 * ------------------------------------------------------------------ */

const IRELIA_CHAMPION_ID = 39
const IRELIA_INDEX_KEY = 'irelia-index'

type IreliaIndexFile = { ids: string[]; updatedAt: number }

const ireliaIndex = {
  ids: new Set<string>(),
  loaded: false,
  dirty: false,
  flushing: null as Promise<void> | null,
  timer: null as ReturnType<typeof setTimeout> | null,
}

async function ensureIreliaIndexLoaded() {
  if (ireliaIndex.loaded) return
  ireliaIndex.loaded = true
  const stored = await readCache<IreliaIndexFile>('scans', IRELIA_INDEX_KEY)
  if (stored?.ids) stored.ids.forEach((id) => ireliaIndex.ids.add(id))
}

/** Records a match id in the Irelia index when the match has an Irelia player. */
function noteIreliaMatch(record: MatchRecord) {
  if (!record?.info?.participants) return
  if (record.info.queueId !== 420) return
  const hasIrelia = record.info.participants.some((entry) => entry.championId === IRELIA_CHAMPION_ID)
  if (!hasIrelia) return
  const id = record.metadata?.matchId
  if (!id || ireliaIndex.ids.has(id)) return
  ireliaIndex.ids.add(id)
  ireliaIndex.dirty = true
  scheduleIreliaFlush()
}

/** Debounced persistence so we do not rewrite the index for every match. */
function scheduleIreliaFlush() {
  if (ireliaIndex.timer) return
  ireliaIndex.timer = setTimeout(() => {
    ireliaIndex.timer = null
    void flushIreliaIndex()
  }, 1_000)
}

/** Persists the Irelia index to disk. Safe to call repeatedly. */
export async function flushIreliaIndex(): Promise<void> {
  await ensureIreliaIndexLoaded()
  if (!ireliaIndex.dirty) return
  if (ireliaIndex.flushing) return ireliaIndex.flushing
  ireliaIndex.dirty = false
  const payload: IreliaIndexFile = { ids: [...ireliaIndex.ids], updatedAt: Date.now() }
  ireliaIndex.flushing = writeCache('scans', IRELIA_INDEX_KEY, payload).finally(() => {
    ireliaIndex.flushing = null
  })
  return ireliaIndex.flushing
}

/** Returns the cached match ids that are known to contain an Irelia player. */
export async function getIreliaMatchIds(): Promise<string[]> {
  await ensureIreliaIndexLoaded()
  return [...ireliaIndex.ids]
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

/** Lane-phase differentials pulled from the match timeline. */
export type LaneDeltas = {
  goldDiff15: number | null
  xpDiff15: number | null
  csDiff15: number | null
}

export type MatchBuildData = {
  matchId: string
  win: boolean
  championId: number
  position: string
  patch: string
  gameCreation: number
  region: string | null
  queueId: number | null
  /** Match length in seconds. */
  duration: number
  /** Riot ID of the Irelia player, e.g. "Dobrezaur#1733". */
  summonerName: string | null
  opponentChampionId: number | null
  /** Riot ID of the lane opponent, for the "VS" row. */
  opponentName: string | null
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
  /** Minions + neutral monsters killed. */
  cs: number
  /** (kills + assists) / team kills. */
  killParticipation: number | null
  visionScore: number | null
  /** Total seconds the player was dead, useful for tempo reads. */
  totalTimeSpentDead: number | null
  laneDeltas: LaneDeltas
}

export type BuildMatchOptions = { withTimeline: boolean; region?: string | null; routing?: Routing }

const PURCHASE_WINDOW_MS = 20 * 60_000

/**
 * Share of the player's team kills they participated in. Riot exposes this as a
 * challenge on modern matches; older payloads are computed from team totals.
 */
function killParticipationOf(match: MatchRecord, player: Record<string, any>): number | null {
  const fromChallenge = player?.challenges?.killParticipation
  if (typeof fromChallenge === 'number' && Number.isFinite(fromChallenge)) return fromChallenge

  const teamKills = match.info.participants
    .filter((entry) => entry.teamId === player.teamId)
    .reduce((total, entry) => total + Number(entry.kills ?? 0), 0)
  if (!teamKills) return null
  return (Number(player.kills ?? 0) + Number(player.assists ?? 0)) / teamKills
}

/** Builds "GameName#TAG" from the Riot ID fields, tolerating older payloads. */
function riotIdOf(player: Record<string, any>): string | null {
  const gameName = player?.riotIdGameName ?? player?.summonerName
  if (!gameName) return null
  const tagLine = player?.riotIdTagline
  return tagLine ? `${gameName}#${tagLine}` : String(gameName)
}

/**
 * Diffs the player against their lane opponent at the 15-minute mark.
 *
 * The timeline carries per-minute participant frames, so this is a direct read
 * rather than an estimate. Returns nulls when the frame or opponent is absent
 * (short games, remakes, or a missing timeline).
 */
function laneDeltasAt15(timeline: TimelineRecord, playerId: number, opponentId: number | undefined): LaneDeltas {
  const empty: LaneDeltas = { goldDiff15: null, xpDiff15: null, csDiff15: null }
  if (!opponentId) return empty

  const frame = timeline.info.frames.find((entry) => entry.timestamp >= 15 * 60_000)
  if (!frame) return empty

  const frames = (frame as { participantFrames?: Record<string, any> }).participantFrames
  const mine = frames?.[String(playerId)]
  const theirs = frames?.[String(opponentId)]
  if (!mine || !theirs) return empty

  const difference = (a: unknown, b: unknown) =>
    typeof a === 'number' && typeof b === 'number' ? a - b : null

  return {
    goldDiff15: difference(mine.totalGold, theirs.totalGold),
    xpDiff15: difference(mine.xp, theirs.xp),
    csDiff15: difference(mine.minionsKilled, theirs.minionsKilled),
  }
}

export async function buildMatchData(
  fetchJson: RiotFetch,
  match: MatchRecord,
  puuid: string,
  options: BuildMatchOptions,
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
    region: options.region ?? null,
    queueId: typeof match.info.queueId === 'number' ? match.info.queueId : null,
    duration: Number(player.timePlayed ?? match.info.gameDuration ?? 0),
    summonerName: riotIdOf(player),
    opponentChampionId: opponent?.championId ?? null,
    opponentName: opponent ? riotIdOf(opponent) : null,
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
    cs: Number(player.totalMinionsKilled ?? 0) + Number(player.neutralMinionsKilled ?? 0),
    killParticipation: killParticipationOf(match, player),
    visionScore: typeof player.visionScore === 'number' ? player.visionScore : null,
    totalTimeSpentDead: typeof player.totalTimeSpentDead === 'number' ? player.totalTimeSpentDead : null,
    laneDeltas: { goldDiff15: null, xpDiff15: null, csDiff15: null },
  }

  if (!options.withTimeline) return data

  try {
    const timeline = await getCachedTimeline(fetchJson, match.metadata.matchId, options.routing ?? 'ASIA')
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
    data.laneDeltas = laneDeltasAt15(timeline, participantId, opponent?.participantId)
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
  /**
   * The complete "Starting Items -> finished build" sequence. Always populated
   * whenever the sample contains purchases, so the UI can render a full path
   * rather than a partial one.
   */
  fullBuild: ItemShare[]
  /**
   * Slot-by-slot build order with per-slot option shares: what gets finished
   * first, second, third, and what the later slots branch into.
   */
  slots: BuildSlot[]
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

/**
 * Consumables, wards and trinkets are purchases but not build steps, so they
 * must never occupy a build slot or a path position.
 */
const NON_BUILD_ITEMS = new Set([
  2003, 2010, 2031, 2033, 2055, 2065, // potions, biscuits, refillable
  3330, 3340, 3363, 3364, 3513, 2422, // trinkets and wards
])

/**
 * A build slot should hold a *finished* item. Components (Recurve Bow, Pickaxe,
 * Long Sword) and starting items are purchases on the way there, so they are
 * excluded by gold cost. Boots are the exception: they are genuinely finished
 * items well below the legendary price band.
 */
const COMPLETED_ITEM_GOLD = 2000
/**
 * Actual tier-2 boot items. (3153 is Blade of the Ruined King — it was wrongly
 * listed here once and made the boots row aggregate a legendary.)
 */
const BOOTS = new Set([1001, 3006, 3009, 3020, 3047, 3111, 3117, 3158, 2422])

function isCompletedItem(id: number, gold: Map<number, number> | undefined) {
  if (BOOTS.has(id)) return true
  if (!gold) return true
  const cost = gold.get(id)
  // Unknown cost: keep it rather than hide a real item.
  return cost === undefined || cost >= COMPLETED_ITEM_GOLD
}

export type BuildSlotOption = {
  id: number
  games: number
  share: number
  wins: number
  winRate: number
}

export type BuildSlot = {
  slot: number
  options: BuildSlotOption[]
  /**
   * The statistically strongest item for this purchase position, or null when
   * the sample is too thin or the leader has no real edge over the runner-up.
   */
  bestId: number | null
  bestWinRate: number | null
}

/**
 * Options must reach this many games in a slot before their win rate is allowed
 * to compete for "best in slot"; below it, a single swing game can crown noise.
 */
const BEST_IN_SLOT_MIN_GAMES = 10

/** Purchases at or before this minute are the opening, not a build step. */
const OPENING_MINUTE = 2

/**
 * Per-slot build order.
 *
 * The question a build path answers is "what do I finish first, second, third,
 * and what are my options after that". So for every game the finished inventory
 * is ordered by when each item was first started, and each position is then
 * aggregated independently: slot 1 might be Blade of the Ruined King in 100% of
 * games, slot 3 Plated Steelcaps in 62% and Mercury's Treads in 31%, and the
 * last slots become a menu of options. Shares are per slot, over the games that
 * actually reached that slot.
 */
function slotAggregate(matches: MatchBuildData[], gold?: Map<number, number>, slotCount = 6): BuildSlot[] {
  const counts: Array<Map<number, { games: number; wins: number }>> = Array.from(
    { length: slotCount },
    () => new Map<number, { games: number; wins: number }>(),
  )
  const reached = new Array<number>(slotCount).fill(0)

  matches.forEach((match) => {
    const earliest = new Map<number, number>()
    match.lanePurchases.forEach(({ id, minute }) => {
      const current = earliest.get(id)
      if (current === undefined || minute < current) earliest.set(id, minute)
    })
    const ordered = match.finalItems
      .filter((id) => id > 0 && !NON_BUILD_ITEMS.has(id) && isCompletedItem(id, gold))
      // Boots have their own row in the build view. Mixed into the numbered
      // slots they distort the item order: most players finish tier-2 boots
      // before their first legendary, which would make "boots first" the slot-1
      // winner even though every build guide — and the true build order — is
      // expressed as "first legendary, then boots".
      .filter((id) => !BOOTS.has(id))
      // Starting items survive in the finished inventory and were bought in the
      // opening, so they are not build steps. Anything whose purchase time we do
      // not have is kept rather than silently dropped.
      .filter((id) => {
        const minute = earliest.get(id)
        return minute === undefined || minute > OPENING_MINUTE
      })
      .sort((a, b) => (earliest.get(a) ?? 99) - (earliest.get(b) ?? 99) || a - b)
    ordered.forEach((id, index) => {
      if (index >= slotCount) return
      const entry = counts[index].get(id) ?? { games: 0, wins: 0 }
      entry.games += 1
      if (match.win) entry.wins += 1
      counts[index].set(id, entry)
      reached[index] += 1
    })
  })

  return counts.map((map, slot) => {
    const options: BuildSlotOption[] = [...map.entries()]
      .map(([id, value]) => ({
        id,
        games: value.games,
        share: reached[slot] ? value.games / reached[slot] : 0,
        wins: value.wins,
        winRate: value.games ? value.wins / value.games : 0,
      }))
      .sort((a, b) => b.games - a.games || a.id - b.id)
      .slice(0, 5)

    // Best in slot: the highest win rate with enough evidence, and only when it
    // actually separates from the runner-up — refusing to crown a winner is
    // better than highlighting a coin flip as if it were signal.
    const eligible = options
      .filter((option) => option.games >= BEST_IN_SLOT_MIN_GAMES)
      .sort((a, b) => b.winRate - a.winRate)
    let bestId: number | null = null
    let bestWinRate: number | null = null
    if (eligible.length === 1 && eligible[0].games >= 15) {
      bestId = eligible[0].id
      bestWinRate = eligible[0].winRate
    } else if (eligible.length >= 2 && eligible[0].winRate - eligible[1].winRate >= 0.03) {
      bestId = eligible[0].id
      bestWinRate = eligible[0].winRate
    }

    return { slot: slot + 1, options, bestId, bestWinRate }
  }).filter((entry) => entry.options.length > 0)
}

/**
 * The complete build path: the opening purchase followed by the most common
 * finished build, sequenced by when each item is actually completed. This backs
 * the "Starting Items -> last item" view, so it returns a full sequence whenever
 * the sample has any purchases at all.
 */
function completeBuildPath(matches: MatchBuildData[]): ItemShare[] {
  const withPurchases = matches.filter((match) => match.lanePurchases.length > 0)
  if (!withPurchases.length) return []

  // Average first-purchase minute per item across the sample.
  const timing = new Map<number, { total: number; count: number; games: number; wins: number }>()
  withPurchases.forEach((match) => {
    const earliest = new Map<number, number>()
    match.lanePurchases.forEach(({ id, minute }) => {
      const current = earliest.get(id)
      if (current === undefined || minute < current) earliest.set(id, minute)
    })
    earliest.forEach((minute, id) => {
      const entry = timing.get(id) ?? { total: 0, count: 0, games: 0, wins: 0 }
      entry.total += minute
      entry.count += 1
      entry.games += 1
      if (match.win) entry.wins += 1
      timing.set(id, entry)
    })
  })
  const avgMinute = (id: number) => {
    const entry = timing.get(id)
    return entry && entry.count ? entry.total / entry.count : Number.POSITIVE_INFINITY
  }

  // The most frequently finished inventory is the build players actually reach.
  const inventories = new Map<string, { items: number[]; games: number }>()
  matches.forEach((match) => {
    const items = match.finalItems.filter((id) => id > 0 && !NON_BUILD_ITEMS.has(id))
    if (items.length < 4) return
    const key = [...items].sort((a, b) => a - b).join(',')
    const entry = inventories.get(key) ?? { items, games: 0 }
    entry.games += 1
    inventories.set(key, entry)
  })
  const best = [...inventories.values()].sort((a, b) => b.games - a.games)[0]

  const share = (id: number): ItemShare => {
    const entry = timing.get(id)
    return {
      id,
      games: entry?.games ?? 0,
      winRate: entry && entry.games ? entry.wins / entry.games : 0,
      averageMinute: entry && entry.count ? entry.total / entry.count : null,
    }
  }

  // Opening purchase: the most common items bought in the first two minutes, in
  // the order they are actually bought.
  const openingCounts = new Map<number, number>()
  matches.forEach((match) => {
    new Set(match.lanePurchases.filter((purchase) => purchase.minute <= 2).map((purchase) => purchase.id))
      .forEach((id) => openingCounts.set(id, (openingCounts.get(id) ?? 0) + 1))
  })
  const openingIds = [...openingCounts.entries()]
    .sort((a, b) => b[1] - a[1] || avgMinute(a[0]) - avgMinute(b[0]))
    .slice(0, 2)
    .map(([id]) => id)

  // Rest of the path: the finished build in completion order. Duplicates are
  // collapsed — a double Recurve Bow is a real purchase but reads as a bug in a
  // single-file path — and anything already shown as an opening item is skipped.
  const seen = new Set<number>(openingIds)
  const core: number[] = []
  const candidates = (best?.items ?? [])
    .slice()
    .sort((a, b) => avgMinute(a) - avgMinute(b))
  // No complete inventory in the sample: fall back to the most-bought items.
  const fallbackOrder = best
    ? candidates
    : [...timing.entries()].sort((a, b) => b[1].games - a[1].games).slice(0, 6).map(([id]) => id)
      .sort((a, b) => avgMinute(a) - avgMinute(b))
  fallbackOrder.forEach((id) => {
    if (seen.has(id)) return
    seen.add(id)
    core.push(id)
  })

  return [...openingIds, ...core].map(share)
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

export function aggregateProfile(matches: MatchBuildData[], source: 'lane' | 'comp', itemGold?: Map<number, number>): BuildProfile {
  const wins = matches.filter((match) => match.win).length
  const withPurchases = matches.filter((match) => match.lanePurchases.length > 0)
  const bootIds = new Set([1001, 3006, 3009, 3020, 3047, 3111, 3117, 3158, 2422])

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
    fullBuild: completeBuildPath(matches),
    slots: slotAggregate(matches, itemGold),
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

/* ------------------------------------------------------------------ *
 * Cache-wide Irelia build (always-on fallback)
 * ------------------------------------------------------------------ */

/**
 * Builds Irelia profiles from every cached match that contains an Irelia
 * participant, independent of any scan snapshot. This guarantees the draft and
 * dock views can always present items and runes - matching how porofessor-like
 * tools surface a default build before matchup filtering.
 *
 * The set of candidate match ids comes from a persistent index
 * (scans/irelia-index) that is appended to whenever a match with an Irelia
 * player is written, so this never re-walks the whole matches/ bucket. If the
 * index is missing (first run) we fall back to a single full walk and persist
 * the result. Timelines are read only from disk; no network requests occur.
 */
let cacheWideProfileMemo: { key: string; matches: MatchBuildData[] } | null = null

export async function loadCacheWideIreliaMatches(): Promise<MatchBuildData[]> {
  await ensureIreliaIndexLoaded()
  const indexed = [...ireliaIndex.ids]
  const memoKey = `${indexed.length}:${indexed.length ? indexed[indexed.length - 1] : ''}`
  if (cacheWideProfileMemo && cacheWideProfileMemo.key === memoKey) {
    return cacheWideProfileMemo.matches
  }

  let ids = indexed
  if (!ids.length) {
    // First run with no index yet: derive it from the whole matches bucket.
    const allKeys = await listCacheKeys('matches')
    const discovered: string[] = []
    for (const key of allKeys) {
      const record = await readCache<MatchRecord>('matches', key)
      if (!record || record.info?.queueId !== 420) continue
      if (record.info.participants.some((entry) => entry.championId === IRELIA_CHAMPION_ID)) {
        discovered.push(record.metadata.matchId || key)
      }
    }
    ids = discovered
    discovered.forEach((id) => ireliaIndex.ids.add(id))
    ireliaIndex.dirty = true
    void flushIreliaIndex()
  }

  const matches: MatchBuildData[] = []
  for (const id of ids) {
    const record = await readCache<MatchRecord>('matches', id)
    if (!record || record.info?.queueId !== 420) continue
    for (const participant of record.info.participants) {
      if (participant.championId !== IRELIA_CHAMPION_ID) continue
      const puuid = participant.puuid as string | undefined
      if (!puuid) continue
      const data = await buildMatchData(
        // Timelines come straight from disk via getCachedTimeline only when a
        // fetch adapter is supplied; pass one that always rejects so we never
        // hit the network here.
        () => Promise.reject(new Error('offline')),
        record,
        puuid,
        { withTimeline: true },
      )
      if (data) matches.push(data)
    }
  }

  cacheWideProfileMemo = { key: memoKey, matches }
  return matches
}