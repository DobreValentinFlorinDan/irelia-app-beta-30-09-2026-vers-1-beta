import { Component, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import './App.css'
import OnetricksView, { OnetrickGamesView, MATCHUP_TARGET, POOL_TARGET } from './Onetricks.tsx'
import type { ConfidenceInterval, GameRow, ClientStatus } from './Onetricks.tsx'

type Routing = 'EUROPE' | 'ASIA' | 'KR' | 'EUN1' | 'AMERICAS' | 'EUW1' | 'NA1'
type ScanRegion = 'KR' | 'EUW' | 'EUNE' | 'NA'
type ApiUsage = {
  localBudget: { perSecond: number; perTwoMinutes: number }
  app: { lastSecond: number; lastTwoMinutes: number }
  routes: Record<Routing, { lastSecond: number; lastTwoMinutes: number }>
  measuredAt: number
}
type ApiStatus = { configured: boolean; mode: string; usage: ApiUsage }
const emptyApiUsage: ApiUsage = {
  localBudget: { perSecond: 18, perTwoMinutes: 90 },
  app: { lastSecond: 0, lastTwoMinutes: 0 },
  routes: {
    EUROPE: { lastSecond: 0, lastTwoMinutes: 0 },
    ASIA: { lastSecond: 0, lastTwoMinutes: 0 },
    KR: { lastSecond: 0, lastTwoMinutes: 0 },
    EUN1: { lastSecond: 0, lastTwoMinutes: 0 },
    AMERICAS: { lastSecond: 0, lastTwoMinutes: 0 },
    EUW1: { lastSecond: 0, lastTwoMinutes: 0 },
    NA1: { lastSecond: 0, lastTwoMinutes: 0 },
  },
  measuredAt: 0,
}
type Champion = { id: number; name: string; ddragonId?: string }
type NamedId = { id: number; name: string; icon?: string; tree?: string; isTree?: boolean }
type ItemInfo = {
  id: number
  name: string
  plaintext: string
  image: string
  stats: Record<string, number>
  gold: number
}
type StaticCatalog = { version: string; champions: Champion[]; items: ItemInfo[]; runes: NamedId[] }
type DraftMode = 'mock' | 'live'
type ViewName = 'onetricks' | 'dock' | 'dashboard' | 'otps' | 'build' | 'draft' | 'champselect' | 'datamanagement' | 'widget'
type OtpLane = 'TOP' | 'MID'
type Tier = 'all' | 'challenger' | 'grandmaster' | 'master' | 'emerald'
const emptyChampions: Champion[] = []
const emptyItems: ItemInfo[] = []
const emptyRunes: NamedId[] = []

function readLocal<T>(key: string, fallback: T): T {
  try {
    const value = window.localStorage.getItem(key)
    return value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

function writeLocal(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Local storage may be unavailable or full.
  }
}

type MatchSample = {
  matchId: string
  patch: string
  champion: string
  championId: number
  opponent: string | null
  opponentChampionId: number | null
  position: string
  allies: NamedId[]
  enemies: NamedId[]
  win: boolean
  items: number[]
  primaryRuneStyle: number | null
  keystoneId: number | null
  secondaryRuneStyle: number | null
  runeIds: number[]
  spellIds?: number[]
  laneItems: Array<{ id: number; minute: number }>
  kills: number
  deaths: number
  assists: number
}

/**
 * Normalises a match into the client's `MatchSample` shape, regardless of which
 * wire shape arrived.
 *
 * The server historically emitted the raw `MatchBuildData` shape (`finalItems`,
 * `lanePurchases`, `primaryStyle`, `secondaryStyle`, `spells`, `allyChampionIds`,
 * `enemyChampionIds`) while the client reads `items`, `laneItems`,
 * `primaryRuneStyle`, `secondaryRuneStyle`, `spellIds`, `allies`, `enemies`.
 * That contract mismatch threw `match.items.map is not a function` and blanked
 * the OTP scouting view. This single mapper accepts both shapes and resolves
 * champion ids to names through the catalog the client already holds, so no
 * network round-trip is needed and a missing field degrades to an empty value
 * rather than a crash.
 */
function normalizeMatchSample(raw: Record<string, unknown>, championNames: Map<number, string>): MatchSample {
  const championId = Number(raw.championId ?? 0)
  const opponentChampionId = raw.opponentChampionId != null ? Number(raw.opponentChampionId) : null
  const toName = (id: number) => championNames.get(id) ?? String(id)

  const allyIds = Array.isArray(raw.allyChampionIds) ? raw.allyChampionIds as number[] : []
  const enemyIds = Array.isArray(raw.enemyChampionIds) ? raw.enemyChampionIds as number[] : []
  const laneEvents = Array.isArray(raw.laneItems) ? raw.laneItems : (Array.isArray(raw.lanePurchases) ? raw.lanePurchases : [])

  return {
    matchId: String(raw.matchId ?? ''),
    patch: String(raw.patch ?? ''),
    champion: String(raw.champion ?? toName(championId)),
    championId,
    opponent: opponentChampionId != null ? String(raw.opponent ?? toName(opponentChampionId)) : null,
    opponentChampionId,
    position: String(raw.position ?? 'UNKNOWN'),
    allies: Array.isArray(raw.allies)
      ? raw.allies as NamedId[]
      : allyIds.map((id) => ({ id: Number(id), name: toName(Number(id)) })),
    enemies: Array.isArray(raw.enemies)
      ? raw.enemies as NamedId[]
      : enemyIds.map((id) => ({ id: Number(id), name: toName(Number(id)) })),
    win: Boolean(raw.win),
    items: Array.isArray(raw.items) ? raw.items as number[] : (Array.isArray(raw.finalItems) ? raw.finalItems as number[] : []),
    primaryRuneStyle: (raw.primaryRuneStyle ?? raw.primaryStyle ?? null) as number | null,
    keystoneId: (raw.keystoneId ?? null) as number | null,
    secondaryRuneStyle: (raw.secondaryRuneStyle ?? raw.secondaryStyle ?? null) as number | null,
    runeIds: Array.isArray(raw.runeIds) ? raw.runeIds as number[] : [],
    spellIds: Array.isArray(raw.spellIds) ? raw.spellIds as number[] : (Array.isArray(raw.spells) ? raw.spells as number[] : []),
    laneItems: (laneEvents as Array<{ id: number; minute: number }>).map((event) => ({
      id: Number(event.id),
      minute: Number(event.minute ?? 0),
    })),
    kills: Number(raw.kills ?? 0),
    deaths: Number(raw.deaths ?? 0),
    assists: Number(raw.assists ?? 0),
  }
}

/** A view that fails to render degrades to a message instead of a blank page. */
class ViewErrorBoundary extends Component<{ label: string; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-strip" role="alert">
          {this.props.label} failed to render: {this.state.error.message}
        </div>
      )
    }
    return this.props.children
  }
}
type PlayerReport = {
  account: { gameName: string; tagLine: string }
  rankedSample: number
  ireliaGames: number
  ireliaShare: number
  winRateOnIrelia: number
  matches: MatchSample[]
}
type OtpRoleStats = {
  role: OtpLane
  rankedGames: number
  ireliaGames: number
  ireliaShare: number
  winRate: number
  isOtp: boolean
}
type OtpCandidate = {
  name: string
  region?: ScanRegion
  tier: string
  leaguePoints: number
  ireliaMasteryPoints: number
  ireliaMasteryRank?: number
  rankedSample: number
  ireliaGames: number
  ireliaShare: number
  winRate: number
  isOtp: boolean
  otpRole: OtpLane | null
  otpRoles: OtpLane[]
  roles: OtpRoleStats[]
  items: Array<{ value: number; count: number }>
  laneItems: Array<{ value: number; count: number }>
  keystones: Array<{ value: number; count: number }>
  spells?: Array<{ value: number; count: number }>
  skillOrders?: Array<{ value: string; count: number }>
  laneOpponents: Array<{ value: number; count: number }>
  laneRankedGames?: number
  laneIreliaGames?: number
  laneIreliaShare?: number
  laneWinRate?: number
  matches: MatchSample[]
}
type OtpScan = {
  tier: string
  lane: OtpLane | null
  regions?: ScanRegion[]
  minIreliaGames?: number
  threshold: number
  candidatePoolSize: number
  masteryCandidates: number
  screenSize: number
  deepenedCandidates: number
  cacheHits?: number
  /** Matches downloaded that were not already cached; 0 means nothing new. */
  newGames?: number
  analyzed: OtpCandidate[]
  note: string
}
type OtpSortMode = 'active' | 'winrate' | 'mastery' | 'sample'
type BuildFocus = 'lane' | 'comp'

type Pick = { championId: number; assignedPosition?: string; cellId?: number }
type Lobby = { myTeam: Pick[]; theirTeam: Pick[]; bans?: { myTeamBans?: number[]; theirTeamBans?: number[] } }
type ItemCount = { id: number; count: number; winRate: number }
type PurchasePathItem = { id: number; games: number; averageMinute: number }
type BuildEvidence = {
  sample: number
  itemSample: number
  winRate: number
  items: ItemCount[]
  runes: Array<{ id: number; count: number; winRate: number }>
  primaryStyles: Array<{ id: number; count: number }>
  secondaryStyles: Array<{ id: number; count: number }>
  purchasePath: PurchasePathItem[]
  spells: Array<{ id: number; count: number }>
  keystones: Array<{ id: number; count: number }>
}

/** Human-readable byte size for the storage cap readouts. */
function formatBytesLocal(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

async function apiGet<T>(url: string): Promise<T> {
  const response = await fetch(url)
  const data = (await response.json()) as { error?: string }
  if (!response.ok) {
    const message = data.error ?? `Request failed (${response.status}).`
    throw new Error(message)
  }
  return data as T
}

/**
 * Streams a KR scan over Server-Sent Events, reporting progress as it goes.
 * If streaming fails (older browser, proxy issue), falls back to the single
 * blocking endpoint. Returns the finished scan payload.
 */
async function streamKoreanScan({
  tier,
  lane,
  regions,
  rosterOnly = false,
  onProgress,
  signal,
}: {
  tier: Tier
  lane: OtpLane | null
  regions: ScanRegion[]
  /** Deepen only the tracked one-tricks and skip the ladder crawl. */
  rosterOnly?: boolean
  onProgress: (progress: ScanProgress) => void
  signal?: AbortSignal
}): Promise<OtpScan> {
  const query = new URLSearchParams({
    tier,
    limit: tier === 'all' ? '20' : '12',
    sampleSize: '40',
    threshold: '0.7',
    regions: regions.join(','),
    minGames: '3',
    ...(lane ? { lane } : {}),
    ...(rosterOnly ? { source: 'roster' } : {}),
  })

  if (typeof EventSource === 'undefined') {
    return apiGet<OtpScan>(`/api/riot/kr-scan?${query}`)
  }

  return new Promise<OtpScan>((resolve, reject) => {
    const source = new EventSource(`/api/riot/kr-scan-stream?${query}`)
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      source.close()
      fn()
    }
    const abort = () => finish(() => reject(new Error('Scan stopped.')))
    if (signal) {
      if (signal.aborted) { abort(); return }
      signal.addEventListener('abort', abort, { once: true })
    }
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as
          | { type: 'progress' } & ScanProgress
          | { type: 'result'; result: OtpScan }
          | { type: 'error'; message: string }
        if (payload.type === 'progress') {
          onProgress({ phase: payload.phase, message: payload.message, done: payload.done, total: payload.total })
        } else if (payload.type === 'result') {
          finish(() => resolve(payload.result))
        } else if (payload.type === 'error') {
          finish(() => reject(new Error(payload.message)))
        }
      } catch {
        // Ignore keep-alive comments or partial frames.
      }
    }
    source.onerror = () => {
      finish(() => reject(new Error('Scan stream failed. Check that the local dev server is running.')))
    }
  })
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`
}

function otpActivityScore(candidate: OtpCandidate) {
  const laneCoverage = candidate.roles.length ? candidate.roles.reduce((total, role) => total + role.ireliaShare, 0) / candidate.roles.length : 0
  const recentActivity = Math.min(1, candidate.ireliaGames / 18)
  const shareFactor = Math.min(1, candidate.ireliaShare / 0.35)
  const winFactor = Math.min(1, candidate.winRate / 0.65)
  const masteryFactor = Math.min(1, candidate.ireliaMasteryPoints / 200000)
  const roleBoost = candidate.otpRoles.length ? 1.1 + (candidate.otpRoles.length * 0.25) : 0.7

  return (
    (candidate.isOtp ? 2.5 : 0.5)
    + recentActivity * 2.1
    + shareFactor * 2.2
    + winFactor * 1.6
    + masteryFactor * 1.2
    + laneCoverage * 1.9
    + roleBoost
  )
}

function sortOtpCandidates(candidates: OtpCandidate[], mode: OtpSortMode) {
  const items = [...candidates]
  return items.sort((first, second) => {
    if (mode === 'mastery') return second.ireliaMasteryPoints - first.ireliaMasteryPoints
    if (mode === 'winrate') return second.winRate - first.winRate
    if (mode === 'sample') return second.ireliaGames - first.ireliaGames
    return otpActivityScore(second) - otpActivityScore(first)
  })
}

/* ======================= Server build profile types ======================= */

type ServerItemShare = { id: number; games: number; winRate: number; averageMinute: number | null }
type ServerRuneShare = { id: number; games: number }
type ServerSpellShare = { ids: number[]; games: number; winRate: number }
type ServerSkillOrder = { order: string; games: number }
type BuildProfile = {
  source: 'lane' | 'comp'
  games: number
  wins: number
  winRate: number
  startingItems: ServerItemShare[]
  boots: ServerItemShare[]
  coreItems: ServerItemShare[]
  fullItems: ServerItemShare[]
  purchasePath: ServerItemShare[]
  skillOrder: ServerSkillOrder[]
  spells: ServerSpellShare[]
  primaryStyles: ServerRuneShare[]
  secondaryStyles: ServerRuneShare[]
  keystones: ServerRuneShare[]
  runeShards: ServerRuneShare[]
}

/** A complete finished build, optimised as a whole rather than as loose items. */
type ItemSetEntry = {
  items: number[]
  games: number
  wins: number
  winRate: ConfidenceInterval
  averageDuration: number | null
}

type SkillLevelRow = {
  level: number
  slot: number
  share: ConfidenceInterval
  counts: Record<number, number>
}

type SkillOrderAnalysis = {
  rows: SkillLevelRow[]
  orders: Array<{ order: string; games: number }>
  priority: number[]
  earlyOrder: string
  maxLevel: number
  sampleSize: number
  confidence: number
}

type BuildResponse = {
  source: 'lane' | 'comp'
  lane: OtpLane
  patch: string
  patchExact: boolean
  games: number
  profile: BuildProfile
  reason: string
  /** Whole-build optimisation over completed inventories. */
  itemSets?: ItemSetEntry[]
  /** Per-level skill matrix, max order and early order. */
  skills?: SkillOrderAnalysis
  /** Context-weighted win rate, which differs from `profile.winRate` when a draft is supplied. */
  weighted?: ConfidenceInterval
  /** How concentrated the context weighting was. */
  weighting?: {
    totalWeight: number
    effectiveSampleSize: number
    topMatchId: string | null
  }
}
type ScanProgress = { phase: string; message: string; done: number; total: number }

const emptyBuildProfile: BuildProfile = {
  source: 'lane',
  games: 0,
  wins: 0,
  winRate: 0,
  startingItems: [],
  boots: [],
  coreItems: [],
  fullItems: [],
  purchasePath: [],
  skillOrder: [],
  spells: [],
  primaryStyles: [],
  secondaryStyles: [],
  keystones: [],
  runeShards: [],
}

/**
 * Converts a server build profile (the lane/matchup build from `/api/riot/build`)
 * into the widget's `BuildEvidence` shape so the widget can show "item order vs
 * lane opponent" using the same weighted server model as the stats page.
 */
function buildResponseToEvidence(build: BuildResponse | null): BuildEvidence {
  const empty: BuildEvidence = {
    sample: 0, itemSample: 0, winRate: 0, items: [], runes: [],
    primaryStyles: [], secondaryStyles: [], purchasePath: [], spells: [], keystones: [],
  }
  if (!build) return empty
  const profile = build.profile
  return {
    sample: profile.games,
    itemSample: profile.games,
    winRate: profile.winRate,
    items: profile.fullItems.map((item) => ({ id: item.id, count: item.games, winRate: item.winRate })),
    runes: profile.runeShards.map((rune) => ({ id: rune.id, count: rune.games, winRate: profile.winRate })),
    primaryStyles: profile.primaryStyles.map((style) => ({ id: style.id, count: style.games })),
    secondaryStyles: profile.secondaryStyles.map((style) => ({ id: style.id, count: style.games })),
    purchasePath: profile.purchasePath.map((item) => ({ id: item.id, games: item.games, averageMinute: item.averageMinute ?? 0 })),
    spells: profile.spells.map((spell) => ({ id: spell.ids[0], count: spell.games })),
    keystones: profile.keystones.map((keystone) => ({ id: keystone.id, count: keystone.games })),
  }
}

/* ======================= Porofessor-style build path ======================= */

function BuildPathCard({
  title,
  subtitle,
  response,
  itemCatalog,
  runeCatalog,
  runeNames,
  patch,
}: {
  title: string
  subtitle: string
  response: BuildResponse | null
  itemCatalog: Map<number, ItemInfo>
  runeCatalog: Map<number, NamedId>
  runeNames: Map<number, string>
  patch: string
}) {
  const profile = response?.profile ?? emptyBuildProfile
  const exact = response?.patchExact ?? false

  function itemIcon(id: number, size: number) {
    const item = itemCatalog.get(id)
    return item && patch ? (
      <img
        className="bp-item-img"
        src={`https://ddragon.leagueoflegends.com/cdn/${patch}/img/item/${item.image}`}
        alt={item.name}
        title={item.name}
        width={size}
        height={size}
        loading="lazy"
      />
    ) : <span className="bp-item-img item-icon-placeholder" style={{ width: size, height: size }}>{id}</span>
  }

  function ItemTile({
    id,
    size,
    badge,
    caption,
  }: {
    id: number
    size: number
    badge?: string
    caption?: string
  }) {
    return (
      <div className="bp-tile" title={itemCatalog.get(id)?.name ?? `Item ${id}`}>
        <div className="bp-tile-icon">
          {itemIcon(id, size)}
          {badge && <span className="bp-wr">{badge}</span>}
        </div>
        {caption && <span className="bp-tile-caption">{caption}</span>}
      </div>
    )
  }

  const hasCore = profile.purchasePath.length > 0 || profile.coreItems.length > 0
  const coreTiles = profile.purchasePath.length
    ? profile.purchasePath.slice(0, 6).map((item) => ({
      id: item.id,
      badge: percent(item.winRate),
      caption: item.averageMinute !== null ? `~${Math.round(item.averageMinute)}m` : `${item.games}×`,
    }))
    : profile.coreItems.slice(0, 6).map((item) => ({
      id: item.id,
      badge: percent(item.winRate),
      caption: `${item.games}×`,
    }))

  return (
    <section className="panel build-path-card">
      <div className="bp-header">
        <div className="bp-header-copy">
          <p className="eyebrow">KR + EUW + EUNE + NA · active Irelia games</p>
          <h2>{title}</h2>
          <p className="microcopy">{subtitle}</p>
        </div>
        <div className="bp-header-stats">
          <div className="bp-stat"><strong>{profile.games}</strong><span>games</span></div>
          {profile.games > 0 && <div className="bp-stat bp-stat-wr"><strong>{percent(profile.winRate)}</strong><span>win rate</span></div>}
          {patch && <span className={`bp-patch-badge ${exact ? 'is-current' : 'is-older'}`}>patch {patch}</span>}
        </div>
      </div>

      {!response || profile.games === 0 ? (
        <p className="empty-state">{response?.reason ?? 'Run a scan, then pick a matchup to see the build path.'}</p>
      ) : (
        <>
          {!exact && <p className="caveat">Showing the most recent patch with data, not the live patch. Sample sizes appear under each item.</p>}

          <div className="bp-cols">
            <div className="bp-col bp-col-runes">
              <h3 className="bp-section-title">Runes</h3>
              <div className="bp-runes">
                <div className="bp-rune-trees">
                  {profile.primaryStyles.length > 0 && (
                    <div className="bp-tree bp-tree-primary">
                      <span className="bp-tree-label">Primary</span>
                      <strong>{runeNames.get(profile.primaryStyles[0].id) ?? `Tree ${profile.primaryStyles[0].id}`}</strong>
                      <small>{profile.primaryStyles[0].games}×</small>
                    </div>
                  )}
                  {profile.secondaryStyles.length > 0 && (
                    <div className="bp-tree bp-tree-secondary">
                      <span className="bp-tree-label">Secondary</span>
                      <strong>{runeNames.get(profile.secondaryStyles[0].id) ?? `Tree ${profile.secondaryStyles[0].id}`}</strong>
                      <small>{profile.secondaryStyles[0].games}×</small>
                    </div>
                  )}
                </div>
                <div className="bp-keystones">
                  {profile.keystones.slice(0, 3).map((keystone) => {
                    const rune = runeCatalog.get(keystone.id)
                    return (
                      <span className="bp-keystone" key={keystone.id} title={rune?.name ?? `Rune ${keystone.id}`}>
                        {rune?.icon
                          ? <img src={`https://ddragon.leagueoflegends.com/cdn/img/${rune.icon}`} alt={rune.name} width="34" height="34" loading="lazy" />
                          : <span className="item-icon-placeholder" style={{ width: 34, height: 34 }}>{keystone.id}</span>}
                        <span>{rune?.name ?? `Rune ${keystone.id}`}</span>
                        <em>{keystone.games}×</em>
                      </span>
                    )
                  })}
                </div>
              </div>

              <h3 className="bp-section-title">Summoner spells</h3>
              <div className="bp-spells">
                {profile.spells.slice(0, 3).map((spell) => (
                  <span className="bp-spell-pair" key={spell.ids.join('-')}>
                    <span className="bp-spell-icons">
                      {spell.ids.map((id) => (
                        <img
                          key={id}
                          src={`https://ddragon.leagueoflegends.com/cdn/${patch || '14.1.1'}/img/spell/${spellName(id)}.png`}
                          alt={summonerSpells[id] ?? `Spell ${id}`}
                          title={summonerSpells[id] ?? `Spell ${id}`}
                          width="38"
                          height="38"
                          loading="lazy"
                          onError={(event) => { (event.currentTarget as HTMLImageElement).style.opacity = '0.25' }}
                        />
                      ))}
                    </span>
                    <span className="bp-spell-meta">{percent(spell.winRate)} · {spell.games}×</span>
                  </span>
                ))}
                {!profile.spells.length && <span className="empty-state">No spell sample.</span>}
              </div>

              {profile.skillOrder.length > 0 && (
                <>
                  <h3 className="bp-section-title">Skill order</h3>
                  <div className="bp-skill-orders">
                    {profile.skillOrder.slice(0, 3).map((entry) => (
                      <div className="bp-skill-order" key={entry.order}>
                        <span className="bp-skill-letters">
                          {entry.order.split('').map((slot, index) => (
                            <b key={index} className={`skill-${slot}`}>{['', 'Q', 'W', 'E', 'R'][Number(slot)] ?? '?'}</b>
                          ))}
                        </span>
                        <em>{entry.games}×</em>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="bp-col bp-col-items">
              <h3 className="bp-section-title">Start</h3>
              <div className="bp-strip">
                {profile.startingItems.length
                  ? profile.startingItems.map((item) => (
                    <ItemTile key={item.id} id={item.id} size={40} caption={`${item.games}×`} />
                  ))
                  : <span className="empty-state">No starting-item sample.</span>}
              </div>

              <h3 className="bp-section-title">Boots</h3>
              <div className="bp-strip">
                {profile.boots.length
                  ? profile.boots.map((item) => (
                    <ItemTile key={item.id} id={item.id} size={40} badge={percent(item.winRate)} caption={`${item.games}×`} />
                  ))
                  : <span className="empty-state">No boots sample.</span>}
              </div>

              <h3 className="bp-section-title">Build order</h3>
              <div className="bp-strip bp-strip-core">
                {hasCore
                  ? coreTiles.map((tile, index) => (
                    <div className="bp-core-step" key={`${tile.id}-${index}`}>
                      <span className="bp-core-index">{index + 1}</span>
                      <ItemTile id={tile.id} size={48} badge={tile.badge} caption={tile.caption} />
                    </div>
                  ))
                  : <span className="empty-state">No build-order sample.</span>}
              </div>
            </div>
          </div>

          <p className="disclaimer">Observational evidence from captured Irelia games. Sample sizes matter; small samples are directional only.</p>
        </>
      )}
    </section>
  )
}

function ScanProgressBar({ progress, busy }: { progress: ScanProgress | null; busy: boolean }) {
  if (!busy && !progress) return null
  const pct = progress && progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0
  return (
    <div className="scan-progress" role="status" aria-live="polite">
      <div className="scan-progress-head">
        <span className="scan-phase">{progress?.phase ?? 'starting'}</span>
        <span>{progress?.message ?? 'Preparing scan…'}</span>
        <strong>{pct}%</strong>
      </div>
      <progress value={pct} max={100} />
    </div>
  )
}

function ChampionSelect({
  value,
  onChange,
  label,
  champions,
}: {
  value: number
  onChange: (value: number) => void
  label: string
  champions: Champion[]
}) {
  return (
    <label className="champion-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(Number(event.target.value))}>
        <option value={0}>Unknown</option>
        {champions.map((champion) => (
          <option value={champion.id} key={champion.id}>{champion.name}</option>
        ))}
      </select>
    </label>
  )
}

const itemStatLabels: Record<string, string> = {
  FlatHPPoolMod: 'Health',
  FlatMPPoolMod: 'Mana',
  FlatPhysicalDamageMod: 'Attack damage',
  FlatMagicDamageMod: 'Ability power',
  FlatArmorMod: 'Armor',
  FlatSpellBlockMod: 'Magic resistance',
  PercentAttackSpeedMod: 'Attack speed',
  FlatMovementSpeedMod: 'Move speed',
  PercentMovementSpeedMod: 'Move speed',
  FlatCritChanceMod: 'Critical chance',
  PercentCritChanceMod: 'Critical chance',
  FlatHPRegenMod: 'Health regeneration',
  FlatMPRegenMod: 'Mana regeneration',
  FlatLifeStealMod: 'Life steal',
  PercentLifeStealMod: 'Life steal',
}

const summonerSpells: Record<number, string> = {
  1: 'Cleanse',
  3: 'Exhaust',
  4: 'Flash',
  6: 'Ghost',
  7: 'Heal',
  11: 'Smite',
  12: 'Teleport',
  13: 'Clarity',
  14: 'Ignite',
  21: 'Barrier',
  32: 'Mark',
}

function ItemOption({
  id,
  count,
  winRate,
  item,
  patch,
}: {
  id: number
  count: number
  winRate: number
  item?: ItemInfo
  patch: string
}) {
  const stats = item
    ? Object.entries(item.stats)
      .filter(([, value]) => value !== 0)
      .map(([key, value]) => ({
        name: itemStatLabels[key] ?? key,
        value: key.startsWith('Percent') ? `${Math.round(value * 100)}%` : value,
      }))
    : []

  return (
    <div className="item-option">
      {item && patch ? (
        <img
          src={`https://ddragon.leagueoflegends.com/cdn/${patch}/img/item/${item.image}`}
          alt=""
          width="38"
          height="38"
          loading="lazy"
        />
      ) : <span className="item-icon-placeholder" aria-hidden="true">{id}</span>}
      <div className="item-option-main">
        <strong>{item?.name ?? `Item ${id}`}</strong>
        {item && <small>{stats.slice(0, 3).map((stat) => `+${stat.value} ${stat.name}`).join(' · ') || item.plaintext}</small>}
      </div>
      <div className="item-option-meta">
        <strong>{percent(winRate)}</strong>
        <span>{count} games</span>
      </div>
    </div>
  )
}

function ApiUsagePanel({
  status,
  onRefresh,
}: {
  status: ApiStatus | null
  onRefresh: () => void
}) {
  const usage = status?.usage ?? emptyApiUsage
  const routeNames: Routing[] = ['EUROPE', 'ASIA', 'KR', 'EUN1', 'AMERICAS', 'EUW1', 'NA1']

  return (
    <details className="api-usage-panel">
      <summary>
        <span>API usage</span>
        <span>
          {usage.app.lastTwoMinutes} of {usage.localBudget.perTwoMinutes} requests / 2m
        </span>
      </summary>
      <div className="usage-content">
        <div className="usage-route is-app">
          <strong>All routes (key limit)</strong>
          <progress value={usage.app.lastTwoMinutes} max={usage.localBudget.perTwoMinutes} />
          <span>{usage.app.lastTwoMinutes}/{usage.localBudget.perTwoMinutes} in 2m</span>
        </div>
        <div className="usage-route-list">
          {routeNames.map((route) => {
            const current = usage.routes[route]
            return (
              <div className="usage-route" key={route}>
                <strong>{route}</strong>
                <span>{current.lastSecond}/{usage.localBudget.perSecond} in 1s</span>
                <progress value={current.lastTwoMinutes} max={usage.localBudget.perTwoMinutes} />
                <span>{current.lastTwoMinutes}/{usage.localBudget.perTwoMinutes} in 2m</span>
              </div>
            )
          })}
        </div>
        <p>Counts are from this local app process only. The app throttles itself below 20 requests/second and 100/2 minutes per route; Riot key and endpoint limits may differ.</p>
        <button type="button" className="text-button" onClick={onRefresh}>Refresh usage</button>
      </div>
    </details>
  )
}

/* ============================ Recommended build ============================ */

function RecommendedBuildView({
  status,
  refreshApiStatus,
  championNames,
  itemCatalog,
  runeCatalog,
  runeNames,
  patch,
  buildFocus,
  setBuildFocus,
  laneOpponent,
  laneBuild,
  compBuild,
  loading,
}: {
  status: ApiStatus | null
  refreshApiStatus: () => void
  championNames: Map<number, string>
  itemCatalog: Map<number, ItemInfo>
  runeCatalog: Map<number, NamedId>
  runeNames: Map<number, string>
  patch: string
  buildFocus: BuildFocus
  setBuildFocus: (value: BuildFocus) => void
  laneOpponent: number
  laneBuild: BuildResponse | null
  compBuild: BuildResponse | null
  loading: boolean
}) {
  const active = buildFocus === 'lane' ? laneBuild : compBuild
  const opponentName = laneOpponent ? championNames.get(laneOpponent) ?? 'selected opponent' : null
  const title = buildFocus === 'lane'
    ? (opponentName ? `Irelia vs ${opponentName}` : 'Irelia laning route')
    : 'Irelia composition build'
  const subtitle = buildFocus === 'lane'
    ? 'Runes, skill order, item path, spells and boots from captured Irelia mains against this matchup.'
    : 'The same build engine, weighted toward games whose teams resemble your draft.'

  return (
    <div className="view">
      <section className="build-hero">
        <img
          className="champion-portrait"
          src={`https://ddragon.leagueoflegends.com/cdn/${patch || '14.1.1'}/img/champion/Irelia.png`}
          alt="Irelia"
          width="84"
          height="84"
          onError={(event) => { (event.currentTarget as HTMLImageElement).style.visibility = 'hidden' }}
        />
        <div className="build-hero-copy">
          <p className="eyebrow">Patch {patch || 'unknown'} · observational evidence</p>
          <h1>Irelia recommended build</h1>
          <p>{active ? `${active.games} captured games · ${percent(active.profile.winRate)} observed win rate` : 'Pick a matchup to load the build'}</p>
        </div>
        <ApiUsagePanel status={status} onRefresh={refreshApiStatus} />
      </section>

      <div className="role-segment" role="tablist" aria-label="Build focus">
        <button type="button" role="tab" aria-selected={buildFocus === 'lane'} className={buildFocus === 'lane' ? 'selected' : ''} onClick={() => setBuildFocus('lane')}>Laning route</button>
        <button type="button" role="tab" aria-selected={buildFocus === 'comp'} className={buildFocus === 'comp' ? 'selected' : ''} onClick={() => setBuildFocus('comp')}>Composition</button>
      </div>

      {loading && <section className="panel"><p className="empty-state">Building matchup profile…</p></section>}

      {!loading && (
        <BuildPathCard
          title={title}
          subtitle={subtitle}
          response={active}
          itemCatalog={itemCatalog}
          runeCatalog={runeCatalog}
          runeNames={runeNames}
          patch={patch}
        />
      )}

      <section className="panel">
        <p className="disclaimer">Build frequencies and win rates are observational. Patch, matchup, and sample size affect results. Riot Games is not affiliated with this tool.</p>
      </section>
    </div>
  )
}

function spellName(id: number) {
  const map: Record<number, string> = {
    1: 'SummonerBoost',
    3: 'SummonerExhaust',
    4: 'SummonerFlash',
    6: 'SummonerHaste',
    7: 'SummonerHeal',
    11: 'SummonerSmite',
    12: 'SummonerTeleport',
    13: 'SummonerMana',
    14: 'SummonerDot',
    21: 'SummonerBarrier',
    32: 'SummonerSnowball',
  }
  return map[id] ?? 'SummonerFlash'
}

/* ============================ Dashboard ============================ */

function DashboardView({
  status,
  refreshApiStatus,
  champions,
  playerReport,
  onLoadPlayer,
  gameName,
  setGameName,
  tagLine,
  setTagLine,
  busy,
  apiReady,
  allyComp,
  enemyComp,
  updateComp,
  laneOpponent,
  setLaneOpponent,
  patch,
  scan,
  championCount,
}: {
  status: ApiStatus | null
  refreshApiStatus: () => void
  champions: Champion[]
  playerReport: PlayerReport | null
  onLoadPlayer: () => void
  gameName: string
  setGameName: (value: string) => void
  tagLine: string
  setTagLine: (value: string) => void
  busy: string | null
  apiReady: boolean
  allyComp: number[]
  enemyComp: number[]
  updateComp: (team: 'ally' | 'enemy', index: number, value: number) => void
  laneOpponent: number
  setLaneOpponent: (value: number) => void
  patch: string
  scan: OtpScan | null
  championCount: number
}) {
  return (
    <div className="view-grid">
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">EUNE · EUROPE routing</p>
            <h2>Your ranked baseline</h2>
          </div>
          <button type="button" className="action-button" onClick={onLoadPlayer} disabled={busy !== null || !apiReady}>
            {busy === 'player' ? 'Loading…' : 'Load match history'}
          </button>
        </div>
        <div className="account-form">
          <label>
            <span>Game name</span>
            <input value={gameName} onChange={(event) => setGameName(event.target.value)} />
          </label>
          <label>
            <span>Tagline</span>
            <input value={tagLine} onChange={(event) => setTagLine(event.target.value)} />
          </label>
        </div>
        {playerReport ? (
          <>
            <div className="stat-row">
              <div className="stat-cell"><span>Ranked sample</span><strong>{playerReport.rankedSample}</strong></div>
              <div className="stat-cell"><span>Irelia rate</span><strong>{percent(playerReport.ireliaShare)}</strong></div>
              <div className="stat-cell"><span>Irelia win rate</span><strong>{percent(playerReport.winRateOnIrelia)}</strong></div>
            </div>
            <div className="match-list">
              {playerReport.matches.slice(0, 6).map((match) => (
                <div className="match-row" key={match.matchId}>
                  <span>{match.champion}</span>
                  <span>vs {match.opponent ?? 'Unknown lane'}</span>
                  <span>{match.patch}</span>
                  <strong className={`match-result ${match.win ? 'win-text' : 'loss-text'}`}>{match.win ? 'W' : 'L'}</strong>
                </div>
              ))}
            </div>
          </>
        ) : <p className="empty-state">Load your last 20 ranked solo games to establish an Irelia baseline.</p>}
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Quick mock picks</p>
            <h2>This matchup</h2>
          </div>
        </div>
        <p className="microcopy">Set the lane opponent and allies here, or open the Draft view for the full composition. These picks feed the Recommended Build screen.</p>
        <div className="draft-grid">
          <div className="draft-column">
            <h3>Lane opponent</h3>
            <ChampionSelect label="Opponent" value={laneOpponent} onChange={setLaneOpponent} champions={champions} />
            <h3 className="subsection-title">Other enemy picks</h3>
            {enemyComp.map((id, index) => (
              <ChampionSelect key={`enemy-${index}`} label={`Enemy ${index + 2}`} value={id} onChange={(value) => updateComp('enemy', index, value)} champions={champions} />
            ))}
          </div>
          <div className="draft-column">
            <h3>Allied team (besides Irelia)</h3>
            {allyComp.map((id, index) => (
              <ChampionSelect key={`ally-${index}`} label={`Ally ${index + 1}`} value={id} onChange={(value) => updateComp('ally', index, value)} champions={champions} />
            ))}
          </div>
        </div>
      </section>

      <section className="panel span-full">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Local status</p>
            <h2>Environment</h2>
          </div>
          <ApiUsagePanel status={status} onRefresh={refreshApiStatus} />
        </div>
        <p className="microcopy">
          Champion and item data comes from Data Dragon {patch || '(loading…)'}. The KR scan and player history use your local Riot API key through the dev-server proxy, never from the browser. Live champ select reads the local League Client lockfile only.
        </p>
        <p className="microcopy">
          {championCount > 0 ? `${championCount} champions loaded and cached for offline drafting.` : 'Champion catalog not loaded yet.'}
          {scan ? ` Last KR scan saved: ${scan.candidatePoolSize} accounts, ${scan.analyzed.length} candidates.` : ' No saved KR scan yet.'}
        </p>
      </section>
    </div>
  )
}

/* ============================ Draft ============================ */

function DraftView({
  champions,
  championNames,
  draftMode,
  setDraftMode,
  laneOpponent,
  setLaneOpponent,
  allyComp,
  enemyComp,
  updateComp,
  clearMock,
  lobby,
  readLobby,
  busy,
  lobbyAllyIds,
  lobbyEnemyIds,
  build,
  buildLoading,
  itemCatalog,
  runeCatalog,
  runeNames,
  patch,
}: {
  champions: Champion[]
  championNames: Map<number, string>
  draftMode: DraftMode
  setDraftMode: (value: DraftMode) => void
  laneOpponent: number
  setLaneOpponent: (value: number) => void
  allyComp: number[]
  enemyComp: number[]
  updateComp: (team: 'ally' | 'enemy', index: number, value: number) => void
  clearMock: () => void
  lobby: Lobby | null
  readLobby: (silent?: boolean) => void
  busy: string | null
  lobbyAllyIds: number[]
  lobbyEnemyIds: number[]
  build: BuildResponse | null
  buildLoading: boolean
  itemCatalog: Map<number, ItemInfo>
  runeCatalog: Map<number, NamedId>
  runeNames: Map<number, string>
  patch: string
}) {
  // Live champ select keeps itself current without a manual "Read" click, and
  // auto-detects the enemy laner from the position opposite Irelia so the build
  // and widget react the moment the opposing top/mid locks in.
  useEffect(() => {
    if (draftMode !== 'live') return
    readLobby(true)
    const timer = setInterval(() => readLobby(true), 3_500)
    return () => clearInterval(timer)
  }, [draftMode, readLobby])

  useEffect(() => {
    if (draftMode !== 'live' || !lobby) return
    const me = lobby.myTeam.find((pick) => pick.championId === 39)
    const myPosition = me?.assignedPosition
    if (!myPosition) return
    const enemy = lobby.theirTeam.find((pick) => pick.assignedPosition === myPosition)
    if (enemy?.championId && enemy.championId > 0) setLaneOpponent(enemy.championId)
  }, [draftMode, lobby, setLaneOpponent])

  return (
    <div className="view-grid">
      <section className="panel span-full">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Manual planning or local client</p>
            <h2>Draft composition</h2>
          </div>
          <div className="draft-tabs" role="tablist" aria-label="Draft mode">
            <button type="button" role="tab" aria-selected={draftMode === 'mock'} className={draftMode === 'mock' ? 'active' : ''} onClick={() => setDraftMode('mock')}>Mock draft</button>
            <button type="button" role="tab" aria-selected={draftMode === 'live'} className={draftMode === 'live' ? 'active' : ''} onClick={() => setDraftMode('live')}>Live champ select</button>
          </div>
        </div>
        {draftMode === 'mock' ? (
          <>
            <p className="microcopy">Works without an active match or League Client. Your last synced KR sample and patch catalog are kept in this browser.</p>
            <div className="draft-grid">
              <div className="draft-column">
                <h3>Lane opponent</h3>
                <ChampionSelect label="Opponent" value={laneOpponent} onChange={setLaneOpponent} champions={champions} />
                <h3 className="subsection-title">Other enemy picks</h3>
                {enemyComp.map((id, index) => <ChampionSelect key={`enemy-${index}`} label={`Enemy ${index + 2}`} value={id} onChange={(value) => updateComp('enemy', index, value)} champions={champions} />)}
              </div>
              <div className="draft-column">
                <h3>Allied team (besides Irelia)</h3>
                {allyComp.map((id, index) => <ChampionSelect key={`ally-${index}`} label={`Ally ${index + 1}`} value={id} onChange={(value) => updateComp('ally', index, value)} champions={champions} />)}
              </div>
            </div>
            <button type="button" className="text-button" onClick={clearMock}>Clear mock picks</button>
          </>
        ) : (
          <>
            <div className="live-action-row">
              <p className="microcopy">Reads only your local League Client during champion select. The Riot web API key is not used for this.</p>
              <button type="button" className="action-button secondary-action" onClick={() => readLobby()} disabled={busy !== null}>
                {busy === 'lobby' ? 'Reading…' : 'Read champ select'}
              </button>
            </div>
            {lobby ? (
              <div className="draft-grid">
                <div className="draft-column"><h3>Your team</h3><p>{lobbyAllyIds.map((id) => championNames.get(id) ?? `#${id}`).join(' · ') || 'No picks yet'}</p></div>
                <div className="draft-column"><h3>Enemy team</h3><p>{lobbyEnemyIds.map((id) => championNames.get(id) ?? `#${id}`).join(' · ') || 'No picks revealed yet'}</p></div>
              </div>
            ) : <p className="empty-state">Open champion select in the League Client, then read the lobby.</p>}
          </>
        )}
      </section>

      {buildLoading && <section className="panel span-full"><p className="empty-state">Building matchup profile…</p></section>}
      {!buildLoading && (
        <section className="span-full">
          <BuildPathCard
            title={laneOpponent ? `Irelia vs ${championNames.get(laneOpponent) ?? 'opponent'} in draft` : 'Irelia draft composition'}
            subtitle="Runes, skill order, item path, spells and boots aggregated from KR Irelia games for your current draft picks, cached on disk."
            response={build}
            itemCatalog={itemCatalog}
            runeCatalog={runeCatalog}
            runeNames={runeNames}
            patch={patch}
          />
        </section>
      )}
    </div>
  )
}

/* ============================ Dock (pre-match fast context) ============================ */

function DockView({
  champions,
  championNames,
  itemCatalog,
  runeCatalog,
  runeNames,
  patch,
  lane,
  setLane,
  opponent,
  setOpponent,
  build,
  buildLoading,
  buildBusy,
  scan,
  progress,
  onScan,
  onRefreshScan,
  apiReady,
  hasScan,
}: {
  champions: Champion[]
  championNames: Map<number, string>
  itemCatalog: Map<number, ItemInfo>
  runeCatalog: Map<number, NamedId>
  runeNames: Map<number, string>
  patch: string
  lane: OtpLane
  setLane: (value: OtpLane) => void
  opponent: number
  setOpponent: (value: number) => void
  build: BuildResponse | null
  buildLoading: boolean
  buildBusy: boolean
  scan: OtpScan | null
  progress: ScanProgress | null
  onScan: () => void
  onRefreshScan: () => void
  apiReady: boolean
  hasScan: boolean
}) {
  const scannedAt = scan ? (scan as unknown as { scannedAt?: number }).scannedAt : undefined
  const savedAt = scannedAt ? new Date(scannedAt).toLocaleString() : null
  return (
    <div className="view-grid dock-grid">
      <section className="panel dock-controls">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Fast pre-match context</p>
            <h2>Matchup answers</h2>
          </div>
        </div>
        <div className="role-segment" role="group" aria-label="Lane">
          <button type="button" className={`role-top ${lane === 'TOP' ? 'selected' : ''}`} onClick={() => setLane('TOP')}>TOP</button>
          <button type="button" className={`role-mid ${lane === 'MID' ? 'selected' : ''}`} onClick={() => setLane('MID')}>MID</button>
        </div>
        <ChampionSelect label="Lane opponent" value={opponent} onChange={setOpponent} champions={champions} />
        <p className="microcopy">Pick the champion you're laning against. The build path below uses only verified Korean Irelia OTP games for that matchup, cached on disk.</p>

        <div className="dock-scan-row">
          <button type="button" className="action-button secondary-action" onClick={onScan} disabled={!apiReady || buildBusy}>
            {buildBusy ? 'Scanning…' : (hasScan ? 'Scan again (cached)' : 'Run KR scan')}
          </button>
          <button type="button" className="text-button" onClick={onRefreshScan} disabled={!apiReady || buildBusy}>Force refresh latest</button>
        </div>
        <ScanProgressBar progress={progress} busy={buildBusy} />
        {savedAt && <p className="microcopy">Saved scan: {scan?.analyzed.length ?? 0} candidates · {savedAt}. Refresh only when you want the newest games.</p>}
        {!hasScan && <p className="caveat">No saved scan yet. Run a scan once; everything after that is instant and mostly reads from the disk cache.</p>}
        {!apiReady && <p className="caveat">Riot API key missing. Add RIOT_API_KEY to .env.local and restart.</p>}
      </section>

      <div className="dock-build">
        {buildLoading && <section className="panel"><p className="empty-state">Building matchup profile…</p></section>}
        {!buildLoading && (
          <BuildPathCard
            title={opponent ? `Irelia vs ${championNames.get(opponent) ?? 'opponent'} · ${lane}` : `Irelia · ${lane} lane`}
            subtitle={opponent
              ? 'Runes, skill order, item path, spells and boots aggregated from KR Irelia games against this matchup.'
              : 'Set an opponent for a matchup-specific build, or browse the overall lane route.'}
            response={build}
            itemCatalog={itemCatalog}
            runeCatalog={runeCatalog}
            runeNames={runeNames}
            patch={patch}
          />
        )}
      </div>
    </div>
  )
}

/* ============================ Widget ============================ */

function WidgetView({
  status,
  onRefresh,
  onExpand,
  opponent,
  setOpponent,
  champions,
  championNames,
  sample,
  itemCatalog,
  runeCatalog,
  patch,
}: {
  status: ApiStatus | null
  onRefresh: () => void
  onExpand: () => void
  opponent: number
  setOpponent: (id: number) => void
  champions: Champion[]
  championNames: Map<number, string>
  sample: BuildEvidence
  itemCatalog: Map<number, ItemInfo>
  runeCatalog: Map<number, NamedId>
  patch: string
}) {
  const orderedPath = sample.purchasePath.length > 0
  const pathItems = orderedPath
    ? sample.purchasePath.slice(0, 6).map((item) => ({
      id: item.id,
      count: item.games,
      winRate: sample.items.find((entry) => entry.id === item.id)?.winRate ?? sample.winRate,
      minute: Math.round(item.averageMinute),
    }))
    : sample.items.slice(0, 6).map((item) => ({ ...item, minute: null as number | null }))
  const opponentName = opponent ? championNames.get(opponent) ?? `#${opponent}` : null

  return (
    <div className="widget-shell">
      <div className="widget-card">
        <header className="widget-header">
          <div>
            <p className="eyebrow">Patch {patch || 'unknown'}</p>
            <h1>Irelia vs {opponentName ?? 'lane'}</h1>
          </div>
          <button type="button" className="action-button secondary-action" onClick={onExpand}>Full dashboard</button>
        </header>
        <section className="widget-composition">
          <div>
            <span>Lane opponent</span>
            <select value={opponent} onChange={(event) => setOpponent(Number(event.target.value))}>
              <option value={0}>Any (whole lane route)</option>
              {champions.map((champion) => (
                <option key={champion.id} value={champion.id}>{champion.name}</option>
              ))}
            </select>
          </div>
        </section>
        <main className="widget-build">
          <div className="widget-build-heading">
            <div>
              <p className="eyebrow">Observed Irelia games vs this lane</p>
              <h2>{sample.sample ? `${sample.sample} matching games` : 'No matching build sample'}</h2>
            </div>
            {sample.sample > 0 && <strong className="widget-win-rate">{percent(sample.winRate)} WR</strong>}
          </div>
          {sample.sample > 0 ? (
            <>
              <p className="widget-path-label">{orderedPath ? 'Observed purchase order · first 15 minutes' : 'Common completed items · order unavailable'}</p>
              <div className="widget-item-path">
                {pathItems.map((item, index) => (
                  <div className="widget-path-step" key={item.id}>
                    <span className="widget-step-number">{index + 1}</span>
                    <ItemOption id={item.id} count={item.count} winRate={item.winRate} item={itemCatalog.get(item.id)} patch={patch} />
                    {item.minute !== null && <span className="widget-purchase-time">~{item.minute}m</span>}
                  </div>
                ))}
              </div>
              <div className="widget-runes">
                <span>Common runes</span>
                <div className="match-rune-row">
                  {sample.runes.slice(0, 6).map((rune) => {
                    const detail = runeCatalog.get(rune.id)
                    return detail?.icon ? (
                      <img key={rune.id} src={`https://ddragon.leagueoflegends.com/cdn/img/${detail.icon}`} alt={detail.name} title={`${detail.name} · ${rune.count} games`} width="30" height="30" loading="lazy" />
                    ) : <span key={rune.id}>{detail?.name ?? `Rune ${rune.id}`}</span>
                  })}
                </div>
              </div>
            </>
          ) : <p className="empty-state">Set a mock or live composition, then run a KR scan when online. No unsupported build is guessed.</p>}
          <p className="widget-caveat">Historical evidence, not a guaranteed optimal build. Match counts are shown; small samples are uncertain.</p>
        </main>
      </div>
      <ApiUsagePanel status={status} onRefresh={onRefresh} />
    </div>
  )
}

type CacheStats = {
  matchFiles: number
  timelineFiles: number
  ireliaGames: number
  topGames: number
  midGames: number
  matchupCount: number
  target: number
  cacheBytes?: number
  cacheLimitBytes?: number
}

type MatchupSummary = {
  opponentChampionId: number
  opponentName: string
  games: number
  shrunkenWinRate: number
}

type CoverageEntry = {
  opponentChampionId: number
  opponentName: string
  games: number
  covered: boolean
}

type CoverageReport = {
  lane: string | null
  patch: string
  target: number
  matchups: CoverageEntry[]
  coveredCount: number
  totalCount: number
  gamesNeeded: number
}

type OtpProfileSummary = {
  riotId: string
  puuid: string
  region: string
  harvestedAt: number
  patch: string
  games: number
  ireliaGames: number
}

type DeepenOutcome = {
  coverage: CoverageReport
  matchesAdded: number
  pagesWalked: number
  requestsUsed: number
  stopReason: string
  candidates: number
}

type LiveGame = {
  inGame: boolean
  gameTime: number
  player: {
    summonerName: string
    championName: string
    team: string
    level: number
    creepScore: number
    wardScore: number
    kills: number
    deaths: number
    assists: number
    csPerMin: number
  } | null
  benchmark: { avgCsPerMin: number; avgVisionPerMin: number; sampleGames: number } | null
}

/** Compact live CS + vision tracker shown at the top while a game is running,
 *  or a "not in game" state otherwise. */
function LiveGameBar({ live }: { live: LiveGame | null }) {
  if (!live || !live.inGame || !live.player) {
    return (
      <section className="live-game-bar" aria-live="polite">
        <span className="live-game-status"><span className="dot" />Not in a live game</span>
        <span className="live-game-stat"><small>CS</small><strong>—</strong></span>
        <span className="live-game-stat"><small>Vision</small><strong>—</strong></span>
        <span className="live-game-benchmark">Start a match to track CS &amp; vision</span>
      </section>
    )
  }
  const minutes = Math.floor(live.gameTime / 60)
  const seconds = Math.floor(live.gameTime % 60)
  const csDelta = live.player.csPerMin - (live.benchmark?.avgCsPerMin ?? 0)
  const visionDelta = live.player.wardScore - ((live.benchmark?.avgVisionPerMin ?? 0) * (live.gameTime / 60))
  return (
    <section className="live-game-bar is-live" aria-live="polite">
      <span className="live-game-status">
        <span className="dot" />
        Live · {minutes}:{String(seconds).padStart(2, '0')}
      </span>
      <span className="live-game-stat"><small>CS</small><strong>{live.player.creepScore}</strong><em>{live.player.csPerMin.toFixed(1)}/min</em></span>
      <span className="live-game-stat"><small>Vision</small><strong>{live.player.wardScore}</strong></span>
      <span className="live-game-stat"><small>KDA</small><strong>{live.player.kills}/{live.player.deaths}/{live.player.assists}</strong></span>
      <span className="live-game-stat"><small>Level</small><strong>{live.player.level}</strong></span>
      {live.benchmark && (
        <span className="live-game-benchmark" title={`Benchmark from ${live.benchmark.sampleGames} cached Irelia games`}>
          vs pool: CS {csDelta >= 0 ? '+' : ''}{csDelta.toFixed(1)}/min · Vision {visionDelta >= 0 ? '+' : ''}{Math.round(visionDelta)}
        </span>
      )}
    </section>
  )
}

/* ============================ Data Management ============================ */

function DataManagementView({
  cacheStats, statsLoading, onRefreshStats, refreshTick,
  scan, progress, busy, onScan, onStop, onRefresh, apiReady, clientStatus,
  championFiles, patch, onCacheCleared, onDataChanged,
}: {
  cacheStats: CacheStats | null
  statsLoading: boolean
  onRefreshStats: () => void
  /** Bumped by "Reload counters" so this view's own fetches run again too. */
  refreshTick: number
  scan: OtpScan | null
  progress: ScanProgress | null
  busy: string | null
  onScan: () => void
  onStop: () => void
  onRefresh: () => void
  apiReady: boolean
  clientStatus: ClientStatus | null
  championFiles: Map<number, string>
  patch: string
  /** Drops the in-memory + persisted scan snapshot so a wipe is really a reset. */
  onCacheCleared: () => void
  /** The harvested pool changed (deepen/prune): recompute the Stats build. */
  onDataChanged: () => void
}) {
  const target = cacheStats?.target ?? POOL_TARGET
  const games = cacheStats?.ireliaGames ?? 0
  const scanning = busy === 'scan'
  const pctToTarget = Math.min(100, Math.round((games / target) * 100))
  const [matchups, setMatchups] = useState<MatchupSummary[] | null>(null)
  // Wiping the cache is destructive, so it takes two deliberate clicks.
  const [clearStage, setClearStage] = useState<'idle' | 'confirm' | 'working'>('idle')
  const [clearMessage, setClearMessage] = useState('')
  // Quality pruning under the storage cap is a gentler version of the wipe:
  // it drops the worst matches and keeps the good ones.
  const [pruneStage, setPruneStage] = useState<'idle' | 'confirm' | 'working'>('idle')
  const [pruneMessage, setPruneMessage] = useState('')

  function pruneWorst() {
    setPruneStage('working')
    setPruneMessage('')
    void apiGet<{ removedMatches: number; freedBytes: number; afterBytes: number; note: string }>('/api/riot/cache/prune?confirm=PRUNE')
      .then((result) => {
        setPruneMessage(`Pruned ${result.removedMatches} lowest-quality matches (${formatBytesLocal(result.freedBytes)}). ${result.note}`)
        onRefreshStats()
        onDataChanged()
      })
      .catch((reason: unknown) => setPruneMessage(reason instanceof Error ? reason.message : 'Could not prune the cache.'))
      .finally(() => setPruneStage('idle'))
  }
  // Coverage-driven deepening: how far the pool still is from a readable sample
  // per matchup, and the walk that closes the gap.
  const [coverageLane, setCoverageLane] = useState<'TOP' | 'MID'>('TOP')
  const [coverage, setCoverage] = useState<CoverageReport | null>(null)
  const [deepening, setDeepening] = useState(false)
  const [deepenProgress, setDeepenProgress] = useState<ScanProgress | null>(null)
  const [deepenSummary, setDeepenSummary] = useState('')
  const [deepenSource, setDeepenSource] = useState<EventSource | null>(null)

  useEffect(() => {
    let cancelled = false
    void apiGet<CoverageReport>(`/api/riot/coverage?lane=${coverageLane}&target=${MATCHUP_TARGET}`)
      .then((data) => { if (!cancelled) setCoverage(data) })
      .catch(() => { if (!cancelled) setCoverage(null) })
    return () => { cancelled = true }
  }, [coverageLane, refreshTick])

  /**
   * Walks the last scan's one-tricks backwards through their match history until
   * every matchup in the lane reaches the target. Progress is streamed, so the
   * extension is observable rather than something you have to take on faith.
   */
  function startDeepen() {
    if (deepening) {
      deepenSource?.close()
      setDeepenSource(null)
      setDeepening(false)
      setDeepenProgress(null)
      setDeepenSummary('Stopped. Everything pulled so far is kept.')
      return
    }
    setDeepening(true)
    setDeepenSummary('')
    setDeepenProgress({ phase: 'coverage', message: 'Measuring matchup coverage…', done: 0, total: 0 })

    const source = new EventSource(`/api/riot/deepen-stream?lane=${coverageLane}&target=${MATCHUP_TARGET}&budget=400`)
    setDeepenSource(source)
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as
          | { type: 'progress'; phase: string; message: string; done: number; total: number }
          | { type: 'result'; result: DeepenOutcome }
          | { type: 'error'; message: string }
        if (payload.type === 'progress') {
          setDeepenProgress({ phase: payload.phase, message: payload.message, done: payload.done, total: payload.total })
        } else if (payload.type === 'result') {
          setCoverage(payload.result.coverage)
          setDeepenProgress(null)
          setDeepening(false)
          setDeepenSource(null)
          setDeepenSummary(
            payload.result.matchesAdded === 0
              ? `Nothing further back to find — ${payload.result.coverage.coveredCount} of ${payload.result.coverage.totalCount} matchups at target.`
              : `Added ${payload.result.matchesAdded} older games from ${payload.result.candidates} one-tricks · walked ${payload.result.pagesWalked} history pages · ${payload.result.requestsUsed} API calls · stopped: ${payload.result.stopReason.replace('-', ' ')}`,
          )
          source.close()
          onRefreshStats()
          onDataChanged()
        } else if (payload.type === 'error') {
          setDeepenSummary(payload.message)
          setDeepening(false)
          setDeepenSource(null)
          source.close()
        }
      } catch {
        // Keep-alive frames are not JSON.
      }
    }
    source.onerror = () => {
      setDeepening(false)
      setDeepenSource(null)
      setDeepenProgress(null)
      source.close()
    }
  }

  // OTP of choice: walk one named player's history back through the current
  // patch and keep the profile for the Stats comparison. Replacing the OTP
  // keeps the previous profile in the archive.
  const [otpInput, setOtpInput] = useState('')
  const [otpRegion, setOtpRegion] = useState<'KR' | 'EUW' | 'EUNE' | 'NA'>('KR')
  const [otpHarvesting, setOtpHarvesting] = useState(false)
  const [otpProgress, setOtpProgress] = useState<ScanProgress | null>(null)
  const [otpMessage, setOtpMessage] = useState('')
  const [otpState, setOtpState] = useState<{ active: { puuid: string; riotId: string; savedAt: number } | null; profiles: OtpProfileSummary[] } | null>(null)
  const [otpSource, setOtpSource] = useState<EventSource | null>(null)

  useEffect(() => {
    let cancelled = false
    void apiGet<{ active: { puuid: string; riotId: string; savedAt: number } | null; profiles: OtpProfileSummary[] }>('/api/riot/otp-profile')
      .then((data) => { if (!cancelled) setOtpState(data) })
      .catch(() => { if (!cancelled) setOtpState(null) })
    return () => { cancelled = true }
  }, [refreshTick])

  useEffect(() => () => { otpSource?.close() }, [otpSource])

  function startOtpHarvest() {
    const raw = otpInput.trim()
    const separator = raw.lastIndexOf('#')
    const gameName = separator > 0 ? raw.slice(0, separator).trim() : ''
    const tagLine = separator > 0 ? raw.slice(separator + 1).trim() : ''
    if (!gameName || !tagLine) {
      setOtpMessage('Give the OTP as Name#TAG, e.g. IRELKING#0729.')
      return
    }
    setOtpHarvesting(true)
    setOtpMessage('')
    setOtpProgress({ phase: 'otp', message: 'Resolving Riot ID…', done: 0, total: 0 })
    const source = new EventSource(`/api/riot/otp-harvest-stream?gameName=${encodeURIComponent(gameName)}&tagLine=${encodeURIComponent(tagLine)}&region=${otpRegion}&budget=800`)
    setOtpSource(source)
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as
          | { type: 'progress'; phase: string; message: string; done: number; total: number }
          | { type: 'result'; result: { riotId: string; patch: string; games: number; ireliaGames: number; requestsUsed: number; stopReason: string } }
          | { type: 'error'; message: string }
        if (payload.type === 'progress') {
          setOtpProgress({ phase: payload.phase, message: payload.message, done: payload.done, total: payload.total })
        } else if (payload.type === 'result') {
          setOtpHarvesting(false)
          setOtpProgress(null)
          setOtpSource(null)
          setOtpMessage(`Harvested ${payload.result.riotId}: ${payload.result.games} games on patch ${payload.result.patch} (${payload.result.ireliaGames} on Irelia) · stopped at the patch boundary.`)
          source.close()
          void apiGet<{ active: { puuid: string; riotId: string; savedAt: number } | null; profiles: OtpProfileSummary[] }>('/api/riot/otp-profile')
            .then((data) => setOtpState(data))
            .catch(() => {})
          onDataChanged()
        } else if (payload.type === 'error') {
          setOtpHarvesting(false)
          setOtpProgress(null)
          setOtpSource(null)
          setOtpMessage(payload.message)
          source.close()
        }
      } catch {
        // Keep-alive frames are not JSON.
      }
    }
    source.onerror = () => {
      setOtpHarvesting(false)
      setOtpProgress(null)
      setOtpSource(null)
      source.close()
    }
  }

  function wipeCache() {
    setClearStage('working')
    setClearMessage('')
    void apiGet<{ filesRemoved: number; kept: string[] }>('/api/riot/cache/clear?confirm=DELETE')
      .then((result) => {
        setClearMessage(`Deleted ${result.filesRemoved} cached files. Kept: ${result.kept.join(', ')}.`)
        setMatchups(null)
        onCacheCleared()
        onRefreshStats()
      })
      .catch((reason: unknown) => setClearMessage(reason instanceof Error ? reason.message : 'Could not clear the cache.'))
      .finally(() => setClearStage('idle'))
  }

  useEffect(() => {
    let cancelled = false
    void apiGet<{ matchups: MatchupSummary[] }>('/api/riot/matchups?lane=TOP')
      .then((data) => { if (!cancelled) setMatchups(data.matchups) })
      .catch(() => { if (!cancelled) setMatchups(null) })
    return () => { cancelled = true }
  }, [refreshTick])

  return (
    <div className="view-grid">
      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Scan</p>
            <h2>Harvest games</h2>
          </div>
        </div>
        <p className="microcopy">
          Crawls the regional ladders for Irelia one-tricks and pulls their recent games until the pool is deep enough
          for reliable builds.
        </p>
        <div className="action-grid">
          <div className="action-item">
            {!scanning ? (
              <button type="button" className="action-button" onClick={onScan} disabled={!apiReady}>
                {scan ? 'Continue scan' : 'Start scan'}
              </button>
            ) : (
              <button type="button" className="action-button secondary-action" onClick={onStop}>Stop scan</button>
            )}
            <p className="action-note">
              {scanning
                ? 'Stops the running scan. Every game already saved is kept.'
                : 'Searches the regional ladders and the priority one-tricks, then saves their recent games.'}
            </p>
          </div>
          <div className="action-item">
            <button type="button" className="action-button secondary-action" onClick={onRefresh} disabled={!apiReady || scanning}>
              Force fresh scan
            </button>
            <p className="action-note">
              Ignores the cache and re-downloads the newest games. Slower, but picks up today's matches.
            </p>
          </div>
          <div className="action-item">
            <button type="button" className="action-button ghost-action" onClick={onRefreshStats}>Reload counters</button>
            <p className="action-note">
              Re-reads the saved totals below. This never deletes anything.
            </p>
          </div>
        </div>
        {progress && (
          <div className="scan-progress" style={{ marginTop: 12 }}>
            <div className="scan-progress-head"><span>{progress.phase}</span><span>{progress.message}</span></div>
            <progress value={progress.done} max={Math.max(progress.total, 1)} />
          </div>
        )}
        {!apiReady && <p className="caveat">Riot API key missing. Add RIOT_API_KEY to .env.local and restart.</p>}
        <p className="microcopy">Goal: {target} Irelia games for ±5% confidence. Stop anytime; cached data is kept.</p>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Cached data</p>
            <h2>Current pool</h2>
          </div>
        </div>
        {statsLoading && !cacheStats && <p className="empty-state">Loading cache stats…</p>}
        {cacheStats && (
          <>
            <div className="stat-row">
              <div className="stat-cell"><span>Irelia games</span><strong>{cacheStats.ireliaGames}</strong></div>
              <div className="stat-cell"><span>TOP / MID</span><strong>{cacheStats.topGames} / {cacheStats.midGames}</strong></div>
              <div className="stat-cell"><span>Matchups covered</span><strong>{cacheStats.matchupCount}</strong></div>
            </div>
            <div className="stat-row" style={{ marginTop: 10 }}>
              <div className="stat-cell"><span>Match files</span><strong>{cacheStats.matchFiles}</strong></div>
              <div className="stat-cell"><span>Timeline files</span><strong>{cacheStats.timelineFiles}</strong></div>
              <div className="stat-cell">
                <span>Disk used · cap {formatBytesLocal(cacheStats.cacheLimitBytes ?? 0)}</span>
                <strong>{formatBytesLocal(cacheStats.cacheBytes ?? 0)}</strong>
              </div>
            </div>
            <div style={{ marginTop: 14 }}>
              <span className="microcopy">Progress toward ±5% goal ({games}/{target})</span>
              <progress value={games} max={target} style={{ width: '100%', marginTop: 6 }} />
              <span className="microcopy">{pctToTarget}% of target</span>
            </div>
            <p className="caveat">
              {clientStatus?.connected
                ? 'League Client is open — pause scanning and use the live draft data instead.'
                : 'Client is offline; scanning is safe to run.'}
            </p>
          </>
        )}
      </section>

      <section className="panel span-full">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Full builds on the go</p>
            <h2>Matchup coverage</h2>
          </div>
          <div className="coverage-controls">
            <div className="ot-tabs" role="tablist">
              {(['TOP', 'MID'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="tab"
                  aria-selected={coverageLane === option}
                  className={coverageLane === option ? 'is-active' : ''}
                  onClick={() => setCoverageLane(option)}
                >
                  {option}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={deepening ? 'action-button secondary-action' : 'action-button'}
              onClick={startDeepen}
              disabled={scanning}
              title={scanning ? 'Stop the scan first' : `Walk the one-tricks' history backwards until each matchup reaches ${MATCHUP_TARGET} games`}
            >
              {deepening ? 'Stop deepening' : `Deepen to ${MATCHUP_TARGET} games`}
            </button>
          </div>
        </div>

        {coverage && (
          <div className="coverage-summary">
            <div className="stat-row">
              <div className="stat-cell">
                <span>Matchups at {coverage.target}+ games · patch {coverage.patch}</span>
                <strong>{coverage.coveredCount} / {coverage.totalCount}</strong>
              </div>
              <div className="stat-cell">
                <span>Games still needed</span>
                <strong>{coverage.gamesNeeded}</strong>
              </div>
              <div className="stat-cell">
                <span>Pool target (±5%)</span>
                <strong>{POOL_TARGET}</strong>
              </div>
            </div>
            <p className="microcopy">
              A scan pulls each one-trick&apos;s most recent games once. Deepening walks
              {' '}<em>further back</em> through their history and keeps pulling until every
              matchup reaches {coverage.target} games <em>on the current patch</em>, the history runs out, or the
              request budget is spent. Games from older patches never count toward the target. The thinnest
              matchups are listed first below.
            </p>
          </div>
        )}

        {deepenProgress && (
          <div className="scan-progress" style={{ marginBottom: 12 }}>
            <div className="scan-progress-head"><span>{deepenProgress.phase}</span><span>{deepenProgress.message}</span></div>
            <progress value={deepenProgress.done} max={Math.max(deepenProgress.total, 1)} />
          </div>
        )}
        {deepenSummary && <p className="action-note" role="status" style={{ marginBottom: 12 }}>{deepenSummary}</p>}

        {matchups === null && <p className="empty-state">Loading matchup builds…</p>}
        {matchups && matchups.length === 0 && <p className="empty-state">No matchup builds yet — run a scan first.</p>}
        {matchups && matchups.length > 0 && (
          <div className="matchup-grid">
            {matchups.map((entry) => {
              // Data Dragon image key, NOT the display name: Wukong -> MonkeyKing,
              // Nunu & Willump -> Nunu, Cho'Gath -> Chogath.
              const file = championFiles.get(entry.opponentChampionId)
              const coverage = Math.min(100, Math.round((entry.games / MATCHUP_TARGET) * 100))
              const tone = entry.shrunkenWinRate >= 0.52 ? 'is-good' : entry.shrunkenWinRate <= 0.48 ? 'is-bad' : ''
              return (
                <div
                  className="matchup-cell"
                  key={entry.opponentChampionId}
                  title={`${entry.opponentName} · ${entry.games} games · ${Math.round(entry.shrunkenWinRate * 100)}% win rate`}
                >
                  <span className="matchup-icon">
                    {file && (
                      <img
                        src={`https://ddragon.leagueoflegends.com/cdn/${patch}/img/champion/${file}.png`}
                        alt={entry.opponentName}
                        loading="lazy"
                        onError={(event) => {
                          const image = event.currentTarget as HTMLImageElement
                          image.style.display = 'none'
                          image.parentElement?.classList.add('is-missing-icon')
                        }}
                      />
                    )}
                    <span className="matchup-fallback">{entry.opponentName.slice(0, 3)}</span>
                  </span>
                  <span className="matchup-bar"><span className={`matchup-fill ${tone}`} style={{ width: `${coverage}%` }} /></span>
                  <span className="matchup-games">{entry.games}</span>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">OTP of choice</p>
            <h2>Source a player&apos;s history</h2>
          </div>
        </div>
        <p className="microcopy">
          Walk one Irelia main&apos;s ranked history back through the current patch — the deep, consistent
          evidence the scan&apos;s 40-game windows can&apos;t reach. Stops automatically at the first page of
          older-patch games, so the data never goes stale.
        </p>
        <div className="account-form">
          <label>
            <span>Riot ID (Name#TAG)</span>
            <input
              value={otpInput}
              onChange={(event) => setOtpInput(event.target.value)}
              placeholder="IRELKING#0729"
              disabled={otpHarvesting}
            />
          </label>
          <label>
            <span>Region</span>
            <select
              value={otpRegion}
              onChange={(event) => setOtpRegion(event.target.value as 'KR' | 'EUW' | 'EUNE' | 'NA')}
              disabled={otpHarvesting}
            >
              <option value="KR">KR</option>
              <option value="EUW">EUW</option>
              <option value="EUNE">EUNE</option>
              <option value="NA">NA</option>
            </select>
          </label>
        </div>
        <div className="action-grid">
          <div className="action-item">
            <button type="button" className="action-button" onClick={startOtpHarvest} disabled={!apiReady || otpHarvesting}>
              {otpHarvesting ? 'Walking history…' : 'Source OTP history'}
            </button>
            <p className="action-note">
              Budgeted at 800 requests. Replace the OTP anytime — the previous profile stays in the archive
              for the Stats comparison.
            </p>
          </div>
        </div>
        {otpProgress && <ScanProgressBar progress={otpProgress} busy={otpHarvesting} />}
        {otpMessage && <p className="caveat">{otpMessage}</p>}
        {otpState?.active && otpState.profiles.length > 0 && (
          <div className="stat-row">
            <div className="stat-cell"><span>Active OTP</span><strong>{otpState.active.riotId}</strong></div>
            <div className="stat-cell"><span>Patch</span><strong>{otpState.profiles[0].patch}</strong></div>
            <div className="stat-cell"><span>Games (Irelia)</span><strong>{otpState.profiles[0].ireliaGames} / {otpState.profiles[0].games}</strong></div>
          </div>
        )}
        {otpState && otpState.profiles.length > 1 && (
          <p className="microcopy">
            Archive: {otpState.profiles.slice(1).map((profile) => `${profile.riotId} · patch ${profile.patch} · ${profile.ireliaGames} Irelia games`).join(' | ')}
          </p>
        )}
      </section>

      <section className="panel span-full danger-zone">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Danger zone</p>
            <h2>Delete cached data</h2>
          </div>
        </div>
        <p className="microcopy">
          Removes every saved match and timeline so harvesting starts from scratch. Your priority one-trick
          roster is kept — that is your own list, not harvested evidence.
        </p>
        {clearStage === 'idle' && (
          <button
            type="button"
            className="action-button danger-action"
            onClick={() => { setClearMessage(''); setClearStage('confirm') }}
            disabled={scanning}
            title={scanning ? 'Stop the scan first' : 'Delete all cached matches and timelines'}
          >
            Delete all cached data
          </button>
        )}
        {clearStage !== 'idle' && (
          <div className="confirm-row">
            <span className="confirm-text">
              This cannot be undone. Delete {cacheStats?.matchFiles ?? 0} matches and {cacheStats?.timelineFiles ?? 0} timelines?
            </span>
            <button type="button" className="action-button danger-action" onClick={wipeCache} disabled={clearStage === 'working'}>
              {clearStage === 'working' ? 'Deleting…' : 'Yes, delete everything'}
            </button>
            <button type="button" className="action-button ghost-action" onClick={() => setClearStage('idle')} disabled={clearStage === 'working'}>
              Cancel
            </button>
          </div>
        )}
        {clearMessage && <p className="action-note" role="status">{clearMessage}</p>}

        <div className="danger-divider" />

        <p className="microcopy">
          <strong>Storage cap:</strong> if the cache ever outgrows the cap, prune the lowest-quality matches instead
          of wiping everything. It keeps the good data and drops the worst.
        </p>
        {pruneStage === 'idle' && (
          <button
            type="button"
            className="action-button secondary-action"
            onClick={() => { setPruneMessage(''); setPruneStage('confirm') }}
            disabled={scanning}
            title="Drops only the lowest-quality matches: non-Irelia games, old patches, short games and over-covered matchups"
          >
            Prune low-quality data
          </button>
        )}
        {pruneStage !== 'idle' && (
          <div className="confirm-row">
            <span className="confirm-text">
              Keeps the good data and drops the worst: non-Irelia games, old patches, short games and over-covered
              matchups. Your roster and thin matchups stay.
            </span>
            <button type="button" className="action-button danger-action" onClick={pruneWorst} disabled={pruneStage === 'working'}>
              {pruneStage === 'working' ? 'Pruning…' : 'Yes, prune lowest quality'}
            </button>
            <button type="button" className="action-button ghost-action" onClick={() => setPruneStage('idle')} disabled={pruneStage === 'working'}>
              Cancel
            </button>
          </div>
        )}
        {pruneMessage && <p className="action-note" role="status">{pruneMessage}</p>}
      </section>
    </div>
  )
}

/* ============================ App ============================ */

/** Type for the Electron bridge exposed by preload.cjs. */
type DesktopBridge = { setWidgetMode?: (enabled: boolean) => Promise<unknown> }

function setDesktopWidgetMode(enabled: boolean) {
  const bridge = (window as unknown as { irelia?: DesktopBridge }).irelia
  if (bridge?.setWidgetMode) void bridge.setWidgetMode(enabled)
}

function App() {
  const [apiStatus, setApiStatus] = useState<ApiStatus | null>(null)
  const [catalog, setCatalog] = useState<StaticCatalog | null>(() => readLocal('irelia-fieldbook-catalog-v2', null))
  const [gameName, setGameName] = useState('Dobrezaur')
  const [tagLine, setTagLine] = useState('1733')
  const [playerReport, setPlayerReport] = useState<PlayerReport | null>(null)
  const [scan, setScan] = useState<OtpScan | null>(() => readLocal('irelia-fieldbook-scan-v3', null))
  const [lobby, setLobby] = useState<Lobby | null>(null)
  const [draftMode, setDraftMode] = useState<DraftMode>('mock')
  // v4 also fixes the read/write key mismatch: the read used `-v3` while the
  // write used `-v2`, so the selected view never actually persisted.
  const [view, setView] = useState<ViewName>(() => readLocal('irelia-fieldbook-view-v4', 'onetricks'))
  const [tier] = useState<Tier>('all')
  const [scanRegions] = useState<ScanRegion[]>(() => readLocal<ScanRegion[]>('irelia-fieldbook-regions', ['KR', 'EUW', 'EUNE', 'NA']))
  const [otpLane] = useState<OtpLane | null>(() => readLocal('irelia-fieldbook-otplane', null))
  const [buildFocus, setBuildFocus] = useState<BuildFocus>(() => readLocal('irelia-fieldbook-buildfocus', 'lane'))
  const [laneOpponent, setLaneOpponent] = useState(() => readLocal('irelia-fieldbook-lane', 0))
  const [allyComp, setAllyComp] = useState<number[]>(() => readLocal('irelia-fieldbook-allies', [0, 0, 0, 0]))
  const [enemyComp, setEnemyComp] = useState<number[]>(() => readLocal('irelia-fieldbook-enemies', [0, 0, 0, 0]))
  const [scanSort] = useState<OtpSortMode>('active')
  const [busy, setBusy] = useState<'player' | 'scan' | 'lobby' | null>(null)
  const [error, setError] = useState('')
  const [dockLane, setDockLane] = useState<OtpLane>(() => readLocal('irelia-fieldbook-docklane', 'TOP'))
  // Deliberately NOT persisted: an auto-detected draft opponent from a past
  // session is meaningless later and would silently pin the build to a matchup
  // that no longer has a sample. It starts fresh at "All opponents" each run.
  const [dockOpponent, setDockOpponent] = useState(0)
  const [dockBuild, setDockBuild] = useState<BuildResponse | null>(null)
  const [dockBuildLoading, setDockBuildLoading] = useState(false)
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null)
  const scanAbortRef = useRef<AbortController | null>(null)
  const [draftBuild, setDraftBuild] = useState<BuildResponse | null>(null)
  const [draftBuildLoading, setDraftBuildLoading] = useState(false)
  const [recommendedBuild, setRecommendedBuild] = useState<BuildResponse | null>(null)
  const [recommendedLoading, setRecommendedLoading] = useState(false)

  /** Stats-page payload: sampled ban rate plus the most recent Irelia games. */
  const [meta, setMeta] = useState<{ banRate: ConfidenceInterval; banSampleGames: number; games: GameRow[] } | null>(null)
  const [metaLoading, setMetaLoading] = useState(false)
  /** Recency window for the stats page (0 = all time). Drives a real refetch. */
  const [sinceHours, setSinceHours] = useState(() => readLocal('irelia-fieldbook-since', 0))
  const [clientStatus, setClientStatus] = useState<ClientStatus | null>(null)
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [liveGame, setLiveGame] = useState<LiveGame | null>(null)
  /**
   * Bumped by tab switches and the Reload counters button. Views key their own
   * fetches to it so a headless rebuild (the builder script runs outside the
   * app) is visible without restarting, and every field refreshes together.
   */
  const [dataVersion, setDataVersion] = useState(0)

  useEffect(() => {
    void apiGet<ApiStatus>('/api/status').then(setApiStatus).catch(() => setApiStatus({ configured: false, mode: 'local', usage: emptyApiUsage }))
    void apiGet<StaticCatalog>('/api/champions')
      .then((data) => {
        setCatalog(data)
        writeLocal('irelia-fieldbook-catalog-v2', data)
      })
      .catch((reason: unknown) => {
        if (!readLocal<StaticCatalog | null>('irelia-fieldbook-catalog-v2', null)) {
          setError(reason instanceof Error ? reason.message : 'Could not load champion data.')
        }
      })
  }, [])

  useEffect(() => {
    if (scan) writeLocal('irelia-fieldbook-scan-v3', scan)
  }, [scan])

  useEffect(() => {
    writeLocal('irelia-fieldbook-docklane', dockLane)
    writeLocal('irelia-fieldbook-dockopp', dockOpponent)
  }, [dockLane, dockOpponent])

  // On mount, pull any saved scan snapshot from the server disk cache so the
  // Dock is populated instantly across restarts without re-scanning.
  useEffect(() => {
    void apiGet<{ scan: OtpScan | null }>('/api/riot/scan')
      .then((data) => { if (data.scan) setScan(data.scan) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    writeLocal('irelia-fieldbook-lane', laneOpponent)
    writeLocal('irelia-fieldbook-allies', allyComp)
    writeLocal('irelia-fieldbook-enemies', enemyComp)
  }, [allyComp, enemyComp, laneOpponent])

  useEffect(() => { writeLocal('irelia-fieldbook-view-v4', view) }, [view])

  // Entering the Widget view shrinks the Electron window into a compact
  // always-on-top widget; leaving restores the full window. No-op in a browser.
  useEffect(() => {
    setDesktopWidgetMode(view === 'widget')
    return () => setDesktopWidgetMode(false)
  }, [view])
  useEffect(() => { writeLocal('irelia-fieldbook-otplane', otpLane) }, [otpLane])
  useEffect(() => { writeLocal('irelia-fieldbook-regions', scanRegions) }, [scanRegions])
  useEffect(() => { writeLocal('irelia-fieldbook-buildfocus', buildFocus) }, [buildFocus])

  const champions = catalog?.champions ?? emptyChampions
  const items = catalog?.items ?? emptyItems
  const runes = catalog?.runes ?? emptyRunes
  const patch = catalog?.version ?? ''
  const championNames = useMemo(() => new Map(champions.map((champion) => [champion.id, champion.name])), [champions])
  /**
   * Champion id -> Data Dragon image key. Required for a handful of champions
   * whose display name does not match their icon filename.
   */
  const championFiles = useMemo(
    () => new Map(champions.map((champion) => [champion.id, champion.ddragonId ?? champion.name.replace(/[^A-Za-z0-9]/g, '')])),
    [champions],
  )
  const itemCatalog = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const runeNames = useMemo(() => new Map(runes.map((rune) => [rune.id, rune.name])), [runes])
  const runeCatalog = useMemo(() => new Map(runes.map((rune) => [rune.id, rune])), [runes])
  /**
   * Rune id -> owning tree name. Only the tree entries (`isTree`) carry the tree
   * name, so this has to be built separately from `runeNames`.
   */
  const runeTreeNames = useMemo(
    () => new Map(
      runes
        .filter((rune) => Boolean(rune.tree))
        .map((rune) => [rune.id, String(rune.tree)]),
    ),
    [runes],
  )
  /**
   * `patch` is the DATA DRAGON asset version (e.g. 16.19.1), which is what item,
   * rune and champion icon URLs are built from.
   *
   * It is deliberately NOT used to filter matches. Game patches and Data Dragon
   * versions are different numbering schemes, and the server already derives the
   * true current game patch from `info.gameVersion`. Sending the Data Dragon
   * version as a patch filter matched nothing. An empty value tells the server to
   * pick the most recent patch that actually has data.
   *
   * Annotated `string` rather than inferred: `const activePatch = ''` would narrow
   * to the empty-string literal, collapsing the `activePatch ? ...` query spreads
   * to `never` and breaking the URLSearchParams overload.
   */
  const activePatch: string = ''

  const lobbyAllyIds = lobby?.myTeam.map((pick) => pick.championId).filter((id) => id > 0 && id !== 39) ?? []
  const lobbyEnemyIds = lobby?.theirTeam.map((pick) => pick.championId).filter((id) => id > 0) ?? []

  const activeOtpCandidates = useMemo(() => {
    if (!scan) return []
    const filtered = scan.analyzed.filter((candidate) => {
      const hasLaneEvidence = candidate.roles.some((role) => role.ireliaGames >= 4 && role.ireliaShare >= 0.15)
      const hasRecentSample = candidate.ireliaGames >= 5
      const hasActivePattern = candidate.isOtp || candidate.ireliaGames >= 7
      return hasActivePattern && (hasLaneEvidence || hasRecentSample)
    })
    return sortOtpCandidates(
      filtered.map((candidate) => ({
        ...candidate,
        matches: candidate.matches.map((match) => normalizeMatchSample(match as unknown as Record<string, unknown>, championNames)),
      })),
      scanSort,
    )
  }, [scan, scanSort, championNames])

  function refreshApiStatus() {
    void apiGet<ApiStatus>('/api/status').then(setApiStatus).catch(() => {})
  }

  async function fetchDockBuild(lane: OtpLane, opponent: number) {
    setDockBuildLoading(true)
    try {
      const query = new URLSearchParams({
        lane,
        source: 'lane',
        patch: activePatch,
        ...(opponent > 0 ? { opponent: String(opponent) } : {}),
      })
      const result = await apiGet<BuildResponse>(`/api/riot/build?${query}`)
      if (result.games === 0 && opponent > 0) {
        // No sample for that matchup yet. Never show a screen of zeros: fall back
        // to the lane baseline so a complete build path is always visible.
        const baseQuery = new URLSearchParams({ lane, source: 'lane', patch: activePatch })
        setDockBuild(await apiGet<BuildResponse>(`/api/riot/build?${baseQuery}`))
      } else {
        setDockBuild(result)
      }
    } catch {
      setDockBuild(null)
    } finally {
      setDockBuildLoading(false)
    }
  }

  useEffect(() => {
    void fetchDockBuild(dockLane, dockOpponent)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dockLane, dockOpponent, activePatch, scan, dataVersion])

  /**
   * Draft build: mirrors the Dock build but is driven by the Draft view picks.
   * Uses the lane opponent when set, otherwise the composition lists.
   */
  async function fetchDraftBuild() {
    const opponents = [laneOpponent, ...enemyComp].filter((id) => id > 0)
    const allies = allyComp.filter((id) => id > 0)
    const source: 'lane' | 'comp' = laneOpponent > 0 ? 'lane' : 'comp'
    if (source === 'comp' && !allies.length && !opponents.length) { setDraftBuild(null); return }
    setDraftBuildLoading(true)
    try {
      const query = new URLSearchParams({
        lane: 'TOP',
        source,
        patch: activePatch,
        ...(source === 'lane' && laneOpponent > 0 ? { opponent: String(laneOpponent) } : {}),
        ...(source === 'comp' ? { allies: allies.join(','), enemies: opponents.join(',') } : {}),
      })
      setDraftBuild(await apiGet<BuildResponse>(`/api/riot/build?${query}`))
    } catch {
      setDraftBuild(null)
    } finally {
      setDraftBuildLoading(false)
    }
  }

  useEffect(() => {
    void fetchDraftBuild()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneOpponent, allyComp, enemyComp, activePatch, scan])

  /**
   * Recommended build: the same server engine the Dock and Draft use, driven by
   * the Recommended view's focus (lane vs composition). Keeping one source of
   * truth means every build surface reports identical numbers.
   */
  async function fetchRecommendedBuild() {
    const opponents = [laneOpponent, ...enemyComp].filter((id) => id > 0)
    const allies = allyComp.filter((id) => id > 0)
    const source: 'lane' | 'comp' = buildFocus === 'lane' ? 'lane' : 'comp'
    if (source === 'lane' && laneOpponent <= 0) { setRecommendedBuild(null); return }
    if (source === 'comp' && !allies.length && !opponents.length) { setRecommendedBuild(null); return }
    setRecommendedLoading(true)
    try {
      const query = new URLSearchParams({
        lane: 'TOP',
        source,
        patch: activePatch,
        ...(source === 'lane' ? { opponent: String(laneOpponent) } : {}),
        ...(source === 'comp' ? { allies: allies.join(','), enemies: opponents.join(',') } : {}),
      })
      setRecommendedBuild(await apiGet<BuildResponse>(`/api/riot/build?${query}`))
    } catch {
      setRecommendedBuild(null)
    } finally {
      setRecommendedLoading(false)
    }
  }

  useEffect(() => {
    void fetchRecommendedBuild()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildFocus, laneOpponent, allyComp, enemyComp, activePatch, scan])

  /**
   * Stats page payload. Fetched from the cache-wide pool, so it populates even
   * when the scan snapshot is empty. Gated on the Stats view so other screens
   * never pay for the ban-rate walk over the cache.
   */
  useEffect(() => {
    if (view !== 'onetricks' && view !== 'otps') return
    let cancelled = false
    setMetaLoading(true)
    const query = new URLSearchParams({
      lane: dockLane,
      ...(activePatch ? { patch: activePatch } : {}),
      ...(sinceHours > 0 ? { since: String(sinceHours) } : {}),
      limit: '50',
    })
    void apiGet<{ banRate: ConfidenceInterval; banSampleGames: number; games: GameRow[] }>(`/api/riot/meta?${query}`)
      .then((data) => { if (!cancelled) setMeta(data) })
      .catch(() => { if (!cancelled) setMeta(null) })
      .finally(() => { if (!cancelled) setMetaLoading(false) })
    return () => { cancelled = true }
  }, [view, dockLane, activePatch, scan, sinceHours, dataVersion])

  useEffect(() => { writeLocal('irelia-fieldbook-since', sinceHours) }, [sinceHours])

  // Poll League Client presence so the draft can be auto-scanned the moment the
  // client starts, without a manual click. Only writes state when the status
  // actually changes so a closed client does not re-render every 5 seconds.
  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const status = await apiGet<ClientStatus>('/api/client/status')
        if (!cancelled) {
          setClientStatus((previous) =>
            previous?.connected === status.connected && previous?.inChampSelect === status.inChampSelect
              ? previous
              : status,
          )
        }
      } catch {
        if (!cancelled) setClientStatus(null)
      }
    }
    void poll()
    const timer = setInterval(poll, 5_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  async function refreshCacheStats() {
    setStatsLoading(true)
    try {
      setCacheStats(await apiGet<CacheStats>('/api/riot/stats'))
    } catch {
      setCacheStats(null)
    } finally {
      setStatsLoading(false)
    }
  }

  /**
   * Refreshes every number the UI shows, together. The scan snapshot refetch is
   * the linchpin: replacing it re-triggers the meta, build and cache-stat
   * effects through their `scan` dependency, and the dataVersion bump covers
   * the panels that key on it directly (coverage, matchups). All calls are to
   * the local server, so this is cheap and safe to run on every tab switch.
   */
  function refreshAllData() {
    refreshApiStatus()
    void refreshCacheStats()
    void apiGet<{ scan: OtpScan | null }>('/api/riot/scan')
      .then((data) => { if (data.scan) setScan(data.scan) })
      .catch(() => {})
    setDataVersion((version) => version + 1)
  }

  /**
   * After a cache wipe the persisted scan snapshot and the meta panel describe
   * matches that no longer exist, so both are dropped. Otherwise "start fresh"
   * would still show stale candidates.
   */
  function handleCacheCleared() {
    setScan(null)
    setMeta(null)
    writeLocal('irelia-fieldbook-scan-v3', null)
  }

  // When champ select is open, auto-fill the lane opponent so the Stats build
  // reacts to the real draft without a manual pick. When it closes, release the
  // pick so the build returns to the lane baseline instead of pinning a matchup
  // from a draft that no longer exists.
  useEffect(() => {
    if (!clientStatus?.inChampSelect) {
      setDockOpponent(0)
      return
    }
    let cancelled = false
    async function poll() {
      try {
        const lobbyData = await apiGet<Lobby>('/api/client/champ-select')
        if (cancelled || !lobbyData) return
        const me = lobbyData.myTeam.find((pick) => pick.championId === 39)
        const myPosition = me?.assignedPosition
        if (!myPosition) return
        const enemy = lobbyData.theirTeam.find((pick) => pick.assignedPosition === myPosition)
        if (enemy?.championId && enemy.championId > 0) setDockOpponent(enemy.championId)
      } catch {
        // Champ select ended or is not readable.
      }
    }
    void poll()
    const timer = setInterval(poll, 4_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [clientStatus?.inChampSelect, setDockOpponent])

  useEffect(() => {
    void refreshCacheStats()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scan])

  // Poll the Live Client Data API only while the League Client is connected, so
  // a closed client never triggers the 2.5s re-render that caused flicker. When
  // the client is closed the tracker stays hidden and no request fires.
  useEffect(() => {
    if (!clientStatus?.connected) {
      setLiveGame(null)
      return
    }
    let cancelled = false
    async function poll() {
      try {
        const data = await apiGet<LiveGame>('/api/live/game')
        if (!cancelled) setLiveGame((previous) =>
          previous?.inGame === data.inGame && previous.player?.creepScore === data.player?.creepScore && previous.player?.wardScore === data.player?.wardScore
            ? previous
            : data,
        )
      } catch {
        if (!cancelled) setLiveGame(null)
      }
    }
    void poll()
    const timer = setInterval(poll, 2_500)
    return () => { cancelled = true; clearInterval(timer) }
  }, [clientStatus?.connected])

  /**
   * Streams the KR scan via SSE so the UI shows live progress. Falls back to
   * the single-shot endpoint if streaming is unavailable.
   */
  async function runStreamedScan(refresh: boolean, rosterOnly = false) {
    setBusy('scan')
    setError('')
    setScanProgress({
      phase: 'starting',
      message: rosterOnly ? 'Scanning the one-trick roster…' : refresh ? 'Refreshing latest games…' : 'Starting KR scan…',
      done: 0,
      total: 0,
    })
    const controller = new AbortController()
    scanAbortRef.current = controller
    try {
      const result = await streamKoreanScan({
        tier,
        lane: otpLane,
        regions: scanRegions,
        rosterOnly,
        onProgress: setScanProgress,
        signal: controller.signal,
      })
      setScan(result)

      /**
       * Fallback sourcing. When a full high-rank pass downloads nothing new, the
       * apex pool is exhausted for these patches, so widen to Emerald+ and let
       * the sparse matchups fill in rather than returning a half-covered pool.
       */
      if (!rosterOnly && tier !== 'emerald' && (result.newGames ?? 0) === 0) {
        setScanProgress({
          phase: 'fallback',
          message: 'No new high-rank games — widening to Emerald+ to cover the remaining matchups…',
          done: 0,
          total: 0,
        })
        const widened = await streamKoreanScan({
          tier: 'emerald',
          lane: otpLane,
          regions: scanRegions,
          rosterOnly: false,
          onProgress: setScanProgress,
          signal: controller.signal,
        })
        setScan(widened)
      }
      // After a fresh scan, recompute the Dock build against the new data.
      void fetchDockBuild(dockLane, dockOpponent)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Could not scan KR ranked candidates.'
      if (message !== 'Scan stopped.') setError(message)
    } finally {
      setBusy(null)
      scanAbortRef.current = null
      refreshApiStatus()
    }
  }

  function stopScan() {
    scanAbortRef.current?.abort()
  }

  async function loadPlayer() {
    setBusy('player')
    setError('')
    try {
      const query = new URLSearchParams({ gameName, tagLine, region: 'EUROPE', count: '20' })
      const report = await apiGet<PlayerReport>(`/api/riot/player?${query}`)
      setPlayerReport({
        ...report,
        matches: report.matches.map((match) => normalizeMatchSample(match as unknown as Record<string, unknown>, championNames)),
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load player history.')
    } finally {
      setBusy(null)
      refreshApiStatus()
    }
  }

  async function scanKorea() {
    await runStreamedScan(false)
  }

  async function refreshKorea() {
    await runStreamedScan(true)
  }

  async function readLobby(silent = false) {
    if (!silent) setBusy('lobby')
    setError('')
    try {
      setLobby(await apiGet<Lobby>('/api/client/champ-select'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not read champion select.')
    } finally {
      if (!silent) setBusy(null)
    }
  }

  function updateComp(team: 'ally' | 'enemy', index: number, value: number) {
    if (team === 'ally') {
      setAllyComp((current) => current.map((id, slot) => slot === index ? value : id))
    } else {
      setEnemyComp((current) => current.map((id, slot) => slot === index ? value : id))
    }
  }

  function clearMock() {
    setLaneOpponent(0)
    setAllyComp([0, 0, 0, 0])
    setEnemyComp([0, 0, 0, 0])
  }

  const apiReady = Boolean(apiStatus?.configured)
  const navItems: Array<{ id: ViewName; label: string; badge?: number }> = [
    { id: 'onetricks', label: 'Stats' },
    { id: 'datamanagement', label: 'Data' },
    { id: 'otps', label: 'Onetrick', badge: scan ? activeOtpCandidates.length : undefined },
  ]

  if (view === 'widget') {
    return (
      <ViewErrorBoundary label="Widget">
        <WidgetView
          status={apiStatus}
          onRefresh={refreshApiStatus}
          onExpand={() => setView('onetricks')}
          opponent={dockOpponent}
          setOpponent={setDockOpponent}
          champions={champions}
          championNames={championNames}
          sample={buildResponseToEvidence(dockBuild)}
          itemCatalog={itemCatalog}
          runeCatalog={runeCatalog}
          patch={patch}
        />
      </ViewErrorBoundary>
    )
  }

  return (
    <div className="app-shell">
      <header className="dashboard-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M4 14c4-1 6-4 7-9 1 5 3 8 7 9-4 1-6 3-7 7-1-4-3-6-7-7Z" fill="currentColor" />
            </svg>
          </span>
          <span className="brand-copy">
            <strong>Irelia Build Tracker</strong>
            <span>Personal KR Irelia research · EUNE player</span>
          </span>
        </div>
        <div className="header-tools">
          <div className={`connection-state ${apiReady ? 'is-ready' : 'is-missing'}`}>
            <span className="status-dot" />
            {apiReady ? 'Riot API key loaded' : 'Riot API key missing'}
          </div>
          <div className={`connection-state ${clientStatus?.connected ? 'is-ready' : 'is-missing'}`} title={clientStatus?.connected ? (clientStatus.inChampSelect ? 'League Client connected and in champion select.' : 'League Client connected.') : 'League Client not detected. Start it to auto-scan your draft.'}>
            <span className="status-dot" />
            {clientStatus?.connected
              ? (clientStatus.inChampSelect ? 'League Client · in champ select' : 'League Client · connected')
              : 'League Client · not running'}
          </div>
          <ApiUsagePanel status={apiStatus} onRefresh={refreshApiStatus} />
        </div>
      </header>

      <nav className="main-nav" aria-label="Sections">
        {navItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`nav-button ${view === item.id ? 'active' : ''}`}
            aria-current={view === item.id ? 'page' : undefined}
            onClick={() => {
              if (item.id === 'champselect') {
                setDraftMode('live')
                setView('draft')
              } else {
                setView(item.id)
              }
              // Switching tabs re-reads the disk state so a headless rebuild is
              // never displayed stale. All local calls; see refreshAllData.
              refreshAllData()
            }}
          >
            {item.label}
            {item.badge !== undefined && <span className="nav-badge">{item.badge}</span>}
          </button>
        ))}
      </nav>

      {!apiReady && (
        <section className="setup-strip" aria-live="polite">
          <strong>Local setup required</strong>
          <span>Add your Personal API key as <code>RIOT_API_KEY</code> in the root <code>.env.local</code>, then restart the dev server. Never use a <code>VITE_</code> key.</span>
        </section>
      )}

      {error && <div className="error-strip" role="alert">{error}</div>}

      {view === 'onetricks' && <LiveGameBar live={liveGame} />}

      <ViewErrorBoundary key={view} label={navItems.find((item) => item.id === view)?.label ?? String(view)}>
      {view === 'onetricks' && (
        <OnetricksView
          build={dockBuild}
          loading={dockBuildLoading}
          championId={39}
          championName="Irelia"
          lane={dockLane}
          setLane={setDockLane}
          opponent={dockOpponent}
          setOpponent={setDockOpponent}
          champions={champions}
          itemCatalog={itemCatalog}
          runeCatalog={runeCatalog}
          runeTreeNames={runeTreeNames}
          championNames={championNames}
          championFiles={championFiles}
          ddragonVersion={patch}
          banRate={meta?.banRate ?? null}
          games={meta?.games ?? []}
          gamesLoading={metaLoading}
          sinceHours={sinceHours}
          setSinceHours={setSinceHours}
          clientStatus={clientStatus}
        />
      )}

      {view === 'dock' && (
        <DockView
          champions={champions}
          championNames={championNames}
          itemCatalog={itemCatalog}
          runeCatalog={runeCatalog}
          runeNames={runeNames}
          patch={patch}
          lane={dockLane}
          setLane={setDockLane}
          opponent={dockOpponent}
          setOpponent={setDockOpponent}
          build={dockBuild}
          buildLoading={dockBuildLoading}
          buildBusy={busy === 'scan'}
          scan={scan}
          progress={scanProgress}
          onScan={scanKorea}
          onRefreshScan={refreshKorea}
          apiReady={apiReady}
          hasScan={Boolean(scan)}
        />
      )}

      {view === 'dashboard' && (
        <DashboardView
          status={apiStatus}
          refreshApiStatus={refreshApiStatus}
          champions={champions}
          playerReport={playerReport}
          onLoadPlayer={loadPlayer}
          gameName={gameName}
          setGameName={setGameName}
          tagLine={tagLine}
          setTagLine={setTagLine}
          busy={busy}
          apiReady={apiReady}
          allyComp={allyComp}
          enemyComp={enemyComp}
          updateComp={updateComp}
          laneOpponent={laneOpponent}
          setLaneOpponent={setLaneOpponent}
          patch={patch}
          scan={scan}
          championCount={champions.length}
        />
      )}

      {view === 'otps' && (
        <OnetrickGamesView
          games={meta?.games ?? []}
          gamesLoading={metaLoading}
          championNames={championNames}
          championFiles={championFiles}
          itemCatalog={itemCatalog}
          champions={champions}
          ddragonVersion={patch}
          onScanRoster={() => void runStreamedScan(true, true)}
          scanningRoster={busy === 'scan'}
        />
      )}

      {view === 'build' && (
        <RecommendedBuildView
          status={apiStatus}
          refreshApiStatus={refreshApiStatus}
          championNames={championNames}
          itemCatalog={itemCatalog}
          runeCatalog={runeCatalog}
          runeNames={runeNames}
          patch={patch}
          buildFocus={buildFocus}
          setBuildFocus={setBuildFocus}
          laneOpponent={laneOpponent}
          laneBuild={recommendedBuild && recommendedBuild.source === 'lane' ? recommendedBuild : null}
          compBuild={recommendedBuild && recommendedBuild.source === 'comp' ? recommendedBuild : null}
          loading={recommendedLoading}
        />
      )}

      {view === 'draft' && (
        <DraftView
          champions={champions}
          championNames={championNames}
          draftMode={draftMode}
          setDraftMode={setDraftMode}
          laneOpponent={laneOpponent}
          setLaneOpponent={setLaneOpponent}
          allyComp={allyComp}
          enemyComp={enemyComp}
          updateComp={updateComp}
          clearMock={clearMock}
          lobby={lobby}
          readLobby={readLobby}
          busy={busy}
          lobbyAllyIds={lobbyAllyIds}
          lobbyEnemyIds={lobbyEnemyIds}
          build={draftBuild}
          buildLoading={draftBuildLoading}
          itemCatalog={itemCatalog}
          runeCatalog={runeCatalog}
          runeNames={runeNames}
          patch={patch}
        />
      )}

      {view === 'datamanagement' && (
        <DataManagementView
          cacheStats={cacheStats}
          statsLoading={statsLoading}
          onRefreshStats={refreshAllData}
          refreshTick={dataVersion}
          scan={scan}
          progress={scanProgress}
          busy={busy}
          onScan={() => void runStreamedScan(false)}
          onStop={stopScan}
          onRefresh={() => void runStreamedScan(true)}
          apiReady={apiReady}
          clientStatus={clientStatus}
          championFiles={championFiles}
          patch={patch}
          onCacheCleared={handleCacheCleared}
          onDataChanged={() => void fetchDockBuild(dockLane, dockOpponent)}
        />
      )}
      </ViewErrorBoundary>

      <footer className="dashboard-footer">Personal tool · Riot Games is not affiliated with this app.</footer>
    </div>
  )
}

export default App
