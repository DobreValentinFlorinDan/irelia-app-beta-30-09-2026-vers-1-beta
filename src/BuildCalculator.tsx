import { useEffect, useMemo, useState } from 'react'
import {
  optimizeBuilds,
  ranksFor,
  type BuildContext,
  type BuildResult,
  type CalcItem,
  type EvidenceEntry,
  type KitData,
} from './calculator.ts'

/* ------------------------------------------------------------------ *
 * Local helpers (kept separate from Fieldbook to avoid import cycles)
 * ------------------------------------------------------------------ */

async function apiGet<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} — ${url}`)
  }
  return response.json() as Promise<T>
}

/** Minimal structural view of Fieldbook's ItemInfo; extra fields flow through. */
type CatalogItem = {
  id: number
  name: string
  gold: number
  stats: Record<string, number>
  tags?: string[]
  purchasable?: boolean
  image?: string
}

type KitResponse = KitData

type EvidenceResponse = {
  source: string
  patch: string
  patchExact: boolean
  games: number
  profile: {
    games: number
    winRate: number
    fullItems: Array<{ id: number; games: number; winRate: number }>
  }
  reason: string
  itemSets?: Array<{ items: number[]; games: number; wins: number }>
}

type PresetId = 'balanced' | 'duel' | 'antitank' | 'survival' | 'teamfight'

type Preset = {
  id: PresetId
  label: string
  hint: string
  targetArmor: number
  targetMr: number
  targetHp: number
  threatPhysical: number
  weightBurst: number
  weightDps: number
  weightEhp: number
  weightHeal: number
}

const PRESETS: Preset[] = [
  { id: 'balanced', label: 'Balanced', hint: 'Well-rounded skirmish vs a bruiser', targetArmor: 70, targetMr: 45, targetHp: 1800, threatPhysical: 0.6, weightBurst: 1, weightDps: 2.4, weightEhp: 0.7, weightHeal: 0.6 },
  { id: 'duel', label: 'Duel · squishy', hint: 'Burst race vs a marksman/mage', targetArmor: 50, targetMr: 40, targetHp: 1600, threatPhysical: 0.55, weightBurst: 1.6, weightDps: 2, weightEhp: 0.5, weightHeal: 0.7 },
  { id: 'antitank', label: 'Anti-tank', hint: 'Extended fight vs high HP/resists', targetArmor: 150, targetMr: 90, targetHp: 3200, threatPhysical: 0.7, weightBurst: 0.6, weightDps: 3.2, weightEhp: 0.8, weightHeal: 0.6 },
  { id: 'survival', label: 'Survival / split', hint: 'Heavier defensive weighting', targetArmor: 100, targetMr: 60, targetHp: 2400, threatPhysical: 0.65, weightBurst: 0.8, weightDps: 2.2, weightEhp: 1.3, weightHeal: 0.9 },
  { id: 'teamfight', label: 'Teamfight', hint: 'Mixed damage, some tankiness', targetArmor: 90, targetMr: 70, targetHp: 2200, threatPhysical: 0.5, weightBurst: 1.2, weightDps: 2.6, weightEhp: 1.0, weightHeal: 0.7 },
]

function pct(value: number, digits = 0) {
  return `${(value * 100).toFixed(digits)}%`
}

function formatNumber(value: number) {
  return value >= 1000 ? Math.round(value).toLocaleString('en-US') : value.toFixed(value < 10 ? 1 : 0)
}

function itemIconUrl(patch: string, item: { image?: string; id: number }) {
  if (!patch || !item.image) return null
  return `https://ddragon.leagueoflegends.com/cdn/${patch}/img/item/${item.image}`
}

function ItemTile({
  item,
  patch,
  badge,
  caption,
}: {
  item: CatalogItem
  patch: string
  badge?: string
  caption?: string
}) {
  const url = itemIconUrl(patch, item)
  return (
    <div className="calc-item" title={`${item.name} — ${item.gold.toLocaleString()} gold`}>
      <div className="calc-item-icon">
        {url
          ? <img src={url} alt={item.name} width={40} height={40} loading="lazy" />
          : <span className="item-icon-placeholder">{item.id}</span>}
        {badge && <span className="calc-item-badge">{badge}</span>}
      </div>
      <span className="calc-item-name">{item.name}</span>
      <span className="calc-item-meta">
        {caption ?? `${item.gold.toLocaleString()}g`}
      </span>
    </div>
  )
}

function RangeControl({
  label, value, min, max, step, onChange, format,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  format?: (value: number) => string
}) {
  return (
    <label className="calc-control">
      <span className="calc-control-label">
        <span>{label}</span>
        <strong>{format ? format(value) : value}</strong>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  )
}

function SelectControl({
  label, value, options, onChange,
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
}) {
  return (
    <label className="calc-control">
      <span className="calc-control-label"><span>{label}</span></span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  )
}

function MetricCell({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="calc-metric" title={title}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Build result card
 * ------------------------------------------------------------------ */

function BuildCard({
  result,
  rank,
  bestScore,
  patch,
  itemCatalog,
  evidence,
  lockedIds,
}: {
  result: BuildResult
  rank: number
  bestScore: number
  patch: string
  itemCatalog: Map<number, CatalogItem>
  evidence: Map<number, EvidenceEntry> | null
  lockedIds: number[]
}) {
  const metrics = result.metrics
  const scoreShare = bestScore > 0 ? Math.round(result.score / bestScore * 100) : 0
  const tilt = metrics.evidenceTilt > 1.001 ? `evidence ×${metrics.evidenceTilt.toFixed(2)}` : undefined

  return (
    <article className="calc-build">
      <header className="calc-build-head">
        <div className="calc-build-rank">
          <span className="calc-rank-number">#{rank + 1}</span>
          <div>
            <strong>score {formatNumber(result.score)}</strong>
            <span className="calc-build-sub">{result.cost.toLocaleString()} gold · {tilt ?? 'pure model'}</span>
          </div>
        </div>
        <div className="calc-score-bar" aria-hidden="true">
          <span style={{ width: `${scoreShare}%` }} />
        </div>
      </header>

      <div className="calc-items">
        {result.items.map((item, index) => {
          const entry = evidence?.get(item.id)
          const share = result.marginal[index] !== undefined && result.score > 0
            ? `+${Math.round(result.marginal[index] / result.score * 100)}%`
            : undefined
          const evidenceBadge = entry ? `${entry.games}×` : undefined
          const locked = lockedIds.includes(item.id)
          return (
            <ItemTile
              key={`${item.id}-${index}`}
              item={itemCatalog.get(item.id) ?? item}
              patch={patch}
              badge={share ?? evidenceBadge}
              caption={locked ? 'locked' : `${item.gold.toLocaleString()}g${entry ? ` · OTP ${Math.round(entry.winRate * 100)}%` : ''}`}
            />
          )
        })}
      </div>

      <div className="calc-metrics">
        <MetricCell label="Burst rotation" value={formatNumber(metrics.burst)} title="2×Q + W + E + R + 4 empowered autos vs the configured target" />
        <MetricCell label="Sustained DPS" value={formatNumber(metrics.dps)} title="Damage per second over the configured fight window" />
        <MetricCell label="Effective HP" value={formatNumber(metrics.ehp)} title="HP × resistances vs the threat mix, W reduction uptime and Sterak's shield included" />
        <MetricCell label="Heal / s" value={formatNumber(metrics.healPerSecond)} title="Q heals + lifesteal, Visage-amplified" />
        <MetricCell label="AD" value={formatNumber(metrics.ad)} />
        <MetricCell label="AS" value={metrics.attackSpeed.toFixed(2)} />
        <MetricCell label="AH" value={String(metrics.abilityHaste)} />
        <MetricCell label="Phys share" value={pct(metrics.physicalDamageShare)} title="Share of the modelled damage that is physical" />
      </div>
    </article>
  )
}

/* ------------------------------------------------------------------ *
 * Main view
 * ------------------------------------------------------------------ */

export default function BuildCalculator({
  itemCatalog,
  patch,
}: {
  itemCatalog: Map<number, CatalogItem>
  patch: string
}) {
  const [kit, setKit] = useState<KitData | null>(null)
  const [kitError, setKitError] = useState('')
  const [evidenceState, setEvidenceState] = useState<{
    lane: 'TOP' | 'MID'
    map: Map<number, EvidenceEntry>
    meta: { games: number; patch: string; patchExact: boolean }
    sets: Array<{ items: number[]; games: number }>
  } | null>(null)
  const [evidenceLane, setEvidenceLane] = useState<'TOP' | 'MID'>('TOP')

  const [preset, setPreset] = useState<PresetId>('balanced')
  const [level, setLevel] = useState(13)
  const [rankOrder, setRankOrder] = useState<BuildContext['rankOrder']>('QE')
  const [targetArmor, setTargetArmor] = useState(70)
  const [targetMr, setTargetMr] = useState(45)
  const [targetHp, setTargetHp] = useState(1800)
  const [threatPhysical, setThreatPhysical] = useState(0.6)
  const [fightSeconds, setFightSeconds] = useState(10)
  const [budget, setBudget] = useState(16500)
  const [includeBoots, setIncludeBoots] = useState(true)
  const [finishedOnly, setFinishedOnly] = useState(true)
  const [evidenceWeight, setEvidenceWeight] = useState(0.4)
  const [topN, setTopN] = useState(3)
  const [lockedId, setLockedId] = useState(0)
  const [bannedId, setBannedId] = useState(0)

  useEffect(() => {
    void apiGet<KitResponse>('/api/calculator/kit')
      .then(setKit)
      .catch((reason: unknown) => setKitError(reason instanceof Error ? reason.message : 'Could not load the kit.'))
  }, [])

  useEffect(() => {
    void apiGet<EvidenceResponse>(`/api/riot/build?lane=${evidenceLane}&source=lane`)
      .then((response) => {
        setEvidenceState({
          lane: evidenceLane,
          map: new Map(response.profile.fullItems.map((item) => [item.id, { games: item.games, winRate: item.winRate }])),
          meta: { games: response.games, patch: response.patch, patchExact: response.patchExact },
          sets: (response.itemSets ?? []).slice(0, 3).map((entry) => ({ items: entry.items, games: entry.games })),
        })
      })
      .catch(() => {
        // No cached scan or no API key: the calculator still works, purely on
        // the mathematical model, without the observational tilt.
      })
  }, [evidenceLane])

  // A lane switch keeps showing the old lane's data until the new lane's
  // response arrives; the stale entry is simply not consulted in the meantime.
  const evidence = evidenceState?.lane === evidenceLane ? evidenceState.map : null
  const evidenceMeta = evidenceState?.lane === evidenceLane ? evidenceState.meta : null
  const observedSets = evidenceState?.lane === evidenceLane ? evidenceState.sets : []

  const catalogItems = useMemo<CalcItem[]>(
    () => [...itemCatalog.values()].map((item) => ({
      id: item.id,
      name: item.name,
      gold: item.gold,
      stats: item.stats,
      tags: item.tags ?? [],
      purchasable: item.purchasable ?? true,
    })),
    [itemCatalog],
  )

  const activePreset = PRESETS.find((entry) => entry.id === preset) ?? PRESETS[0]

  function applyPreset(next: PresetId) {
    const entry = PRESETS.find((candidate) => candidate.id === next)
    if (!entry) return
    setPreset(next)
    setTargetArmor(entry.targetArmor)
    setTargetMr(entry.targetMr)
    setTargetHp(entry.targetHp)
    setThreatPhysical(entry.threatPhysical)
  }

  const context = useMemo<BuildContext | null>(() => {
    if (!kit || !kit.damageData) return null
    const weights = activePreset
    return {
      level,
      rankOrder,
      targetArmor,
      targetMr,
      targetHp,
      threatPhysical,
      fightSeconds,
      autoUptime: 0.75,
      wCharge: 1,
      passiveStacks: kit.passive.maxStacks || 4,
      includeBoots,
      budget,
      finishedOnly,
      weightBurst: weights.weightBurst,
      weightDps: weights.weightDps,
      weightEhp: weights.weightEhp,
      weightHeal: weights.weightHeal,
      evidenceWeight,
      lockedItems: lockedId > 0 ? [lockedId] : [],
      bannedItems: bannedId > 0 ? [bannedId] : [],
      topN,
    }
  }, [kit, activePreset, level, rankOrder, targetArmor, targetMr, targetHp, threatPhysical, fightSeconds, includeBoots, budget, finishedOnly, evidenceWeight, lockedId, bannedId, topN])

  const results = useMemo<BuildResult[]>(() => {
    if (!kit || !context) return []
    return optimizeBuilds(kit, context, catalogItems, evidence)
  }, [kit, context, catalogItems, evidence])

  const ranks = useMemo(() => ranksFor(level, rankOrder), [level, rankOrder])
  const kitSpells = useMemo(() => new Map(kit?.spells.map((spell) => [spell.slot, spell]) ?? []), [kit])
  const bestScore = results[0]?.score ?? 0

  const sortedItems = useMemo(
    () => [...itemCatalog.values()].filter((item) => item.purchasable !== false && item.gold > 0).sort((a, b) => a.name.localeCompare(b.name)),
    [itemCatalog],
  )

  return (
    <div className="view">
      <section className="build-hero">
        <img
          className="champion-portrait"
          src={`https://ddragon.leagueoflegends.com/cdn/${patch || '16.19.1'}/img/champion/Irelia.png`}
          alt="Irelia"
          width="84"
          height="84"
          onError={(event) => { (event.currentTarget as HTMLImageElement).style.visibility = 'hidden' }}
        />
        <div className="build-hero-copy">
          <p className="eyebrow">
            Patch {kit?.version ?? patch ?? '…'} · kit {kit?.damageData ? 'loaded' : 'degraded'} · items from current patch
          </p>
          <h1>Irelia Build Calculator</h1>
          <p>
            Computes optimal 6-item builds from Irelia&apos;s kit math, then blends in{' '}
            {evidenceMeta ? `${evidenceMeta.games} cached OTP games${evidenceMeta.patchExact ? ` on patch ${evidenceMeta.patch}` : ''}` : 'no cached OTP evidence yet'}
            .
          </p>
        </div>
      </section>

      {kitError && <div className="error-strip" role="alert">Kit endpoint failed: {kitError}</div>}
      {kit && !kit.damageData && (
        <div className="error-strip" role="alert">
          Damage numbers for patch {kit.version} could not be parsed from the community game data, so build optimisation is disabled.
          Base stats and cooldowns are still current. This usually fixes itself on the next patch refresh.
        </div>
      )}

      <section className="panel calc-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Scenario</p>
            <h2>Fight assumptions</h2>
          </div>
        </div>
        <div className="calc-presets" role="tablist" aria-label="Scenario presets">
          {PRESETS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={preset === entry.id}
              className={`calc-preset ${preset === entry.id ? 'selected' : ''}`}
              title={entry.hint}
              onClick={() => applyPreset(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="calc-controls">
          <RangeControl label="Level" value={level} min={1} max={18} step={1} onChange={setLevel} />
          <SelectControl
            label="Skill max"
            value={rankOrder}
            options={[
              { value: 'QE', label: `Q → E → W (ranks Q${ranks.Q}/W${ranks.W}/E${ranks.E}/R${ranks.R})` },
              { value: 'QW', label: `Q → W → E (ranks Q${ranks.Q}/W${ranks.W}/E${ranks.E}/R${ranks.R})` },
              { value: 'EQ', label: `E → Q → W (ranks Q${ranks.Q}/W${ranks.W}/E${ranks.E}/R${ranks.R})` },
            ]}
            onChange={(value) => setRankOrder(value as BuildContext['rankOrder'])}
          />
          <RangeControl label="Target armor" value={targetArmor} min={20} max={250} step={5} onChange={setTargetArmor} />
          <RangeControl label="Target MR" value={targetMr} min={20} max={200} step={5} onChange={setTargetMr} />
          <RangeControl label="Target HP" value={targetHp} min={800} max={4500} step={100} onChange={setTargetHp} format={(value) => value.toLocaleString()} />
          <RangeControl label="Incoming physical" value={threatPhysical} min={0} max={1} step={0.05} onChange={setThreatPhysical} format={pct} />
          <SelectControl
            label="Fight length"
            value={String(fightSeconds)}
            options={[{ value: '5', label: '5 s burst' }, { value: '10', label: '10 s skirmish' }, { value: '20', label: '20 s extended' }]}
            onChange={(value) => setFightSeconds(Number(value))}
          />
          <RangeControl label="Gold budget" value={budget} min={6000} max={20000} step={500} onChange={setBudget} format={(value) => value.toLocaleString()} />
          <RangeControl label="OTP evidence weight" value={evidenceWeight} min={0} max={1} step={0.05} onChange={setEvidenceWeight} format={pct} />
          <SelectControl
            label="Top builds"
            value={String(topN)}
            options={[1, 2, 3, 4, 5].map((count) => ({ value: String(count), label: String(count) }))}
            onChange={(value) => setTopN(Number(value))}
          />
          <SelectControl
            label="Evidence lane"
            value={evidenceLane}
            options={[{ value: 'TOP', label: 'TOP evidence' }, { value: 'MID', label: 'MID evidence' }]}
            onChange={(value) => setEvidenceLane(value as 'TOP' | 'MID')}
          />
        </div>
        <div className="calc-options">
          <label className="calc-toggle">
            <input type="checkbox" checked={includeBoots} onChange={(event) => setIncludeBoots(event.target.checked)} />
            <span>Include boots slot</span>
          </label>
          <label className="calc-toggle">
            <input type="checkbox" checked={finishedOnly} onChange={(event) => setFinishedOnly(event.target.checked)} />
            <span>Finished items only</span>
          </label>
          <SelectControl
            label="Lock first item"
            value={String(lockedId)}
            options={[{ value: '0', label: '— none —' }, ...sortedItems.map((item) => ({ value: String(item.id), label: `${item.name} (${item.gold.toLocaleString()}g)` }))]}
            onChange={(value) => setLockedId(Number(value))}
          />
          <SelectControl
            label="Ban item"
            value={String(bannedId)}
            options={[{ value: '0', label: '— none —' }, ...sortedItems.map((item) => ({ value: String(item.id), label: `${item.name} (${item.gold.toLocaleString()}g)` }))]}
            onChange={(value) => setBannedId(Number(value))}
          />
        </div>
      </section>

      {kit && context && (
        <section className="panel calc-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Kit math, level {level}</p>
              <h2>Ability model used</h2>
            </div>
          </div>
          <div className="calc-kit">
            {(['Q', 'W', 'E', 'R'] as const).map((slot) => {
              const spell = kitSpells.get(slot)
              if (!spell) return null
              const rank = ranks[slot] || 0
              const base = spell.baseDamage?.[rank - 1] ?? 0
              const damage = `${Math.round(base)}${spell.adRatio ? ` + ${Math.round(spell.adRatio * 100)}% AD` : ''}${spell.apRatio ? ` + ${Math.round(spell.apRatio * 100)}% AP` : ''}${spell.chargeMultiplier > 1 ? ` ×${spell.chargeMultiplier.toFixed(1)} full charge` : ''}`
              return (
                <div className="calc-kit-spell" key={slot}>
                  <strong>{slot} · {spell.name}</strong>
                  <span>{damage}</span>
                  <small>{spell.cooldown?.[rank - 1] ?? '—'}s cd{spell.range ? ` · ${spell.range} range` : ''}</small>
                </div>
              )
            })}
          </div>
          <p className="microcopy">
            Passive {kit.passive.name}: up to {kit.passive.maxStacks} stacks · {Math.round(kit.passive.attackSpeedPerStack.level18 * kit.passive.maxStacks)}% bonus AS at 18 · empowered on-hit{' '}
            {Math.round(kit.passive.onHitDamage.level18)} + {Math.round(kit.passive.onHitBonusAdRatio * 100)}% bonus AD magic.
          </p>
        </section>
      )}

      {results.length > 0 ? (
        <div className="calc-results">
          {results.map((result, index) => (
            <BuildCard
              key={result.items.map((item) => item.id).join('-')}
              result={result}
              rank={index}
              bestScore={bestScore}
              patch={patch}
              itemCatalog={itemCatalog}
              evidence={evidence}
              lockedIds={lockedId > 0 ? [lockedId] : []}
            />
          ))}
        </div>
      ) : (
        kit && context && (
          <section className="panel">
            <p className="empty-state">
              No build fits these constraints — raise the gold budget, unlock items, or disable &ldquo;finished items only&rdquo;.
            </p>
          </section>
        )
      )}

      {observedSets.length > 0 && (
        <section className="panel calc-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Cached OTP games · {evidenceLane}</p>
              <h2>What the data says players build</h2>
            </div>
          </div>
          <div className="calc-observed">
            {observedSets.map((entry) => (
              <div className="calc-observed-row" key={entry.items.join('-')}>
                <div className="calc-items">
                  {entry.items.map((id) => (
                    <ItemTile
                      key={id}
                      item={itemCatalog.get(id) ?? { id, name: `Item ${id}`, gold: 0, stats: {} }}
                      patch={patch}
                    />
                  ))}
                </div>
                <span className="calc-observed-meta">{entry.games} games</span>
              </div>
            ))}
          </div>
          <p className="microcopy">
            Observational frequency, not optimality — this is the baseline the evidence slider blends into the math.
          </p>
        </section>
      )}

      <section className="panel">
        <p className="disclaimer">
          <strong>Methodology.</strong> Damage uses the live kit formulas (base + AD/AP ratios) against a target with the armour/MR/HP you set;
          burst is 2×Q + charged W + E + R + 4 empowered autos, sustained DPS covers the fight window with cooldown-limited casts and a 75% auto-attack uptime.
          EHP mixes armour and MR by the threat share, adds W&apos;s damage-reduction uptime and a modelled Sterak&apos;s shield. Named passives (BotRK 8% current-HP on-hit
          at 50% average HP, Wit&apos;s End, Guinsoo&apos;s, Trinity/Lich spellblade, Nashor&apos;s, Cleaver shred, Visage, IE) are approximations updated by hand.
          Items and kit re-fetch from the newest patch on every server start; cached OTP evidence comes from the local scan cache.
          This is a model, not a guarantee — game context, piloting and matchups still decide the real outcome.
        </p>
      </section>
    </div>
  )
}
