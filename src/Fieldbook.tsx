import { useEffect, useMemo, useState } from 'react'
import './App.css'

type Routing = 'EUROPE' | 'ASIA' | 'KR' | 'EUN1'
type ApiUsage = {
  localBudget: { perSecond: number; perTwoMinutes: number }
  routes: Record<Routing, { lastSecond: number; lastTwoMinutes: number }>
  measuredAt: number
}
type ApiStatus = { configured: boolean; mode: string; usage: ApiUsage }
const emptyApiUsage: ApiUsage = {
  localBudget: { perSecond: 18, perTwoMinutes: 90 },
  routes: {
    EUROPE: { lastSecond: 0, lastTwoMinutes: 0 },
    ASIA: { lastSecond: 0, lastTwoMinutes: 0 },
    KR: { lastSecond: 0, lastTwoMinutes: 0 },
    EUN1: { lastSecond: 0, lastTwoMinutes: 0 },
  },
  measuredAt: 0,
}
type Champion = { id: number; name: string }
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
type ViewName = 'dock' | 'dashboard' | 'otps' | 'build' | 'draft' | 'widget'
type OtpLane = 'TOP' | 'MID'
type Tier = 'all' | 'challenger' | 'grandmaster' | 'master'
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
  tier: string
  leaguePoints: number
  ireliaMasteryPoints: number
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
  threshold: number
  candidatePoolSize: number
  masteryCandidates: number
  screenSize: number
  deepenedCandidates: number
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
  onProgress,
}: {
  tier: Tier
  lane: OtpLane | null
  onProgress: (progress: ScanProgress) => void
}): Promise<OtpScan> {
  const query = new URLSearchParams({
    tier,
    limit: tier === 'all' ? '9' : '8',
    sampleSize: '15',
    threshold: '0.7',
    ...(lane ? { lane } : {}),
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

function aggregateBuild(matches: MatchSample[], useLanePurchases: boolean): BuildEvidence {
  const itemCounts = new Map<number, { count: number; wins: number }>()
  const runeCounts = new Map<number, { count: number; wins: number }>()
  const primaryStyleCounts = new Map<number, number>()
  const secondaryStyleCounts = new Map<number, number>()
  const spellCounts = new Map<number, number>()
  const keystoneCounts = new Map<number, number>()
  const purchaseGroups = new Map<number, { matches: Set<string>; totalMinute: number }>()
  const itemMatches = useLanePurchases ? matches.filter((match) => match.laneItems.length) : matches
  let wins = 0

  matches.forEach((match) => {
    const earliestPurchase = new Map<number, number>()
    match.laneItems.forEach(({ id, minute }) => {
      const current = earliestPurchase.get(id)
      if (current === undefined || minute < current) earliestPurchase.set(id, minute)
    })
    earliestPurchase.forEach((minute, id) => {
      const group = purchaseGroups.get(id) ?? { matches: new Set<string>(), totalMinute: 0 }
      if (!group.matches.has(match.matchId)) {
        group.matches.add(match.matchId)
        group.totalMinute += minute
      }
      purchaseGroups.set(id, group)
    })
    new Set(match.runeIds).forEach((id) => {
      const current = runeCounts.get(id) ?? { count: 0, wins: 0 }
      current.count += 1
      if (match.win) current.wins += 1
      runeCounts.set(id, current)
    })
    if (match.primaryRuneStyle) {
      primaryStyleCounts.set(match.primaryRuneStyle, (primaryStyleCounts.get(match.primaryRuneStyle) ?? 0) + 1)
    }
    if (match.secondaryRuneStyle) {
      secondaryStyleCounts.set(match.secondaryRuneStyle, (secondaryStyleCounts.get(match.secondaryRuneStyle) ?? 0) + 1)
    }
    if (match.keystoneId) {
      keystoneCounts.set(match.keystoneId, (keystoneCounts.get(match.keystoneId) ?? 0) + 1)
    }
    ;(match.spellIds ?? []).forEach((id) => {
      spellCounts.set(id, (spellCounts.get(id) ?? 0) + 1)
    })
  })

  itemMatches.forEach((match) => {
    if (match.win) wins += 1
    const ids = useLanePurchases ? match.laneItems.map((item) => item.id) : match.items
    new Set(ids).forEach((id) => {
      const current = itemCounts.get(id) ?? { count: 0, wins: 0 }
      current.count += 1
      if (match.win) current.wins += 1
      itemCounts.set(id, current)
    })
  })

  return {
    sample: matches.length,
    itemSample: itemMatches.length,
    winRate: itemMatches.length ? wins / itemMatches.length : 0,
    items: [...itemCounts.entries()]
      .map(([id, value]) => ({ id, count: value.count, winRate: value.count ? value.wins / value.count : 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    runes: [...runeCounts.entries()]
      .map(([id, value]) => ({ id, count: value.count, winRate: value.wins / value.count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6),
    primaryStyles: [...primaryStyleCounts.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 2),
    secondaryStyles: [...secondaryStyleCounts.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 2),
    purchasePath: [...purchaseGroups.entries()]
      .map(([id, value]) => ({
        id,
        games: value.matches.size,
        averageMinute: value.matches.size ? value.totalMinute / value.matches.size : 0,
      }))
      .sort((a, b) => a.averageMinute - b.averageMinute || b.games - a.games),
    spells: [...spellCounts.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 4),
    keystones: [...keystoneCounts.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 4),
  }
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
type BuildResponse = {
  source: 'lane' | 'comp'
  lane: OtpLane
  patch: string
  patchExact: boolean
  games: number
  profile: BuildProfile
  reason: string
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

/* ======================= Professor-style build path ======================= */

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
      <img src={`https://ddragon.leagueoflegends.com/cdn/${patch}/img/item/${item.image}`} alt={item.name} title={item.name} width={size} height={size} loading="lazy" />
    ) : <span className="item-icon-placeholder" style={{ width: size, height: size }}>{id}</span>
  }

  return (
    <section className="panel build-path-card">
      <div className="section-heading">
        <div>
          <p className="eyebrow">KR Irelia OTPs only</p>
          <h2>{title}</h2>
          <p className="microcopy">{subtitle}</p>
        </div>
        <div className="build-path-meta">
          <strong>{profile.games}</strong>
          <span>games</span>
          {profile.games > 0 && <span className="build-path-wr">{percent(profile.winRate)} WR</span>}
        </div>
      </div>

      {!response || profile.games === 0 ? (
        <p className="empty-state">{response?.reason ?? 'Run a KR scan, then pick a matchup to see the build path.'}</p>
      ) : (
        <>
          {!exact && <p className="caveat">Showing the most recent patch with data (not the current patch). Sample sizes are shown per item.</p>}

          <div className="build-path-block">
            <h3 className="build-section-title">Start</h3>
            <div className="build-path-row">
              {profile.startingItems.length
                ? profile.startingItems.map((item) => (
                  <div className="build-path-step" key={item.id}>
                    {itemIcon(item.id, 44)}
                    <span>{itemCatalog.get(item.id)?.name ?? `Item ${item.id}`}</span>
                    <small>{item.games}×</small>
                  </div>
                ))
                : <span className="empty-state">No starting-item sample.</span>}
            </div>
          </div>

          <div className="build-path-block">
            <h3 className="build-section-title">Build order</h3>
            <div className="build-path-row core">
              {profile.purchasePath.length
                ? profile.purchasePath.slice(0, 6).map((item, index) => (
                  <div className="build-path-step" key={item.id}>
                    <span className="order-badge">{index + 1}</span>
                    {itemIcon(item.id, 52)}
                    <span>{itemCatalog.get(item.id)?.name ?? `Item ${item.id}`}</span>
                    <small>{percent(item.winRate)}{item.averageMinute !== null ? ` · ~${Math.round(item.averageMinute)}m` : ''}</small>
                  </div>
                ))
                : profile.coreItems.slice(0, 6).map((item, index) => (
                  <div className="build-path-step" key={item.id}>
                    <span className="order-badge">{index + 1}</span>
                    {itemIcon(item.id, 52)}
                    <span>{itemCatalog.get(item.id)?.name ?? `Item ${item.id}`}</span>
                    <small>{percent(item.winRate)} · {item.games}×</small>
                  </div>
                ))}
            </div>
          </div>

          {profile.skillOrder.length > 0 && (
            <div className="build-path-block">
              <h3 className="build-section-title">Skill order</h3>
              <div className="skill-order-row">
                {profile.skillOrder.slice(0, 4).map((entry) => (
                  <div className="skill-order-chip" key={entry.order}>
                    <span className="skill-order-letters">
                      {entry.order.split('').map((slot, index) => (
                        <b key={index} className={`skill-${slot}`}>{['', 'Q', 'W', 'E', 'R'][Number(slot)] ?? '?'}</b>
                      ))}
                    </span>
                    <small>{entry.games}×</small>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="build-path-block">
            <h3 className="build-section-title">Runes</h3>
            <div className="build-path-runes">
              <div className="build-rune-trees">
                {profile.primaryStyles.map((style) => (
                  <span className="rune-tree-chip" key={`p-${style.id}`}><strong>Primary</strong> {runeNames.get(style.id) ?? style.id} · {style.games}×</span>
                ))}
                {profile.secondaryStyles.map((style) => (
                  <span className="rune-tree-chip" key={`s-${style.id}`}><strong>Secondary</strong> {runeNames.get(style.id) ?? style.id} · {style.games}×</span>
                ))}
              </div>
              <div className="build-rune-keystones">
                {profile.keystones.slice(0, 3).map((keystone) => {
                  const rune = runeCatalog.get(keystone.id)
                  return (
                    <span className="rune-chip" key={keystone.id}>
                      {rune?.icon && <img src={`https://ddragon.leagueoflegends.com/cdn/img/${rune.icon}`} alt={rune.name} width="28" height="28" loading="lazy" />}
                      {rune?.name ?? `Rune ${keystone.id}`}
                      <small>{keystone.games}×</small>
                    </span>
                  )
                })}
              </div>
            </div>
          </div>

          <div className="build-path-block">
            <h3 className="build-section-title">Summoner spells</h3>
            <div className="build-path-spells">
              {profile.spells.slice(0, 3).map((spell) => (
                <span className="spell-chip" key={spell.ids.join('-')}>
                  {spell.ids.map((id) => (
                    <img
                      key={id}
                      src={`https://ddragon.leagueoflegends.com/cdn/${patch || '14.1.1'}/img/spell/${spellName(id)}.png`}
                      alt={summonerSpells[id] ?? `Spell ${id}`}
                      title={summonerSpells[id] ?? `Spell ${id}`}
                      width="40"
                      height="40"
                      loading="lazy"
                      onError={(event) => { (event.currentTarget as HTMLImageElement).style.opacity = '0.25' }}
                    />
                  ))}
                  <small>{percent(spell.winRate)} · {spell.games}×</small>
                </span>
              ))}
              {!profile.spells.length && <span className="empty-state">No spell sample.</span>}
            </div>
          </div>

          <div className="build-path-block">
            <h3 className="build-section-title">Boots</h3>
            <div className="build-path-row">
              {profile.boots.length
                ? profile.boots.map((item) => (
                  <div className="build-path-step" key={item.id}>
                    {itemIcon(item.id, 44)}
                    <span>{itemCatalog.get(item.id)?.name ?? `Item ${item.id}`}</span>
                    <small>{percent(item.winRate)} · {item.games}×</small>
                  </div>
                ))
                : <span className="empty-state">No boots sample.</span>}
            </div>
          </div>

          <p className="disclaimer">Observational KR OTP evidence. Sample sizes matter; small samples are directional only.</p>
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
  const routeNames: Routing[] = ['EUROPE', 'ASIA', 'KR', 'EUN1']
  const totalCalls = routeNames.reduce((total, route) => total + usage.routes[route].lastTwoMinutes, 0)

  return (
    <details className="api-usage-panel">
      <summary>
        <span>API usage</span>
        <span>{totalCalls} local calls / 2m</span>
      </summary>
      <div className="usage-content">
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

function MatchBuildDetail({
  match,
  itemCatalog,
  runeCatalog,
  patch,
}: {
  match: MatchSample
  itemCatalog: Map<number, ItemInfo>
  runeCatalog: Map<number, NamedId>
  patch: string
}) {
  return (
    <article className="match-build-card">
      <div className="match-build-heading">
        <div>
          <strong>{match.champion} · {match.position} vs {match.opponent ?? 'unknown lane'}</strong>
          <span>{match.patch} · {match.kills}/{match.deaths}/{match.assists} K/D/A</span>
        </div>
        <strong className={match.win ? 'win-text' : 'loss-text'}>{match.win ? 'WIN' : 'LOSS'}</strong>
      </div>
      <p className="match-detail-label">Completed inventory</p>
      <div className="match-icon-row">
        {match.items.map((id, index) => {
          const item = itemCatalog.get(id)
          return item && patch ? (
            <img
              key={`${id}-${index}`}
              className="match-item-icon"
              src={`https://ddragon.leagueoflegends.com/cdn/${patch}/img/item/${item.image}`}
              alt={item.name}
              title={item.name}
              width="38"
              height="38"
              loading="lazy"
            />
          ) : <span className="item-icon-placeholder" key={`${id}-${index}`}>{id}</span>
        })}
        {!match.items.length && <span>No completed items returned.</span>}
      </div>
      {match.laneItems.length > 0 && (
        <>
          <p className="match-detail-label">Purchases through 15 minutes</p>
          <div className="match-purchase-timeline">
            {[...match.laneItems].sort((a, b) => a.minute - b.minute).map((purchase, index) => {
              const item = itemCatalog.get(purchase.id)
              return (
                <div className="timeline-purchase" key={`${purchase.id}-${index}`}>
                  {item && patch ? (
                    <img src={`https://ddragon.leagueoflegends.com/cdn/${patch}/img/item/${item.image}`} alt="" width="26" height="26" loading="lazy" />
                  ) : <span className="item-icon-placeholder">{purchase.id}</span>}
                  <span>{purchase.minute}m</span>
                </div>
              )
            })}
          </div>
        </>
      )}
      <p className="match-detail-label">Rune page</p>
      <div className="match-rune-row">
        {match.runeIds.map((id) => {
          const rune = runeCatalog.get(id)
          return rune?.icon ? (
            <img
              key={id}
              src={`https://ddragon.leagueoflegends.com/cdn/img/${rune.icon}`}
              alt={rune.name}
              title={rune.name}
              width="28"
              height="28"
              loading="lazy"
            />
          ) : <span key={id} title={rune?.name ?? `Rune ${id}`}>{rune?.name ?? id}</span>
        })}
        {!match.runeIds.length && <span>Rune data unavailable.</span>}
      </div>
    </article>
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
  laneBuild,
  compBuild,
  activeOpponent,
  laneSampleCount,
  compSampleCount,
  verifiedCount,
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
  laneBuild: BuildEvidence
  compBuild: BuildEvidence
  activeOpponent: number
  laneSampleCount: number
  compSampleCount: number
  verifiedCount: number
}) {
  const active = buildFocus === 'lane' ? laneBuild : compBuild
  const focusedLabel = buildFocus === 'lane'
    ? (activeOpponent ? `vs ${championNames.get(activeOpponent) ?? 'selected opponent'}` : 'laning route')
    : 'composition alternative'

  if (!verifiedCount) {
    return (
      <div className="view-grid">
        <section className="panel span-full">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Verified KR OTP games only</p>
              <h2>Recommended build</h2>
            </div>
            <ApiUsagePanel status={status} onRefresh={refreshApiStatus} />
          </div>
          <p className="empty-state">No verified OTP games match the current patch in this sample yet. Run a fresh KR scan from the OTP Scouting view while online; older-patch data is never presented as current.</p>
        </section>
      </div>
    )
  }

  const spellPairs = active.spells.length
    ? [active.spells.map((entry) => entry.id), ...(
      active.spells.filter((entry) => !active.spells.slice(0, 2).some((first) => first.id === entry.id)).slice(0, 1).map((entry) => [entry.id])
    )].slice(0, 1)
    : []
  const primaryRunes = active.runes.slice(0, 4)
  const coreItems = active.purchasePath.length
    ? active.purchasePath.slice(0, 6).map((entry) => ({
      id: entry.id,
      minute: Math.round(entry.averageMinute),
      winRate: active.items.find((item) => item.id === entry.id)?.winRate ?? active.winRate,
    }))
    : active.items.slice(0, 6).map((item) => ({ id: item.id, minute: null as number | null, winRate: item.winRate }))

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
          <p>{focusedLabel} · {active.sample} matching verified games · {percent(active.winRate)} observed win rate</p>
        </div>
        <div className="build-hero-score">
          <strong>{active.sample ? percent(active.winRate) : '—'}</strong>
          <span>item-sample win rate</span>
        </div>
      </section>

      <div className="role-segment" role="tablist" aria-label="Build focus">
        <button type="button" role="tab" aria-selected={buildFocus === 'lane'} className={buildFocus === 'lane' ? 'selected' : ''} onClick={() => setBuildFocus('lane')}>Laning route</button>
        <button type="button" role="tab" aria-selected={buildFocus === 'comp'} className={buildFocus === 'comp' ? 'selected' : ''} onClick={() => setBuildFocus('comp')}>Composition</button>
      </div>

      {!active.sample && (
        <section className="panel">
          <p className="empty-state">
            {buildFocus === 'lane'
              ? 'No verified games face your selected lane opponent yet. Try another opponent or the composition view.'
              : 'No verified games overlap your selected composition yet. Add more picks or switch to the laning view.'}
          </p>
        </section>
      )}

      {active.sample > 0 && (
        <div className="view-grid">
          <section className="panel span-full">
            <h3 className="build-section-title">Core build order <span className="count">{active.itemSample} games with purchases</span></h3>
            <div className="core-build">
              {coreItems.map((entry, index) => {
                const item = itemCatalog.get(entry.id)
                return (
                  <div className="core-item" key={entry.id}>
                    <span className="order-badge">{index + 1}</span>
                    {item && patch ? (
                      <img src={`https://ddragon.leagueoflegends.com/cdn/${patch}/img/item/${item.image}`} alt={item.name} width="58" height="58" loading="lazy" />
                    ) : <span className="item-icon-placeholder">{entry.id}</span>}
                    <strong>{item?.name ?? `Item ${entry.id}`}</strong>
                    <small>{percent(entry.winRate)}{entry.minute !== null ? ` · ~${entry.minute}m` : ''}</small>
                  </div>
                )
              })}
            </div>
          </section>

          <section className="panel">
            <h3 className="build-section-title">Summoner spells</h3>
            {spellPairs.length ? (
              <div className="spell-row">
                {active.spells.slice(0, 4).map((spell) => (
                  <div className="spell-chip" key={spell.id}>
                    <img
                      src={`https://ddragon.leagueoflegends.com/cdn/${patch || '14.1.1'}/img/spell/${spellName(spell.id)}.png`}
                      alt={summonerSpells[spell.id] ?? `Spell ${spell.id}`}
                      title={summonerSpells[spell.id] ?? `Spell ${spell.id}`}
                      width="52"
                      height="52"
                      loading="lazy"
                      onError={(event) => { (event.currentTarget as HTMLImageElement).style.opacity = '0.25' }}
                    />
                    <span>{summonerSpells[spell.id] ?? `Spell ${spell.id}`}</span>
                    <span>{spell.count}×</span>
                  </div>
                ))}
              </div>
            ) : <p className="empty-state">No summoner-spell sample captured yet.</p>}
          </section>

          <section className="panel">
            <h3 className="build-section-title">Keystones</h3>
            {active.keystones.length ? (
              <div className="rune-row">
                {active.keystones.map((keystone) => {
                  const rune = runeCatalog.get(keystone.id)
                  return (
                    <div className="rune-chip" key={keystone.id}>
                      {rune?.icon && <img src={`https://ddragon.leagueoflegends.com/cdn/img/${rune.icon}`} alt={rune.name} width="30" height="30" loading="lazy" />}
                      <span>{rune?.name ?? `Rune ${keystone.id}`}</span>
                      <small>{keystone.count}×</small>
                    </div>
                  )
                })}
              </div>
            ) : <p className="empty-state">No keystone sample captured yet.</p>}
          </section>

          <section className="panel">
            <h3 className="build-section-title">Rune trees</h3>
            <div className="rune-trees">
              {active.primaryStyles.map((style) => (
                <div className="rune-tree-chip" key={`p-${style.id}`}>
                  <strong>Primary</strong>
                  <span>{runeNames.get(style.id) ?? `Tree ${style.id}`} · {style.count}×</span>
                </div>
              ))}
              {active.secondaryStyles.map((style) => (
                <div className="rune-tree-chip" key={`s-${style.id}`}>
                  <strong>Secondary</strong>
                  <span>{runeNames.get(style.id) ?? `Tree ${style.id}`} · {style.count}×</span>
                </div>
              ))}
            </div>
            <div className="rune-row" style={{ marginTop: 12 }}>
              {primaryRunes.map((rune) => {
                const detail = runeCatalog.get(rune.id)
                return detail?.icon ? (
                  <img
                    key={rune.id}
                    src={`https://ddragon.leagueoflegends.com/cdn/img/${detail.icon}`}
                    alt={detail.name}
                    title={`${detail.name} · ${rune.count} games`}
                    width="30"
                    height="30"
                    loading="lazy"
                  />
                ) : <span key={rune.id}>{detail?.name ?? `Rune ${rune.id}`}</span>
              })}
            </div>
          </section>

          <section className="panel span-full">
            <h3 className="build-section-title">Item options <span className="count">{active.itemSample} games</span></h3>
            <div className="item-option-list">
              {active.items.map((item) => (
                <ItemOption key={item.id} id={item.id} count={item.count} winRate={item.winRate} item={itemCatalog.get(item.id)} patch={patch} />
              ))}
              {!active.items.length && <p className="empty-state">No item sample available.</p>}
            </div>
          </section>

          {buildFocus === 'lane' && laneSampleCount < 5 && (
            <section className="panel span-full">
              <p className="caveat">Matchup-specific sample is under 5 games. Treat this as directional evidence, not a fixed build.</p>
            </section>
          )}
          {buildFocus === 'comp' && compSampleCount < 5 && (
            <section className="panel span-full">
              <p className="caveat">Few similar compositions found. This is descriptive match data, not a guaranteed win-rate improvement.</p>
            </section>
          )}
        </div>
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

/* ============================ OTP scouting ============================ */

function OtpScanView({
  status,
  refreshApiStatus,
  itemCatalog,
  runeCatalog,
  patch,
  scan,
  busy,
  apiReady,
  onScan,
  tier,
  setTier,
  lane,
  setLane,
  scanSort,
  setScanSort,
  activeOtpCandidates,
}: {
  status: ApiStatus | null
  refreshApiStatus: () => void
  itemCatalog: Map<number, ItemInfo>
  runeCatalog: Map<number, NamedId>
  patch: string
  scan: OtpScan | null
  busy: string | null
  apiReady: boolean
  onScan: () => void
  tier: Tier
  setTier: (value: Tier) => void
  lane: OtpLane | null
  setLane: (value: OtpLane | null) => void
  scanSort: OtpSortMode
  setScanSort: (value: OtpSortMode) => void
  activeOtpCandidates: OtpCandidate[]
}) {
  return (
    <div className="view-grid">
      <section className="panel span-full">
        <div className="section-heading">
          <div>
            <p className="eyebrow">KR · bounded ladder sample</p>
            <h2>Find Irelia one-tricks</h2>
          </div>
          <ApiUsagePanel status={status} onRefresh={refreshApiStatus} />
        </div>
        <div className="scan-controls">
          <label>
            <span>KR rank pool</span>
            <select value={tier} onChange={(event) => setTier(event.target.value as Tier)}>
              <option value="all">All high tiers</option>
              <option value="challenger">Challenger</option>
              <option value="grandmaster">Grandmaster</option>
              <option value="master">Master</option>
            </select>
          </label>
          <div className="role-segment" role="group" aria-label="Lane filter">
            <button type="button" className={`role-top ${lane === 'TOP' ? 'selected' : ''}`} onClick={() => setLane(lane === 'TOP' ? null : 'TOP')}>TOP</button>
            <button type="button" className={`role-mid ${lane === 'MID' ? 'selected' : ''}`} onClick={() => setLane(lane === 'MID' ? null : 'MID')}>MID</button>
          </div>
          <label>
            <span>Sort by</span>
            <select value={scanSort} onChange={(event) => setScanSort(event.target.value as OtpSortMode)}>
              <option value="active">Active OTP</option>
              <option value="winrate">Highest win rate</option>
              <option value="mastery">Mastery</option>
              <option value="sample">Most recent games</option>
            </select>
          </label>
          <button type="button" className="action-button" onClick={onScan} disabled={busy !== null || !apiReady}>
            {busy === 'scan' ? 'Scanning…' : 'Scan KR candidates'}
          </button>
        </div>
        <p className="microcopy">
          Searches a broader sample of high-LP players. Toggle TOP or MID to focus the scan on one lane. Recent lane-specific Irelia activity earns deeper OTP checks.
        </p>
        {!apiReady && <p className="caveat">Riot API key not configured. Add RIOT_API_KEY to .env.local and restart to scan.</p>}
        {scan && (
          <>
            <div className="stat-row">
              <div className="stat-cell"><span>{lane ? `${lane} OTPs` : 'Active OTPs'}</span><strong>{activeOtpCandidates.length}</strong></div>
              <div className="stat-cell"><span>Ladder accounts</span><strong>{scan.candidatePoolSize}</strong></div>
              <div className="stat-cell"><span>With Irelia mastery</span><strong>{scan.masteryCandidates}</strong></div>
            </div>
            <p className="scan-summary">{scan.note}</p>
            {scan.lane && (
              <div className="live-action-row">
                <span className={`role-tag ${scan.lane === 'TOP' ? 'top' : 'mid'}`}>{scan.lane} filter active</span>
                <button type="button" className="text-button" onClick={() => setLane(null)}>Clear lane filter</button>
              </div>
            )}
            <div className="candidate-list">
              {activeOtpCandidates.map((candidate) => {
                const roleLabel = lane ? candidate.roles.find((role) => role.role === lane) : null
                const otpLabel = candidate.otpRoles.length
                  ? `${candidate.otpRoles.join(' + ')} OTP`
                  : candidate.ireliaGames ? 'Active · scouting' : 'No recent lane Irelia'
                return (
                  <article className="candidate-entry" key={candidate.name}>
                    <details>
                      <summary className="candidate-row">
                        <span className="candidate-name">
                          <strong>{candidate.name}</strong>
                          <span>{candidate.tier} · {candidate.leaguePoints.toLocaleString()} LP · {candidate.ireliaMasteryPoints.toLocaleString()} mastery</span>
                        </span>
                        <span className="candidate-metrics">
                          <span className={candidate.isOtp ? 'otp-badge' : 'not-otp-badge'}>{otpLabel}</span>
                          {roleLabel ? (
                            <span className="metric-chip">
                              <span>{roleLabel.role} lane</span>
                              <strong>{roleLabel.ireliaGames}/{roleLabel.rankedGames} · {percent(roleLabel.ireliaShare)} · {roleLabel.ireliaGames ? `${percent(roleLabel.winRate)} WR` : 'no Irelia'}</strong>
                            </span>
                          ) : candidate.roles.map((role) => (
                            <span className="metric-chip" key={role.role}>
                              <span>{role.role}</span>
                              <strong>{role.ireliaGames}/{role.rankedGames} · {percent(role.ireliaShare)}</strong>
                            </span>
                          ))}
                          <span className="otp-badge">Expand ▾</span>
                        </span>
                      </summary>
                      <div className="candidate-history-heading">
                        <strong>Recent ranked match history</strong>
                        <span>{candidate.rankedSample} ranked games · TOP {percent(candidate.roles[0]?.ireliaShare ?? 0)} · MID {percent(candidate.roles[1]?.ireliaShare ?? 0)}</span>
                      </div>
                      <div className="candidate-match-list">
                        {candidate.matches.map((match) => (
                          <MatchBuildDetail
                            key={match.matchId}
                            match={match}
                            itemCatalog={itemCatalog}
                            runeCatalog={runeCatalog}
                            patch={patch}
                          />
                        ))}
                        {!candidate.matches.length && <p className="empty-state">No recent ranked solo games were returned for this player.</p>}
                      </div>
                    </details>
                  </article>
                )
              })}
              {!activeOtpCandidates.length && <p className="empty-state">No active Korean OTPs passed the recent Irelia filters for this tier and lane. Try a lower tier, clear the lane filter, or widen the search window.</p>}
            </div>
          </>
        )}
        {!scan && <p className="empty-state">Run a KR scan while online to populate the OTP list. Results are saved in this browser for offline mock drafts.</p>}
      </section>
    </div>
  )
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
  readLobby: () => void
  busy: string | null
  lobbyAllyIds: number[]
  lobbyEnemyIds: number[]
}) {
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
              <button type="button" className="action-button secondary-action" onClick={readLobby} disabled={busy !== null}>
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
  const savedAt = scan ? new Date((scan as unknown as { scannedAt?: number }).scannedAt ?? Date.now()).toLocaleString() : null
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
              ? 'Runes, skill order, item path, spells and boots aggregated from KR Irelia OTP games against this matchup.'
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
  allies,
  enemies,
  sample,
  itemCatalog,
  runeCatalog,
  patch,
}: {
  status: ApiStatus | null
  onRefresh: () => void
  onExpand: () => void
  allies: string[]
  enemies: string[]
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

  return (
    <div className="widget-shell">
      <div className="widget-card">
        <header className="widget-header">
          <div>
            <p className="eyebrow">Patch {patch || 'unknown'}</p>
            <h1>Irelia build widget</h1>
          </div>
          <button type="button" className="action-button secondary-action" onClick={onExpand}>Full dashboard</button>
        </header>
        <section className="widget-composition">
          <div><span>My team</span><strong>{allies.length ? allies.join(' · ') : 'Irelia · composition not set'}</strong></div>
          <div><span>Enemy team</span><strong>{enemies.length ? enemies.join(' · ') : 'Composition not set'}</strong></div>
        </section>
        <main className="widget-build">
          <div className="widget-build-heading">
            <div>
              <p className="eyebrow">Observed KR OTP games</p>
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

/* ============================ App ============================ */

function App() {
  const [apiStatus, setApiStatus] = useState<ApiStatus | null>(null)
  const [catalog, setCatalog] = useState<StaticCatalog | null>(() => readLocal('irelia-fieldbook-catalog', null))
  const [gameName, setGameName] = useState('Dobrezaur')
  const [tagLine, setTagLine] = useState('1733')
  const [playerReport, setPlayerReport] = useState<PlayerReport | null>(null)
  const [scan, setScan] = useState<OtpScan | null>(() => readLocal('irelia-fieldbook-scan-v3', null))
  const [lobby, setLobby] = useState<Lobby | null>(null)
  const [draftMode, setDraftMode] = useState<DraftMode>('mock')
  const [view, setView] = useState<ViewName>(() => readLocal('irelia-fieldbook-view-v3', 'dock'))
  const [tier, setTier] = useState<Tier>('all')
  const [otpLane, setOtpLane] = useState<OtpLane | null>(() => readLocal('irelia-fieldbook-otplane', null))
  const [buildFocus, setBuildFocus] = useState<BuildFocus>(() => readLocal('irelia-fieldbook-buildfocus', 'lane'))
  const [laneOpponent, setLaneOpponent] = useState(() => readLocal('irelia-fieldbook-lane', 0))
  const [allyComp, setAllyComp] = useState<number[]>(() => readLocal('irelia-fieldbook-allies', [0, 0, 0, 0]))
  const [enemyComp, setEnemyComp] = useState<number[]>(() => readLocal('irelia-fieldbook-enemies', [0, 0, 0, 0]))
  const [scanSort, setScanSort] = useState<OtpSortMode>('active')
  const [busy, setBusy] = useState<'player' | 'scan' | 'lobby' | null>(null)
  const [error, setError] = useState('')
  const [dockLane, setDockLane] = useState<OtpLane>(() => readLocal('irelia-fieldbook-docklane', 'TOP'))
  const [dockOpponent, setDockOpponent] = useState(() => readLocal('irelia-fieldbook-dockopp', 0))
  const [dockBuild, setDockBuild] = useState<BuildResponse | null>(null)
  const [dockBuildLoading, setDockBuildLoading] = useState(false)
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null)

  useEffect(() => {
    void apiGet<ApiStatus>('/api/status').then(setApiStatus).catch(() => setApiStatus({ configured: false, mode: 'local', usage: emptyApiUsage }))
    void apiGet<StaticCatalog>('/api/champions')
      .then((data) => {
        setCatalog(data)
        writeLocal('irelia-fieldbook-catalog', data)
      })
      .catch((reason: unknown) => {
        if (!readLocal<StaticCatalog | null>('irelia-fieldbook-catalog', null)) {
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

  useEffect(() => { writeLocal('irelia-fieldbook-view-v2', view) }, [view])
  useEffect(() => { writeLocal('irelia-fieldbook-otplane', otpLane) }, [otpLane])
  useEffect(() => { writeLocal('irelia-fieldbook-buildfocus', buildFocus) }, [buildFocus])

  const champions = catalog?.champions ?? emptyChampions
  const items = catalog?.items ?? emptyItems
  const runes = catalog?.runes ?? emptyRunes
  const patch = catalog?.version ?? ''
  const championNames = useMemo(() => new Map(champions.map((champion) => [champion.id, champion.name])), [champions])
  const itemCatalog = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const runeNames = useMemo(() => new Map(runes.map((rune) => [rune.id, rune.name])), [runes])
  const runeCatalog = useMemo(() => new Map(runes.map((rune) => [rune.id, rune])), [runes])
  const activePatch = patch.split('.').slice(0, 2).join('.')
  const verifiedMatches = useMemo(
    () => (scan?.analyzed.filter((candidate) => candidate.isOtp)
      .flatMap((candidate) => candidate.matches.filter((match) =>
        match.championId === 39 && (!candidate.otpRole || match.position === candidate.otpRole),
      )) ?? [])
      .filter((match) => !activePatch || match.patch === activePatch),
    [activePatch, scan],
  )

  const lobbyAllyIds = lobby?.myTeam.map((pick) => pick.championId).filter((id) => id > 0 && id !== 39) ?? []
  const lobbyEnemyIds = lobby?.theirTeam.map((pick) => pick.championId).filter((id) => id > 0) ?? []
  const selectedAllies = draftMode === 'live' ? lobbyAllyIds : allyComp.filter((id) => id > 0)
  const selectedEnemies = draftMode === 'live'
    ? lobbyEnemyIds
    : [laneOpponent, ...enemyComp].filter((id) => id > 0)
  const lanePick = lobby?.theirTeam.find((pick) => {
    const position = pick.assignedPosition?.toLowerCase()
    return position === 'top' || position === 'middle' || position === 'mid'
  })?.championId
  const activeOpponent = draftMode === 'live' ? lanePick || lobbyEnemyIds[0] || 0 : laneOpponent

  const laningSamples = useMemo(
    () => activeOpponent
      ? verifiedMatches.filter((match) => match.opponentChampionId === activeOpponent)
      : [],
    [activeOpponent, verifiedMatches],
  )
  const compSamples = useMemo(() => {
    if (!selectedAllies.length && !selectedEnemies.length) return []
    return verifiedMatches
      .map((match) => {
        const allyIds = match.allies.map((champion) => champion.id)
        const enemyIds = match.enemies.map((champion) => champion.id)
        const overlap = selectedEnemies.filter((id) => enemyIds.includes(id)).length * 2
          + selectedAllies.filter((id) => allyIds.includes(id)).length
        return { match, overlap }
      })
      .filter(({ overlap }) => overlap > 0)
      .sort((a, b) => b.overlap - a.overlap)
      .slice(0, 20)
      .map(({ match }) => match)
  }, [selectedAllies, selectedEnemies, verifiedMatches])

  const laneBuild = useMemo(() => aggregateBuild(laningSamples, true), [laningSamples])
  const compBuild = useMemo(() => aggregateBuild(compSamples, false), [compSamples])
  const activeOtpCandidates = useMemo(() => {
    if (!scan) return []
    const filtered = scan.analyzed.filter((candidate) => {
      const hasLaneEvidence = candidate.roles.some((role) => role.ireliaGames >= 4 && role.ireliaShare >= 0.15)
      const hasRecentSample = candidate.ireliaGames >= 5
      const hasActivePattern = candidate.isOtp || candidate.ireliaGames >= 7
      return hasActivePattern && (hasLaneEvidence || hasRecentSample)
    })
    return sortOtpCandidates(filtered, scanSort)
  }, [scan, scanSort])

  const widgetAllies = ['Irelia', ...selectedAllies.map((id) => championNames.get(id) ?? `#${id}`)]
  const widgetEnemies = [...new Set(selectedEnemies)].map((id) => championNames.get(id) ?? `#${id}`)

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
      setDockBuild(await apiGet<BuildResponse>(`/api/riot/build?${query}`))
    } catch {
      setDockBuild(null)
    } finally {
      setDockBuildLoading(false)
    }
  }

  useEffect(() => {
    void fetchDockBuild(dockLane, dockOpponent)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dockLane, dockOpponent, activePatch, scan])

  /**
   * Streams the KR scan via SSE so the UI shows live progress. Falls back to
   * the single-shot endpoint if streaming is unavailable.
   */
  async function runStreamedScan(refresh: boolean) {
    setBusy('scan')
    setError('')
    setScanProgress({ phase: 'starting', message: refresh ? 'Refreshing latest games…' : 'Starting KR scan…', done: 0, total: 0 })
    try {
      const result = await streamKoreanScan({ tier, lane: otpLane, onProgress: setScanProgress })
      setScan(result)
      // After a fresh scan, recompute the Dock build against the new data.
      void fetchDockBuild(dockLane, dockOpponent)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not scan KR ranked candidates.')
    } finally {
      setBusy(null)
      refreshApiStatus()
    }
  }

  async function loadPlayer() {
    setBusy('player')
    setError('')
    try {
      const query = new URLSearchParams({ gameName, tagLine, region: 'EUROPE', count: '20' })
      setPlayerReport(await apiGet<PlayerReport>(`/api/riot/player?${query}`))
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

  async function readLobby() {
    setBusy('lobby')
    setError('')
    try {
      setLobby(await apiGet<Lobby>('/api/client/champ-select'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not read champion select.')
    } finally {
      setBusy(null)
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
    { id: 'dock', label: 'Dock' },
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'otps', label: 'OTP scouting', badge: scan ? activeOtpCandidates.length : undefined },
    { id: 'build', label: 'Recommended build' },
    { id: 'draft', label: 'Draft' },
    { id: 'widget', label: 'Widget' },
  ]

  if (view === 'widget') {
    return (
      <WidgetView
        status={apiStatus}
        onRefresh={refreshApiStatus}
        onExpand={() => setView('dashboard')}
        allies={widgetAllies}
        enemies={widgetEnemies}
        sample={compBuild}
        itemCatalog={itemCatalog}
        runeCatalog={runeCatalog}
        patch={patch}
      />
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
            <strong>Irelia Fieldbook</strong>
            <span>Personal KR Irelia research · EUNE player</span>
          </span>
        </div>
        <div className="header-tools">
          <div className={`connection-state ${apiReady ? 'is-ready' : 'is-missing'}`}>
            <span className="status-dot" />
            {apiReady ? 'Riot API key loaded' : 'Riot API key missing'}
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
            onClick={() => setView(item.id)}
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
        <OtpScanView
          status={apiStatus}
          refreshApiStatus={refreshApiStatus}
          itemCatalog={itemCatalog}
          runeCatalog={runeCatalog}
          patch={patch}
          scan={scan}
          busy={busy}
          apiReady={apiReady}
          onScan={scanKorea}
          tier={tier}
          setTier={setTier}
          lane={otpLane}
          setLane={setOtpLane}
          scanSort={scanSort}
          setScanSort={setScanSort}
          activeOtpCandidates={activeOtpCandidates}
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
          laneBuild={laneBuild}
          compBuild={compBuild}
          activeOpponent={activeOpponent}
          laneSampleCount={laningSamples.length}
          compSampleCount={compSamples.length}
          verifiedCount={verifiedMatches.length}
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
        />
      )}

      <footer className="dashboard-footer">Personal tool · Riot Games is not affiliated with this app.</footer>
    </div>
  )
}

export default App
