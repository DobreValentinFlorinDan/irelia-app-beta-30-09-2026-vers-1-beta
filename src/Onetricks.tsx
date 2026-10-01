import { useEffect, useState } from 'react'
import './styles/onetricks.css'

/* ------------------------------------------------------------------ *
 * Types (mirror server/riotApi.ts + analytics.ts)
 * ------------------------------------------------------------------ */

export type ConfidenceInterval = {
  estimate: number
  low: number
  high: number
  sampleSize: number
  effectiveSampleSize: number
  confidence: number
}

export type ServerItemShare = { id: number; games: number; winRate: number; averageMinute: number | null }
export type ServerBuildSlotOption = { id: number; games: number; share: number; wins: number; winRate: number }
/** One position in the build order, with the items players finish there. */
export type ServerBuildSlot = {
  slot: number
  options: ServerBuildSlotOption[]
  /** Statistically strongest item for this position, or null when too thin. */
  bestId: number | null
  bestWinRate: number | null
}
export type ServerRuneShare = { id: number; games: number }
export type ServerSpellShare = { ids: number[]; games: number; winRate: number }
export type ServerSkillOrder = { order: string; games: number }

export type BuildProfile = {
  source: 'lane' | 'comp'
  games: number
  wins: number
  winRate: number
  startingItems: ServerItemShare[]
  boots: ServerItemShare[]
  coreItems: ServerItemShare[]
  fullItems: ServerItemShare[]
  purchasePath: ServerItemShare[]
  /** Complete "Starting Items -> finished build" sequence, always populated. */
  fullBuild?: ServerItemShare[]
  /** Slot-by-slot build order with per-slot option shares. */
  slots?: ServerBuildSlot[]
  skillOrder: ServerSkillOrder[]
  spells: ServerSpellShare[]
  primaryStyles: ServerRuneShare[]
  secondaryStyles: ServerRuneShare[]
  keystones: ServerRuneShare[]
  runeShards: ServerRuneShare[]
}

export type ItemSetEntry = {
  items: number[]
  games: number
  wins: number
  winRate: ConfidenceInterval
  averageDuration: number | null
}

export type SkillLevelRow = {
  level: number
  slot: number
  share: ConfidenceInterval
  counts: Record<number, number>
}

export type SkillOrderAnalysis = {
  rows: SkillLevelRow[]
  orders: Array<{ order: string; games: number }>
  priority: number[]
  earlyOrder: string
  maxLevel: number
  sampleSize: number
  confidence: number
}

export type BuildResponse = {
  source: 'lane' | 'comp'
  lane: 'TOP' | 'MID'
  patch: string
  patchExact: boolean
  games: number
  profile: BuildProfile
  reason: string
  itemSets?: ItemSetEntry[]
  skills?: SkillOrderAnalysis
  weighted?: ConfidenceInterval
  weighting?: { totalWeight: number; effectiveSampleSize: number; topMatchId: string | null }
}

export type NamedId = { id: number; name: string; icon?: string; tree?: string; isTree?: boolean }
export type ItemInfo = { id: number; name: string; plaintext: string; image: string; stats: Record<string, number>; gold: number }
export type Champion = { id: number; name: string; ddragonId?: string }

export type GameRow = {
  matchId: string
  win: boolean
  championId: number
  position: string
  patch: string
  /** Unix epoch ms when the game started, for "8 hours ago" labels. */
  gameCreation: number
  duration: number
  summonerName: string | null
  opponentChampionId: number | null
  opponentName: string | null
  finalItems: number[]
  allyChampionIds: number[]
  enemyChampionIds: number[]
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

export type ClientStatus = { connected: boolean; inChampSelect: boolean }

/** A curated priority one-trick that the scan resolves and deepens first. */
export type RosterEntry = {
  rank: number
  tier: string
  region: string
  gameName: string
  tagLine: string
  leaguePoints: number
  playRate: number
  games: number
  winRate: number
  kda: number
}

export type OnetricksProps = {
  build: BuildResponse | null
  loading: boolean
  championId: number
  championName: string
  lane: 'TOP' | 'MID'
  setLane: (lane: 'TOP' | 'MID') => void
  /** Enemy laner; the single most important input to the recommendation. */
  opponent: number
  setOpponent: (id: number) => void
  champions: Champion[]
  itemCatalog: Map<number, ItemInfo>
  runeCatalog: Map<number, NamedId>
  /** Rune id -> owning tree name, e.g. 8005 -> "Precision". */
  runeTreeNames: Map<number, string>
  championNames: Map<number, string>
  /** Champion id -> Data Dragon image key (not always the display name). */
  championFiles: Map<number, string>
  ddragonVersion: string
  /** Sampled ban rate for the champion, from captured matches only. */
  banRate: ConfidenceInterval | null
  games: GameRow[]
  gamesLoading: boolean
  /** Recency window in hours (0 = all time). Refetches, not cosmetic. */
  sinceHours: number
  setSinceHours: (hours: number) => void
  clientStatus: ClientStatus | null
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const SKILL_LETTERS: Record<number, string> = { 1: 'Q', 2: 'W', 3: 'E', 4: 'R' }

/** Data Dragon spells are indexed by name, not id, so map the ids we use. */
const SUMMONER_SPELL_NAMES: Record<number, string> = {
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

function pct(value: number) {
  return `${(value * 100).toFixed(1)}%`
}

function pct0(value: number) {
  return `${Math.round(value * 100)}%`
}

/** 1 -> "1st", 2 -> "2nd", 11 -> "11th". */
function ordinal(n: number) {
  const tens = n % 100
  const suffix = tens >= 11 && tens <= 13
    ? 'th'
    : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'
  return `${n}${suffix}`
}

function duration(seconds: number) {
  if (!seconds) return '—'
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
}

function signed(value: number | null) {
  if (value === null) return '—'
  return value > 0 ? `+${value}` : String(value)
}

/** Relative "how long ago" for a game start timestamp. */
function timeAgo(epochMs: number) {
  if (!epochMs) return '—'
  const seconds = Math.max(0, Math.floor((Date.now() - epochMs) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

/** Compact confidence display, e.g. "95% CI 33–63%". */
function Ci({ interval, label = 'CI' }: { interval?: ConfidenceInterval | null; label?: string }) {
  if (!interval || interval.sampleSize === 0) return null
  return (
    <span className="ot-ci" title={`${Math.round(interval.confidence * 100)}% Wilson score interval · n=${interval.sampleSize}${interval.effectiveSampleSize < interval.sampleSize ? `, effective n=${interval.effectiveSampleSize.toFixed(1)}` : ''}`}>
      {label} {pct0(interval.low)}–{pct0(interval.high)}
    </span>
  )
}

/**
 * Anchors a sample size to how much it can honestly support.
 *
 * Thresholds are the Wilson-interval half-widths at the worst case p=0.5, 95%:
 *   n=96 → ±10%, n=167 → ±7.5%, n=385 → ±5%. A stable build recommendation
 *   should not be claimed below "Solid"; the UI shows the tier instead.
 */
function confidenceTier(n: number): { label: string; hint: string; cls: string } {
  if (n < MATCHUP_TARGET) return { label: 'Anecdotal', hint: `<${MATCHUP_TARGET} games: not enough to rank builds. Treat as anecdotal.`, cls: 'is-anecdotal' }
  if (n < MATCHUP_SOLID) return { label: 'Directional', hint: `${MATCHUP_TARGET}–${MATCHUP_SOLID - 1} games: direction only, ±10–18%.`, cls: 'is-directional' }
  if (n < POOL_TARGET) return { label: 'Moderate', hint: `${MATCHUP_SOLID}–${POOL_TARGET - 1} games: ±5–10%.`, cls: 'is-moderate' }
  return { label: 'Solid', hint: `≥${POOL_TARGET} games: ±5% or better at 95% confidence.`, cls: 'is-solid' }
}

/**
 * Sample-size targets.
 *
 * A 95% Wilson interval at the worst case p=0.5 has half-width
 * 1.96·√(0.25/n), so ±5% needs n≈385 and ±10% needs n≈96.
 *
 * POOL_TARGET is the whole-pool goal — the point where Irelia's overall win
 * rate is pinned to ±5%. Per-matchup reads need their own sample, and no single
 * matchup will ever reach the pool total, so matchup coverage is tracked
 * separately: MATCHUP_TARGET is the floor at which a matchup stops being noise,
 * MATCHUP_SOLID is where it carries real weight.
 */
export const POOL_TARGET = 385
export const MATCHUP_TARGET = 30
export const MATCHUP_SOLID = 100

/** Retained for the champion header's "x of y games" progress copy. */
const SOLID_POOL_TARGET = POOL_TARGET

function ItemIcon({ id, size, catalog, version }: { id: number; size?: number; catalog: Map<number, ItemInfo>; version: string }) {
  const item = catalog.get(id)
  const style = size ? { width: size, height: size } : undefined
  if (!item) return <span className="ot-tile-icon" style={style}><span className="ot-placeholder">{id}</span></span>
  return (
    <span className="ot-tile-icon" style={style} title={`${item.name} · ${item.gold}g`}>
      <img src={`https://ddragon.leagueoflegends.com/cdn/${version}/img/item/${item.image}`} alt="" loading="lazy" />
    </span>
  )
}

/**
 * Champion portrait. `files` maps champion id -> Data Dragon image key, which
 * is not derivable from the display name (Wukong -> MonkeyKing, Cho'Gath ->
 * Chogath, Nunu & Willump -> Nunu). A broken load falls back to the id chip
 * instead of showing the browser's broken-image glyph.
 */
function ChampionIcon({ id, size = 30, names, files, version }: { id: number; size?: number; names: Map<number, string>; files?: Map<number, string>; version: string }) {
  const name = names.get(id)
  const file = files?.get(id) ?? name?.replace(/[^A-Za-z0-9]/g, '')
  if (!name || !file) return <span className="ot-tile-icon" style={{ width: size, height: size }}><span className="ot-placeholder">{id}</span></span>
  return (
    <span className="ot-tile-icon" style={{ width: size, height: size }} title={name}>
      <img
        src={`https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${file}.png`}
        alt={name}
        loading="lazy"
        onError={(event) => {
          const image = event.currentTarget as HTMLImageElement
          image.style.display = 'none'
          image.parentElement?.classList.add('is-missing-icon')
        }}
      />
      <span className="ot-placeholder ot-icon-fallback">{id}</span>
    </span>
  )
}

function SpellIcon({ id, version }: { id: number; version: string }) {
  const file = SUMMONER_SPELL_NAMES[id] ?? `SummonerFlash`
  return (
    <span className="ot-tile-icon" title={`Spell ${id}`}>
      <img src={`https://ddragon.leagueoflegends.com/cdn/${version}/img/spell/${file}.png`} alt="" loading="lazy" />
    </span>
  )
}

/** Summoner spell ids that are never part of a viable Irelia pairing. */
const INVALID_SUMMONER_SPELLS = new Set([6, 7, 13, 21, 32])

/* ------------------------------------------------------------------ *
 * Sections
 * ------------------------------------------------------------------ */

function ChampionHeader({
  championName, championId, lane, build, versions, banRate,
}: {
  championName: string
  championId: number
  lane: 'TOP' | 'MID'
  build: BuildResponse | null
  versions: string
  banRate: ConfidenceInterval | null
}) {
  const games = build?.games ?? 0
  const weighted = build?.weighted
  const effective = build?.weighting?.effectiveSampleSize ?? games
  const tier = confidenceTier(effective)
  const gamesForSolid = SOLID_POOL_TARGET - Math.round(effective)
  return (
    <section className="ot-champ-header">
      <span className="ot-champ-portrait">
        <img
          src={`https://ddragon.leagueoflegends.com/cdn/${versions}/img/champion/Irelia.png`}
          alt={championName}
        />
      </span>
      <div className="ot-champ-title">
        <h2>{championName} · {lane}</h2>
        <p>
          {build?.patchExact ? `Patch ${build.patch}` : build?.patch ? `Most recent data: patch ${build.patch}` : 'No patch data yet'}
          {build?.source === 'comp' ? ' · composition-matched' : ' · lane route'}
        </p>
        <p className="ot-pool-progress" title={tier.hint}>
          <span className={`ot-tier-badge ${tier.cls}`}>{tier.label}</span>
          {effective < SOLID_POOL_TARGET
            ? `${Math.round(effective)} of ${SOLID_POOL_TARGET} games for ±5%`
            : `${Math.round(effective)} games — solid at ±5%`}
          {gamesForSolid > 0 && <span className="ot-ci"> · {gamesForSolid} more needed</span>}
        </p>
      </div>
      <div className="ot-champ-metrics">
        <div className="ot-metric">
          <strong>{games}</strong>
          <span>games</span>
        </div>
        <div className={`ot-metric ${(weighted?.estimate ?? 0) >= 0.5 ? 'is-win' : 'is-loss'}`}>
          <strong>{weighted ? pct0(weighted.estimate) : '—'}</strong>
          <span>win rate</span>
        </div>
        <div className="ot-metric">
          <strong>{effective !== undefined ? effective.toFixed(0) : '—'}</strong>
          <span>effective n</span>
        </div>
        <div className="ot-metric">
          <strong>{banRate && banRate.sampleSize >= 30 ? pct0(banRate.estimate) : '—'}</strong>
          <span>ban rate (sampled)</span>
        </div>
      </div>
      <input type="hidden" value={championId} />
    </section>
  )
}


function BuildPathCard({
  profile, itemCatalog, setFilteredFirst, version,
}: {
  profile: BuildProfile
  itemCatalog: Map<number, ItemInfo>
  setFilteredFirst: (id: number | null) => void
  version: string
}) {
  const [tab, setTab] = useState<'paths' | 'options'>('paths')
  const [filteredFirst, setLocalFiltered] = useState<number | null>(null)

  // The complete sequence (starting items -> finished build) is preferred so the
  // card always shows a full path; anything else is a fallback for old caches.
  const path = profile.fullBuild?.length
    ? profile.fullBuild
    : (profile.purchasePath.length ? profile.purchasePath : profile.coreItems).slice(0, 10)

  function chooseFirst(id: number) {
    setLocalFiltered(filteredFirst === id ? null : id)
    setFilteredFirst(filteredFirst === id ? null : id)
  }

  /**
   * Marks which path entries are the selected first purchase.
   *
   * The aggregate purchase path carries a single average purchase minute per
   * item, not per-game sequences, so there is no honest way to compute a
   * conditional path ("games that started X then bought Y"). Rather than
   * fabricate that, the selection highlights the chosen opening and reports its
   * own observed frequency and timing, and the caption states the limitation.
   */
  const filtered = path
  const selectedEntry = filteredFirst ? path.find((entry) => entry.id === filteredFirst) : undefined

  return (
    <section className="ot-card">
      <div className="ot-card-head">
        <h3>Build Path</h3>
        <div className="ot-head-right">
          <div className="ot-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'paths'} className={tab === 'paths' ? 'is-active' : ''} onClick={() => setTab('paths')}>
              Paths
            </button>
            <button type="button" role="tab" aria-selected={tab === 'options'} className={tab === 'options' ? 'is-active' : ''} onClick={() => setTab('options')}>
              Options
            </button>
          </div>
        </div>
      </div>

      {tab === 'paths' ? (
        profile.slots?.length ? (
          <div className="ot-slots">
            {profile.startingItems.length > 0 && (
              <div className="ot-slot-row">
                <span className="ot-slot-label">Start</span>
                <div className="ot-slot-options">
                  {profile.startingItems.slice(0, 3).map((entry) => (
                    <div className="ot-slot-option" key={entry.id}>
                      <ItemIcon id={entry.id} size={34} catalog={itemCatalog} version={version} />
                      <span className="ot-slot-share">{pct0(entry.games / (profile.games || 1))}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {profile.boots.length > 0 && (
              <div className="ot-slot-row">
                <span className="ot-slot-label">Boots</span>
                <div className="ot-slot-options">
                  {profile.boots.slice(0, 3).map((entry) => (
                    <div
                      className="ot-slot-option"
                      key={entry.id}
                      title={`${itemCatalog.get(entry.id)?.name ?? `Item ${entry.id}`} · ${entry.games} games · ${pct0(entry.winRate)} win rate`}
                    >
                      <ItemIcon id={entry.id} size={34} catalog={itemCatalog} version={version} />
                      <span className="ot-slot-share">{pct0(entry.games / (profile.games || 1))}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {profile.slots.map((slot) => (
              <div className="ot-slot-row" key={slot.slot}>
                <span className="ot-slot-label">{ordinal(slot.slot)} item</span>
                <div className="ot-slot-options">
                  {slot.options.map((option) => {
                    const isBest = slot.bestId === option.id
                    return (
                      <div
                        className={`ot-slot-option ${isBest ? 'is-best' : ''}`}
                        key={option.id}
                        title={
                          `${itemCatalog.get(option.id)?.name ?? `Item ${option.id}`} · ${option.games} games · `
                          + `${pct0(option.winRate)} win rate${isBest ? ' · statistically best for this slot' : ''}`
                        }
                      >
                        <ItemIcon id={option.id} size={34} catalog={itemCatalog} version={version} />
                        <span className="ot-slot-share">{pct0(option.share)}</span>
                        {isBest && (
                          <span className="ot-best-badge">BEST · {pct0(option.winRate)}</span>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
            <p className="ot-caveat">
              Boots get their own row because players finish them at very different points; the numbered rows are
              the completed items in order. Each percentage is the share of games that reached that slot with
              that item. A highlighted item is the statistically best in that slot: the highest win rate with at
              least 10 games behind it and a real edge over the next option — where the sample cannot separate
              the options, nothing is crowned.
            </p>
          </div>
        ) : path.length ? (
          <>
            <div className="ot-build-row">
              {filtered.map((entry, index) => (
                <div key={`${entry.id}-${index}`} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <div className={`ot-tile ot-step ${entry.id === filteredFirst ? 'is-selected' : ''}`}>
                    <span className="ot-step-index">{index + 1}</span>
                    <ItemIcon id={entry.id} size={34} catalog={itemCatalog} version={version} />
                    <span className="ot-tile-caption">
                      {entry.averageMinute !== null ? `${Math.round(entry.averageMinute)}m` : `${entry.games}×`}
                    </span>
                  </div>
                  {index < filtered.length - 1 && <span className="ot-build-arrow">›</span>}
                </div>
              ))}
            </div>
            <div className="ot-filtered-note">
              {filteredFirst && selectedEntry ? (
                <>
                  First item:
                  <span className="ot-first-item"><ItemIcon id={filteredFirst} catalog={itemCatalog} version={version} /></span>
                  <span style={{ color: 'var(--ot-dim)' }}>
                    {selectedEntry.games} of {profile.games} games
                    {selectedEntry.averageMinute !== null ? ` · avg ${Math.round(selectedEntry.averageMinute)}m` : ''}
                  </span>
                  <button type="button" className="ot-link-button" onClick={() => chooseFirst(filteredFirst)}>change</button>
                </>
              ) : (
                <>
                  Showing all purchase orders.
                  <span style={{ color: 'var(--ot-dimmer)' }}>Pick an item in Options to track a first purchase.</span>
                </>
              )}
            </div>
          </>
        ) : <p className="ot-empty">No purchase-order sample yet.</p>
      ) : (
        <div className="ot-item-list">
          {profile.coreItems.slice(0, 10).map((entry) => {
            const item = itemCatalog.get(entry.id)
            return (
              <button
                type="button"
                className="ot-item-row"
                key={entry.id}
                onClick={() => chooseFirst(entry.id)}
                style={{ background: 'none', border: 0, cursor: 'pointer', padding: 0, textAlign: 'left' }}
              >
                <ItemIcon id={entry.id} size={26} catalog={itemCatalog} version={version} />
                <span className="ot-row-name">{item?.name ?? `Item ${entry.id}`}</span>
                <span className="ot-row-games">{entry.games}×</span>
                <span className="ot-row-pct">{pct0(entry.winRate)}</span>
              </button>
            )
          })}
          {!profile.coreItems.length && <p className="ot-empty">No item options yet.</p>}
        </div>
      )}
    </section>
  )
}

function PopularItems({
  profile, itemCatalog, version,
}: { profile: BuildProfile; itemCatalog: Map<number, ItemInfo>; version: string }) {
  const games = profile.games || 1
  const boots = profile.boots
  const legendary = profile.fullItems.filter((entry) => !profile.boots.some((boot) => boot.id === entry.id))

  function column(title: string, rows: ServerItemShare[]) {
    return (
      <div>
        <div className="ot-subhead">{title}</div>
        <div className="ot-item-list">
          {rows.length ? rows.map((entry) => {
            const item = itemCatalog.get(entry.id)
            return (
              <div className="ot-item-row" key={entry.id}>
                <ItemIcon id={entry.id} size={26} catalog={itemCatalog} version={version} />
                <span className="ot-row-name">{item?.name ?? `Item ${entry.id}`}</span>
                <span className="ot-row-games">{entry.games}×</span>
                <span className="ot-row-pct">{pct0(entry.games / games)}</span>
              </div>
            )
          }) : <p className="ot-empty">No sample.</p>}
        </div>
      </div>
    )
  }

  return (
    <section className="ot-card">
      <div className="ot-card-head"><h3>Popular Items</h3></div>
      <div className="ot-item-columns">
        {column('Boots', boots)}
        {column('Legendary', legendary)}
      </div>
    </section>
  )
}

function RunesCard({
  profile, runeCatalog, runeNames, runeTreeNames,
}: {
  profile: BuildProfile
  runeCatalog: Map<number, NamedId>
  runeNames: Map<number, string>
  /** Rune id -> owning tree name, for grouping the grid. */
  runeTreeNames: Map<number, string>
}) {
  const [setIndex, setSetIndex] = useState(0)

  const primary = profile.primaryStyles
  const secondary = profile.secondaryStyles
  const keystones = profile.keystones
  const shards = profile.runeShards

  if (!keystones.length && !shards.length) {
    return (
      <section className="ot-card">
        <div className="ot-card-head"><h3>Runes</h3></div>
        <p className="ot-empty">No rune sample yet.</p>
      </section>
    )
  }

  // Each "set" is a keystone candidate; its tree is the primary tree recorded for
  // the sample, with the shard row shown beneath.
  const sets = (keystones.length ? keystones : shards).slice(0, 4)
  const active = sets[Math.min(setIndex, sets.length - 1)]
  const totalGames = profile.games || 1

  /**
   * Runes belonging to the active keystone's tree.
   *
   * `runeNames` maps rune ids to rune names, so it cannot resolve a tree name.
   * The tree name has to come from `runeTreeNames` (id -> tree name), which the
   * caller derives from the tree entries in the Data Dragon catalog.
   */
  const activeTreeName = active ? runeTreeNames.get(active.id) : undefined
  const treeRunes = activeTreeName
    ? [...runeCatalog.values()].filter((rune) => !rune.isTree && rune.tree === activeTreeName)
    : []

  /**
   * Rune ids observed in the captured games, with their sample counts. This is
   * what distinguishes a chosen page from the full tree: rendering every rune in
   * a tree would imply picks that were never taken.
   */
  const chosen = new Map(shards.map((entry) => [entry.id, entry.games]))
  const chosenRunes = [...chosen.entries()]
    .map(([id, games]) => ({ rune: runeCatalog.get(id), id, games }))
    .filter((entry) => entry.rune && !entry.rune.isTree)
    .sort((a, b) => b.games - a.games)

  return (
    <section className="ot-card">
      <div className="ot-card-head">
        <h3>Runes</h3>
        <div className="ot-head-right">
          <span className="ot-ci">n={profile.games}</span>
        </div>
      </div>

      <div className="ot-rune-trees">
        <div className="ot-rune-tree" style={{ flex: 1 }}>
          <span className="ot-rune-tree-label">
            {primary[0] ? runeNames.get(primary[0].id) ?? 'Primary' : 'Primary'}
          </span>
          <div className="ot-rune-grid">
            {treeRunes.map((rune) => {
              const games = chosen.get(rune.id)
              const isChosen = games !== undefined || rune.id === active?.id
              const isKeystone = rune.id === active?.id
              const title = `${rune.name}${games ? ` · ${games}×` : ' · not observed'}`
              return (
                <span
                  className={`ot-rune ${isKeystone ? 'is-keystone' : ''} ${isChosen ? '' : 'is-muted'}`}
                  key={rune.id}
                  title={title}
                >
                  <img src={`https://ddragon.leagueoflegends.com/cdn/img/${rune.icon}`} alt={rune.name} loading="lazy" />
                </span>
              )
            })}
            {!treeRunes.length && chosenRunes.map(({ rune, id, games }) => (
              <span className={`ot-rune ${id === active?.id ? 'is-keystone' : ''}`} key={id} title={`${rune!.name} · ${games}×`}>
                <img src={`https://ddragon.leagueoflegends.com/cdn/img/${rune!.icon}`} alt="" loading="lazy" />
              </span>
            ))}
          </div>
        </div>

        {secondary[0] && (
          <div className="ot-rune-tree">
            <span className="ot-rune-tree-label">{runeNames.get(secondary[0].id) ?? 'Secondary'}</span>
            <div className="ot-rune-grid" style={{ maxWidth: 160 }}>
              {shards.slice(0, 4).map((entry) => {
                const rune = runeCatalog.get(entry.id)
                return (
                  <span className="ot-rune" key={entry.id} title={`${rune?.name ?? entry.id} · ${entry.games}×`}>
                    {rune?.icon
                      ? <img src={`https://ddragon.leagueoflegends.com/cdn/img/${rune.icon}`} alt="" loading="lazy" />
                      : <span className="ot-placeholder">{entry.id}</span>}
                  </span>
                )
              })}
            </div>
          </div>
        )}
      </div>

      <div className="ot-rune-set-tabs">
        {sets.map((entry, index) => (
          <button
            type="button"
            className={`ot-rune-set ${index === setIndex ? 'is-active' : ''}`}
            key={entry.id}
            onClick={() => setSetIndex(index)}
          >
            <span className="ot-set-icon">
              {runeCatalog.get(entry.id)?.icon
                ? <img src={`https://ddragon.leagueoflegends.com/cdn/img/${runeCatalog.get(entry.id)!.icon}`} alt="" loading="lazy" />
                : <span className="ot-placeholder">{entry.id}</span>}
            </span>
            Set {index + 1}
            <em>{pct0(entry.games / totalGames)}</em>
          </button>
        ))}
      </div>
    </section>
  )
}

function SkillGrid({
  title, levels, rows, sampleSize,
}: {
  title: string
  levels: number
  rows: SkillLevelRow[]
  sampleSize: number
}) {
  const byLevel = new Map(rows.map((row) => [row.level, row]))
  return (
    <div>
      <div className="ot-subhead">{title}</div>
      <div className="ot-grid-wrap">
        <table className="ot-skill-grid">
          <thead>
            <tr>
              <th />
              {Array.from({ length: levels }, (_, index) => (
                <th key={index}>{index + 1}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[1, 2, 3, 4].map((slot) => (
              <tr key={slot}>
                <th className="ot-skill-letter">{SKILL_LETTERS[slot]}</th>
                {Array.from({ length: levels }, (_, index) => {
                  const row = byLevel.get(index + 1)
                  const count = row?.counts?.[slot] ?? 0
                  const isModal = row?.slot === slot && count > 0
                  return (
                    <td key={index} className={count > 0 ? (isModal ? 'is-modal' : 'is-filled') : ''}>
                      {count > 0 ? count : ''}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ot-skill-pct" style={{ marginTop: 6 }}>
        {rows.length
          ? `modal choice: ${rows.map((row) => SKILL_LETTERS[row.slot]).join('')} · n=${sampleSize}`
          : `no sample (n=${sampleSize})`}
      </div>
    </div>
  )
}

function SkillsCard({
  profile, skills, version,
}: { profile: BuildProfile; skills?: SkillOrderAnalysis; version: string }) {
  const spells = profile.spells.filter((entry) => !entry.ids.some((id) => INVALID_SUMMONER_SPELLS.has(id)))
  const priority = skills?.priority ?? [1, 2, 3]

  return (
    <section className="ot-card">
      <div className="ot-card-head"><h3>Skills and Spells</h3></div>
      <div className="ot-skill-cols">
        <div>
          <div className="ot-subhead">Summoners</div>
          <div className="ot-summoners">
            {spells.length ? spells.slice(0, 3).map((spell) => (
              <div className="ot-summoner-row" key={spell.ids.join('-')}>
                <span className="ot-summoner-pair">
                  {spell.ids.map((id) => <SpellIcon key={id} id={id} version={version} />)}
                </span>
                <span className="ot-row-pct">{pct0(spell.winRate)}</span>
                <span className="ot-ci">{spell.games}×</span>
              </div>
            )) : <p className="ot-empty">No spell sample.</p>}
          </div>

          <div className="ot-subhead" style={{ marginTop: 16 }}>Skill Priority</div>
          <div className="ot-skill-priority">
            {priority.map((slot, index) => (
              <span key={slot} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="ot-priority-chip">{SKILL_LETTERS[slot]}</span>
                {index < priority.length - 1 && <span style={{ color: 'var(--ot-dimmer)' }}>›</span>}
              </span>
            ))}
          </div>
          {skills?.earlyOrder && (
            <p className="ot-ci" style={{ marginTop: 6 }}>
              levels 1-3: {skills.earlyOrder.split('').map((slot) => SKILL_LETTERS[Number(slot)] ?? '?').join(' → ')}
            </p>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <SkillGrid title="Levels 1-3" levels={3} rows={skills?.rows ?? []} sampleSize={skills?.sampleSize ?? 0} />
          <SkillGrid title="Levels 1-13" levels={13} rows={skills?.rows ?? []} sampleSize={skills?.sampleSize ?? 0} />
        </div>
      </div>
    </section>
  )
}

function RecentGames({
  games, loading, itemCatalog, championNames, championFiles, runeCatalog, ddragonVersion,
}: {
  games: GameRow[]
  loading: boolean
  itemCatalog: Map<number, ItemInfo>
  championNames: Map<number, string>
  championFiles: Map<number, string>
  runeCatalog: Map<number, NamedId>
  ddragonVersion: string
}) {
  const [itemFilter, setItemFilter] = useState<'all' | number>('all')
  const [runeFilter, setRuneFilter] = useState<'all' | number>('all')

  const itemOptions = [...new Set(games.flatMap((game) => game.finalItems))]
    .map((id) => ({ id, name: itemCatalog.get(id)?.name ?? `Item ${id}` }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const runeOptions = [...new Set(games.map((game) => game.keystoneId).filter((id): id is number => typeof id === 'number'))]
    .map((id) => ({ id, name: runeCatalog.get(id)?.name ?? `Rune ${id}` }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const filtered = games.filter((game) => {
    if (itemFilter !== 'all' && !game.finalItems.includes(itemFilter)) return false
    if (runeFilter !== 'all' && game.keystoneId !== runeFilter) return false
    return true
  })

  return (
    <section className="ot-card ot-games-card">
      <div className="ot-games-head">
        <h3>Recent Games</h3>
        <div className="ot-games-filters">
          <label>
            Item:
            <select value={String(itemFilter)} onChange={(event) => setItemFilter(event.target.value === 'all' ? 'all' : Number(event.target.value))}>
              <option value="all">All</option>
              {itemOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
            </select>
          </label>
          <label>
            Rune:
            <select value={String(runeFilter)} onChange={(event) => setRuneFilter(event.target.value === 'all' ? 'all' : Number(event.target.value))}>
              <option value="all">All</option>
              {runeOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
            </select>
          </label>
        </div>
        <div className="ot-games-meta">
          {(itemFilter !== 'all' || runeFilter !== 'all') && (
            <span className="ot-ci">showing {filtered.length} of {games.length}</span>
          )}
          <span>Champion: Irelia</span>
          <span>Queue: Ranked Solo</span>
        </div>
      </div>

      <div className="ot-game-list">
        {loading && !games.length && <p className="ot-empty" style={{ padding: '14px 17px' }}>Loading recent games…</p>}
        {!loading && !filtered.length && <p className="ot-empty" style={{ padding: '14px 17px' }}>No captured Irelia games match these filters.</p>}
        {filtered.slice(0, 25).map((game) => (
          <div className={`ot-game ${game.win ? 'is-win' : 'is-loss'}`} key={game.matchId}>
            <span className="ot-game-edge" />
            <div>
              <div className="ot-game-result">{game.win ? 'Victory' : 'Defeat'}</div>
              <div className="ot-game-duration">{duration(game.duration)}</div>
              <div className="ot-game-duration" style={{ color: 'var(--ot-dimmer)' }}>{timeAgo(game.gameCreation)}</div>
            </div>
            <div className="ot-game-player">
              <strong>{game.summonerName ?? 'Unknown'}</strong>
              <span>{game.region ?? '—'} · {game.position} · patch {game.patch}</span>
            </div>
            <div className="ot-game-kda">
              {game.kills} / {game.deaths} / {game.assists}
              <small>
                {game.deaths === 0
                  ? 'Perfect'
                  : `${((game.kills + game.assists) / game.deaths).toFixed(2)} KDA`}
              </small>
            </div>
            <div className="ot-game-stat">
              <strong>{game.cs} CS</strong>
              <span>
                {game.duration ? (game.cs / (game.duration / 60)).toFixed(1) : '—'}/m
              </span>
            </div>
            <div className="ot-game-stat">
              <strong>{game.killParticipation !== null ? pct0(game.killParticipation) : '—'}</strong>
              <span>KP</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
              <div className="ot-game-versus">
                <ChampionIcon id={39} size={26} names={championNames} files={championFiles} version={ddragonVersion} />
                <em>VS</em>
                {game.opponentChampionId
                  ? <ChampionIcon id={game.opponentChampionId} size={26} names={championNames} files={championFiles} version={ddragonVersion} />
                  : <span className="ot-tile-icon" style={{ width: 26, height: 26 }}><span className="ot-placeholder">?</span></span>}
              </div>
              <div className="ot-game-stat" title="Lane differential at 15 minutes">
                <strong>{signed(game.laneDeltas.goldDiff15)}</strong>
                <span>gold @15</span>
              </div>
              <div className="ot-game-items">
                {game.finalItems.map((id, index) => (
                  <ItemIcon key={`${id}-${index}`} id={id} size={25} catalog={itemCatalog} version={ddragonVersion} />
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ *
 * OTP of choice: deep-history comparison against everyone else
 * ------------------------------------------------------------------ */

type OtpSlotOptionData = {
  id: number
  games: number
  share: number
  winRate: number
  otpRate: number
  agreement: boolean
  score: number
}

type OtpBuildLite = {
  games: number
  winRate: number
  slots: Array<{ slot: number; options: Array<{ id: number; games: number; share: number; winRate: number }> }>
}

type OtpCompareData = {
  patch: string
  otp: { riotId: string; games: number; winRate: number; profile: { slots: OtpBuildLite['slots'] }; byOpponent: Record<string, OtpBuildLite> }
  baseline: { games: number; winRate: number; byOpponent: Record<string, OtpBuildLite> }
  previous: { riotId: string; patch: string; ireliaGames: number } | null
  slots: Array<{ slot: number; bestId: number | null; options: OtpSlotOptionData[] }>
}

function OtpComparisonPanel({ itemCatalog, championNames, championFiles, ddragonVersion }: {
  itemCatalog: Map<number, ItemInfo>
  championNames: Map<number, string>
  championFiles: Map<number, string>
  ddragonVersion: string
}) {
  const [data, setData] = useState<OtpCompareData | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [failure, setFailure] = useState('')

  useEffect(() => {
    let cancelled = false
    void fetch('/api/riot/otp-compare?lane=TOP')
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      })
      .then((json: OtpCompareData) => { if (!cancelled) setData(json) })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setData(null)
          // 404 = no OTP sourced yet (normal); anything else deserves a visible note.
          const message = reason instanceof Error ? reason.message : 'unavailable'
          setFailure(message.startsWith('HTTP 404') ? '' : message)
        }
      })
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [])

  if (!loaded) return null
  if (!data) {
    if (!failure) return null
    return (
      <section className="ot-card">
        <div className="ot-card-head">
          <h3>OTP of choice</h3>
        </div>
        <p className="ot-empty">
          Comparison unavailable ({failure}) — restart the app if this persists.
        </p>
      </section>
    )
  }

  const itemName = (id: number) => itemCatalog.get(id)?.name ?? `Item ${id}`
  const otpSlotPick = (slot: number) => data.otp.profile?.slots?.find((entry) => entry.slot === slot)?.options[0] ?? null
  const opponents = Object.keys(data.baseline.byOpponent)
    .filter((key) => data.otp.byOpponent[key])
    .sort((a, b) => data.otp.byOpponent[b].games - data.otp.byOpponent[a].games)

  return (
    <section className="ot-card">
      <div className="ot-card-head">
        <h3>OTP of choice · {data.otp.riotId}</h3>
        <div className="ot-head-right"><span className="ot-ci">patch {data.patch}</span></div>
      </div>
      <p className="ot-caveat">
        {data.otp.games} of his Irelia games vs the field&apos;s {data.baseline.games} (his own excluded).
        Win rate {pct0(data.otp.winRate)} vs {pct0(data.baseline.winRate)}. Where his item order agrees with
        the field, the consensus pick&apos;s score is boosted.
      </p>

      <div className="ot-subhead">General build path order</div>
      <div className="ot-item-list">
        {data.slots.map((slot) => {
          const his = otpSlotPick(slot.slot)
          const best = slot.options[0]
          return (
            <div className="ot-item-row" key={slot.slot}>
              <span className="ot-row-name">Slot {slot.slot}</span>
              <span style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                {his ? <ItemIcon id={his.id} size={25} catalog={itemCatalog} version={ddragonVersion} /> : null}
                <span className="ot-row-games" title={`He takes ${itemName(his?.id ?? 0)} ${his ? pct0(his.share) : '—'} of the time`}>
                  {his ? pct0(his.share) : '—'}
                </span>
              </span>
              <span style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                <ItemIcon id={best.id} size={25} catalog={itemCatalog} version={ddragonVersion} />
                <span className="ot-row-games" title={`${itemName(best.id)} · field share ${pct0(best.share)} · consensus score ${best.score.toFixed(3)}`}>
                  {best.agreement ? '✓ consensus' : 'field pick'}
                </span>
              </span>
            </div>
          )
        })}
      </div>

      <div className="ot-subhead">Head-to-head build order</div>
      {opponents.length === 0 && <p className="ot-empty">No shared matchups with the field yet.</p>}
      {opponents.slice(0, 12).map((key) => {
        const id = Number(key)
        const his = data.otp.byOpponent[key]
        const field = data.baseline.byOpponent[key]
        const hisFirst = his.slots?.[0]?.options[0] ?? null
        const fieldFirst = field.slots?.[0]?.options[0] ?? null
        return (
          <div className="ot-item-row" key={key}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <ChampionIcon id={id} size={24} names={championNames} files={championFiles} version={ddragonVersion} />
              <span className="ot-row-name">{championNames.get(id) ?? `#${id}`}</span>
              <span className="ot-row-games">{his.games} vs {field.games} games</span>
            </span>
            <span style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
              {hisFirst ? <ItemIcon id={hisFirst.id} size={25} catalog={itemCatalog} version={ddragonVersion} /> : null}
              <span className="ot-row-games" title={`His first item: ${itemName(hisFirst?.id ?? 0)}`}>his</span>
            </span>
            <span style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
              {fieldFirst ? <ItemIcon id={fieldFirst.id} size={25} catalog={itemCatalog} version={ddragonVersion} /> : null}
              <span className="ot-row-games" title={`Field first item: ${itemName(fieldFirst?.id ?? 0)}`}>field</span>
            </span>
          </div>
        )
      })}

      {data.previous && (
        <p className="ot-caveat">
          Archive: {data.previous.riotId} · patch {data.previous.patch} · {data.previous.ireliaGames} Irelia
          games — kept for the stack-over-time comparison.
        </p>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ *
 * View
 * ------------------------------------------------------------------ */

export default function OnetricksView({
  build, loading, championName, championId, lane, setLane,
  opponent, setOpponent, champions,
  itemCatalog, runeCatalog, runeTreeNames, championNames, championFiles,
  ddragonVersion, banRate, games, gamesLoading,
  sinceHours, setSinceHours, clientStatus,
}: OnetricksProps) {
  const [, setFilteredFirst] = useState<number | null>(null)
  const profile = build?.profile

  return (
    <div className="ot-page">
      <div className="ot-filterbar">
        <button type="button" className="ot-chip ot-all-chip" title={`${championName} build`}>
          <ChampionIcon id={championId} size={20} names={championNames} files={championFiles} version={ddragonVersion} />
          ALL
        </button>

        <button
          type="button"
          className={`ot-chip ${lane === 'TOP' ? 'is-active' : ''}`}
          onClick={() => setLane('TOP')}
        >
          TOP
        </button>
        <button
          type="button"
          className={`ot-chip ${lane === 'MID' ? 'is-active' : ''}`}
          onClick={() => setLane('MID')}
        >
          MID
        </button>

        <label className="ot-select-pill">
          vs.
          <select value={opponent} onChange={(event) => setOpponent(Number(event.target.value))}>
            <option value={0}>All</option>
            {champions.map((champion) => (
              <option key={champion.id} value={champion.id}>{champion.name}</option>
            ))}
          </select>
        </label>

        <label className="ot-select-pill">
          Period
          <select value={sinceHours} onChange={(event) => setSinceHours(Number(event.target.value))}>
            <option value={0}>All time</option>
            <option value={24}>Last 24 hours</option>
            <option value={168}>Last 7 days</option>
            <option value={720}>Last 30 days</option>
          </select>
        </label>

        <span className="ot-patch-pill">
          Patch {build?.patch || ddragonVersion.slice(0, 5) || '—'}
        </span>

        <div className="ot-filter-right">
          <span className={`ot-client-badge ${clientStatus?.connected ? 'is-on' : ''}`} title={clientStatus?.connected ? (clientStatus.inChampSelect ? 'League Client connected and in champion select.' : 'League Client connected.') : 'League Client not detected. Start it to auto-scan your draft.'}>
            {clientStatus?.connected
              ? (clientStatus.inChampSelect ? 'Client: in champ select' : 'Client: running')
              : 'Client: not running'}
          </span>
          {banRate && banRate.sampleSize >= 30 ? (
            <span className="ot-ban-badge" title={`Irelia was banned in ${banRate.sampleSize} sampled ranked games. Riot's public API exposes no global ban rates, so this is sample-derived.`}>
              Most banned
              <strong>{pct0(banRate.estimate)}</strong>
            </span>
          ) : (
            <span className="ot-ban-badge" title="Too few captured games for a stable ban rate.">
              Most banned
              <strong>—</strong>
            </span>
          )}
        </div>
      </div>

      <ChampionHeader
        championName={championName}
        championId={championId}
        lane={lane}
        build={build}
        versions={ddragonVersion}
        banRate={banRate}
      />

      {loading && !build && <p className="ot-empty">Loading build…</p>}

      {!loading && !build && (
        <p className="ot-empty">
          No build yet. Capture some Irelia games with a scan, then pick a lane opponent.
        </p>
      )}

      {profile && profile.games > 0 && (
        <>
          <div className="ot-columns">
            <div className="ot-col">
              <BuildPathCard
                profile={profile}
                itemCatalog={itemCatalog}
                setFilteredFirst={setFilteredFirst}
                version={ddragonVersion}
              />

              <PopularItems profile={profile} itemCatalog={itemCatalog} version={ddragonVersion} />

              {build?.itemSets?.length ? (
                <section className="ot-card">
                  <div className="ot-card-head">
                    <h3>Optimised Builds</h3>
                    <div className="ot-head-right"><span className="ot-ci">whole-inventory matching</span></div>
                  </div>
                  <div className="ot-item-list">
                    {build.itemSets.slice(0, 6).map((set, index) => (
                      <div className="ot-item-row" key={index}>
                        <span style={{ display: 'flex', gap: 3 }}>
                          {set.items.map((id, itemIndex) => (
                            <ItemIcon key={`${id}-${itemIndex}`} id={id} size={25} catalog={itemCatalog} version={ddragonVersion} />
                          ))}
                        </span>
                        <span className="ot-row-games">{set.games}×</span>
                        <span className="ot-row-pct">{pct0(set.winRate.estimate)}</span>
                        <Ci interval={set.winRate} />
                      </div>
                    ))}
                  </div>
                  <p className="ot-caveat">
                    Grouped by finished inventory rather than independent item counts, so correlated
                    choices stay together. Intervals widen sharply below ~10 games.
                  </p>
                </section>
              ) : null}
            </div>

            <div className="ot-col">
              <RunesCard
                profile={profile}
                runeCatalog={runeCatalog}
                runeNames={new Map([...runeCatalog.values()].map((rune) => [rune.id, rune.name]))}
                runeTreeNames={runeTreeNames}
              />
              <SkillsCard profile={profile} skills={build?.skills} version={ddragonVersion} />

              {build?.weighted && (
                <section className="ot-card">
                  <div className="ot-card-head">
                    <h3>Weighted Estimate</h3>
                    <div className="ot-head-right"><Ci interval={build.weighted} /></div>
                  </div>
                  <div className="ot-item-list">
                    <div className="ot-item-row">
                      <span className="ot-row-name">Raw win rate</span>
                      <span className="ot-row-pct">{pct(profile.winRate)}</span>
                    </div>
                    <div className="ot-item-row">
                      <span className="ot-row-name">Context-weighted</span>
                      <span className="ot-row-pct">{pct(build.weighted.estimate)}</span>
                    </div>
                    <div className="ot-item-row">
                      <span className="ot-row-name">Effective sample</span>
                      <span className="ot-row-pct">{build.weighted.effectiveSampleSize.toFixed(1)}</span>
                    </div>
                  </div>
                  <p className="ot-caveat">
                    Games are weighted by enemy-laner identity, ally and enemy composition overlap, and
                    patch recency. Effective sample falls below the raw count when a few games dominate.
                  </p>
                </section>
              )}
            </div>
          </div>

          <RecentGames
            games={games}
            loading={gamesLoading}
            itemCatalog={itemCatalog}
            championNames={championNames}
            championFiles={championFiles}
            runeCatalog={runeCatalog}
            ddragonVersion={ddragonVersion}
          />

          <p className="ot-caveat">
            All figures are observational, sampled from captured Irelia games — not global Riot
            statistics. Riot's public API exposes no matchup or ban rates, so every number here is
            derived from the matches this app has cached, and each shows its sample size.
          </p>
        </>
      )}

      <OtpComparisonPanel
        itemCatalog={itemCatalog}
        championNames={championNames}
        championFiles={championFiles}
        ddragonVersion={ddragonVersion}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Onetrick games: a flat, filterable list of recent OTP games.
 * ------------------------------------------------------------------ */

export function OnetrickGamesView({
  games, gamesLoading, championNames, championFiles, itemCatalog, champions, ddragonVersion,
  onScanRoster, scanningRoster,
}: {
  games: GameRow[]
  gamesLoading: boolean
  championNames: Map<number, string>
  championFiles: Map<number, string>
  itemCatalog: Map<number, ItemInfo>
  champions: Champion[]
  ddragonVersion: string
  /** Deepens only the tracked one-tricks, skipping the ladder crawl. */
  onScanRoster: () => void
  scanningRoster: boolean
}) {
  const [opponentFilter, setOpponentFilter] = useState<number>(0)
  const [roster, setRoster] = useState<RosterEntry[] | null>(null)
  const [curatedCount, setCuratedCount] = useState(0)
  const [newSummoner, setNewSummoner] = useState('')
  const [rosterBusy, setRosterBusy] = useState(false)
  const [rosterError, setRosterError] = useState('')
  const filtered = opponentFilter > 0
    ? games.filter((game) => game.opponentChampionId === opponentFilter)
    : games

  const loadRoster = () => fetch('/api/riot/roster')
    .then((response) => response.json())
    .then((data: { roster?: RosterEntry[]; curated?: number }) => {
      setRoster(data.roster ?? [])
      setCuratedCount(data.curated ?? 0)
    })

  // The curated roster is what the scan deepens first, so it is worth surfacing
  // after the cut-off time.
  useEffect(() => {
    let cancelled = false
    void loadRoster().catch(() => { if (!cancelled) setRoster(null) })
    return () => { cancelled = true }
  }, [])

  const addSummoner = () => {
    const value = newSummoner.trim()
    if (!value.includes('#')) {
      setRosterError('Use the form Name#TAG, e.g. IRELKING#0729.')
      return
    }
    setRosterBusy(true)
    setRosterError('')
    fetch(`/api/riot/roster/add?riotId=${encodeURIComponent(value)}`)
      .then(async (response) => {
        const data = await response.json() as { roster?: RosterEntry[]; curated?: number; error?: string }
        if (!response.ok) throw new Error(data.error ?? 'Could not add that summoner.')
        setRoster(data.roster ?? [])
        setCuratedCount(data.curated ?? 0)
        setNewSummoner('')
      })
      .catch((reason: unknown) => setRosterError(reason instanceof Error ? reason.message : 'Could not add that summoner.'))
      .finally(() => setRosterBusy(false))
  }

  const removeSummoner = (entry: RosterEntry) => {
    setRosterBusy(true)
    setRosterError('')
    fetch(`/api/riot/roster/remove?riotId=${encodeURIComponent(`${entry.gameName}#${entry.tagLine}`)}`)
      .then((response) => response.json())
      .then((data: { roster?: RosterEntry[]; curated?: number }) => {
        setRoster(data.roster ?? [])
        setCuratedCount(data.curated ?? 0)
      })
      .catch(() => setRosterError('Could not remove that summoner.'))
      .finally(() => setRosterBusy(false))
  }

  return (
    <div className="ot-page">
      <section className="ot-card">
        <div className="ot-card-head">
          <h3>Priority one-tricks</h3>
          <div className="ot-head-right">
            <span className="ot-ci">{roster ? `${roster.length} tracked` : 'loading…'}</span>
            <button
              type="button"
              className="ot-scan-button"
              onClick={onScanRoster}
              disabled={scanningRoster}
              title="Pulls the newest games for every summoner in this list and skips the ladder crawl"
            >
              {scanningRoster ? 'Scanning roster…' : 'Scan these one-tricks'}
            </button>
          </div>
        </div>
        <p className="ot-roster-note">
          Scanning the roster pulls the newest games for these accounts only, without crawling the ladders.
        </p>
        <div className="ot-roster-add">
          <input
            type="text"
            value={newSummoner}
            onChange={(event) => setNewSummoner(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') addSummoner() }}
            placeholder="Add summoner as Name#TAG"
            aria-label="Summoner to add, as Name#TAG"
          />
          <button type="button" className="ot-scan-button" onClick={addSummoner} disabled={rosterBusy || !newSummoner.trim()}>
            {rosterBusy ? 'Working…' : 'Add'}
          </button>
        </div>
        {rosterError && <p className="ot-roster-error" role="alert">{rosterError}</p>}
        {roster && roster.length > 0 ? (
          <div className="ot-grid-wrap">
            <table className="roster-table">
              <thead>
                <tr>
                  <th>#</th><th>Tier</th><th>Player</th><th>Region</th>
                  <th>Play rate</th><th>Games</th><th>Win rate</th><th>KDA</th><th />
                </tr>
              </thead>
              <tbody>
                {roster.map((entry, index) => (
                  <tr key={`${entry.gameName}#${entry.tagLine}`}>
                    <td>{entry.rank}</td>
                    <td>{entry.tier}</td>
                    <td className="roster-player">
                      {entry.gameName}<span>#{entry.tagLine}</span>
                    </td>
                    <td>{entry.region} · {entry.leaguePoints.toLocaleString()} LP</td>
                    <td>{entry.playRate > 0 ? `${Math.round(entry.playRate * 100)}%` : '—'}</td>
                    <td>{entry.games > 0 ? entry.games : '—'}</td>
                    <td>{entry.winRate > 0 ? `${Math.round(entry.winRate * 100)}%` : '—'}</td>
                    <td>{entry.kda > 0 ? `${entry.kda.toFixed(2)}:1` : '—'}</td>
                    <td>
                      {index >= curatedCount && (
                        <button
                          type="button"
                          className="ot-roster-remove"
                          onClick={() => removeSummoner(entry)}
                          disabled={rosterBusy}
                          title={`Remove ${entry.gameName}#${entry.tagLine}`}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="ot-empty">Loading roster…</p>}
      </section>

      <div className="ot-filterbar">
        <span className="ot-chip">Onetrick games</span>
        <label className="ot-select-pill">
          vs.
          <select value={opponentFilter} onChange={(event) => setOpponentFilter(Number(event.target.value))}>
            <option value={0}>All laners</option>
            {champions.map((champion) => (
              <option key={champion.id} value={champion.id}>{champion.name}</option>
            ))}
          </select>
        </label>
        <div className="ot-filter-right">
          <span className="ot-ci">{filtered.length} games</span>
        </div>
      </div>

      {gamesLoading && !games.length && <p className="ot-empty" style={{ padding: 14 }}>Loading onetrick games…</p>}
      {!gamesLoading && !filtered.length && <p className="ot-empty" style={{ padding: 14 }}>No games match this laner.</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {filtered.slice(0, 40).map((game) => (
          <details key={game.matchId} className="ot-card" style={{ padding: 0, overflow: 'hidden' }}>
            <summary style={{ display: 'grid', gridTemplateColumns: '4px 90px 1fr auto', alignItems: 'center', gap: 12, padding: '11px 16px', cursor: 'pointer', listStyle: 'none' }}>
              <span style={{ alignSelf: 'stretch', borderRadius: '3px 0 0 3px', background: game.win ? 'var(--ot-win)' : 'var(--ot-loss)' }} />
              <span>
                <strong style={{ color: game.win ? 'var(--ot-win)' : 'var(--ot-loss)', fontSize: 12 }}>{game.win ? 'WIN' : 'LOSS'}</strong>
                <small style={{ display: 'block', color: 'var(--ot-dimmer)', fontSize: 11 }}>{timeAgo(game.gameCreation)}</small>
              </span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <strong style={{ fontSize: 12 }}>{game.summonerName ?? 'Unknown'}</strong>
                <small style={{ display: 'block', color: 'var(--ot-dimmer)', fontSize: 11 }}>
                  {game.kills}/{game.deaths}/{game.assists} · {game.cs} CS · {game.visionScore ?? '—'} vision
                </small>
              </span>
              {/* Labelled pill: without the caption the opponent portrait reads as
                  this player's own champion. */}
              <span className="ot-lane-vs" title={`${game.position} lane opponent`}>
                <small>{game.position} lane opponent</small>
                {game.opponentChampionId
                  ? <ChampionIcon id={game.opponentChampionId} size={24} names={championNames} files={championFiles} version={ddragonVersion} />
                  : null}
                <strong>{championNames.get(game.opponentChampionId ?? 0) ?? game.opponentName ?? 'Unknown'}</strong>
              </span>
              <span style={{ display: 'flex', gap: 3 }}>
                {game.finalItems.map((id, index) => <ItemIcon key={`${id}-${index}`} id={id} size={25} catalog={itemCatalog} version={ddragonVersion} />)}
              </span>
            </summary>

            <div style={{ padding: '12px 16px', borderTop: '1px solid var(--ot-line-soft)' }}>
              <div className="ot-subhead">Your team</div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                <ChampionIcon id={39} size={30} names={championNames} files={championFiles} version={ddragonVersion} />
                {game.allyChampionIds.map((id) => <ChampionIcon key={id} id={id} size={30} names={championNames} files={championFiles} version={ddragonVersion} />)}
              </div>
              <div className="ot-subhead" style={{ marginTop: 10 }}>Enemy team</div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {game.enemyChampionIds.map((id) => <ChampionIcon key={id} id={id} size={30} names={championNames} files={championFiles} version={ddragonVersion} />)}
              </div>
              {game.lanePurchases.length > 0 && (
                <>
                  <div className="ot-subhead" style={{ marginTop: 10 }}>Purchase order</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {[...game.lanePurchases].sort((a, b) => a.minute - b.minute).map((purchase, index) => (
                      <span key={index} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                        <ItemIcon id={purchase.id} size={28} catalog={itemCatalog} version={ddragonVersion} />
                        <small style={{ fontSize: 9, color: 'var(--ot-dimmer)' }}>{Math.round(purchase.minute)}m</small>
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
          </details>
        ))}
      </div>
    </div>
  )
}
