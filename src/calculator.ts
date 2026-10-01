/**
 * Build Calculator math engine.
 *
 * Turns Irelia's patch-fresh kit (server /api/calculator/kit) and the Data
 * Dragon item catalog into an explicit damage/survivability model, then
 * searches the item space for the best 6-item builds under the user's
 * constraints. Observational evidence from the cached scans (item pick rates
 * of verified Irelia OTPs) blends into the ranking as a multiplicative tilt.
 *
 * Everything here is a *model*. Passive effects are approximated and documented
 * in PASSIVE_EFFECTS; no claim is made that the ranked builds equal real game
 * outcomes. The UI labels every figure accordingly.
 */

/* ------------------------------------------------------------------ *
 * Types (server payload mirrors)
 * ------------------------------------------------------------------ */

export type KitAbility = {
  slot: 'Q' | 'W' | 'E' | 'R'
  name: string
  description: string
  baseDamage: number[]
  adRatio: number
  apRatio: number
  chargeMultiplier: number
  cooldown: number[]
  cost: number[]
  range: number | null
  maxRank: number
  damageType: 'physical' | 'magic'
}

export type KitData = {
  version: string
  fetchedAt: number
  damageData: boolean
  baseStats: Record<string, number>
  growthStats: Record<string, number>
  attackSpeedBase: number
  attackSpeedPerLevel: number
  attackRange: number
  moveSpeed: number
  passive: {
    name: string
    description: string
    maxStacks: number
    attackSpeedPerStack: { level1: number; level18: number }
    onHitDamage: { level1: number; level18: number }
    onHitBonusAdRatio: number
  }
  defiantDance: {
    physicalReduction: { level1: number; level18: number }
    per100Ap: number
    magicMultiplier: number
  } | null
  healRatio: number[]
  spells: KitAbility[]
}

/** One purchasable item with the stats the engine reads. */
export type CalcItem = {
  id: number
  name: string
  gold: number
  stats: Record<string, number>
  tags: string[]
  purchasable: boolean
}

export type EvidenceEntry = { games: number; winRate: number }

/** Everything the optimizer needs for one run. */
export type BuildContext = {
  level: number
  /** Skill-rank preset: primary max order. */
  rankOrder: 'QE' | 'QW' | 'EQ'
  /** Target dummy: armor, MR and HP the damage is computed against. */
  targetArmor: number
  targetMr: number
  targetHp: number
  /** Share (0..1) of incoming damage that is physical. */
  threatPhysical: number
  /** How long the modelled fight lasts (sustained window). */
  fightSeconds: number
  /** Share of the fight spent auto-attacking (0..1). */
  autoUptime: number
  /** W channel completion (0..1); 1 = fully charged. */
  wCharge: number
  /** Passive stacks assumed during the fight. */
  passiveStacks: number
  includeBoots: boolean
  /** Hard gold cap for the finished build. */
  budget: number
  /** Only finished items (gold >= 2000 or a modelled named passive). */
  finishedOnly: boolean
  /** Objective weights. */
  weightBurst: number
  weightDps: number
  weightEhp: number
  weightHeal: number
  /** 0..1 — how strongly cached OTP pick rates tilt the ranking. */
  evidenceWeight: number
  lockedItems: number[]
  bannedItems: number[]
  /** How many builds to return. */
  topN: number
}

export type BuildMetrics = {
  burst: number
  dps: number
  ehp: number
  healPerSecond: number
  ad: number
  bonusAd: number
  ap: number
  hp: number
  armor: number
  mr: number
  attackSpeed: number
  abilityHaste: number
  tenacity: number
  moveSpeed: number
  physicalDamageShare: number
  evidenceTilt: number
}

export type BuildResult = {
  items: CalcItem[]
  cost: number
  score: number
  metrics: BuildMetrics
  /** score minus the score of the build with that item removed. */
  marginal: number[]
}

/* ------------------------------------------------------------------ *
 * Champion model
 * ------------------------------------------------------------------ */

const MAX_ATTACK_SPEED = 2.5
const CRIT_DAMAGE = 1.75
const IE_CRIT_BONUS = 0.4

/** Standard LoL growth curve: base + growth × (n)(0.7025 + 0.0175n). */
function statAtLevel(base: number, growth: number, level: number) {
  const n = level - 1
  return base + growth * n * (0.7025 + 0.0175 * n)
}

function lerp(level: number, level1: number, level18: number) {
  return level1 + (level18 - level1) * Math.min(Math.max((level - 1) / 17, 0), 1)
}

/** Skill ranks for a level following a max-order preset (R at 6/11/16). */
export function ranksFor(level: number, order: BuildContext['rankOrder']): Record<'Q' | 'W' | 'E' | 'R', number> {
  const ranks = { Q: 0, W: 0, E: 0, R: 0 }
  const priority = order === 'QW' ? [1, 2, 3] : order === 'EQ' ? [3, 1, 2] : [1, 3, 2]
  const rankOf = (slot: number) => (slot === 1 ? ranks.Q : slot === 2 ? ranks.W : ranks.E)
  const bump = (slot: number) => {
    if (slot === 1) ranks.Q += 1
    else if (slot === 2) ranks.W += 1
    else ranks.E += 1
  }
  for (let levelNow = 1; levelNow <= Math.min(Math.max(level, 1), 18); levelNow += 1) {
    if (levelNow === 6 || levelNow === 11 || levelNow === 16) {
      ranks.R += 1
      continue
    }
    const slot = priority.find((candidate) => rankOf(candidate) < 5) ?? 1
    bump(slot)
  }
  return ranks
}

/* ------------------------------------------------------------------ *
 * Modelled named passives (approximated, per patch)
 * ------------------------------------------------------------------ */

/**
 * Curated approximations of the item passives the engine understands. These
 * are the parts of the damage model that cannot be derived from item stats
 * alone and are updated by hand when Riot reworks them:
 *  - 3153 Blade of the Ruined King: on-hit 8% of target's CURRENT health
 *    (melee), modelled at 50% average current HP, physical.
 *  - 3091 Wit's End: 15-80 (by level) magic on-hit.
 *  - 3124 Guinsoo's Rageblade: every 3rd hit repeats on-hits (+33% on-hit).
 *  - 3078 Trinity Force: Spellblade 200% base AD on next attack after a cast.
 *  - 3100 Lich Bane: Spellblade 75% base AD + 50% AP magic after a cast.
 *  - 3115 Nashor's Tooth: 15 + 20% AP magic on-hit.
 *  - 3071 Black Cleaver: armor shred modelled as -24% effective target armor
 *    (the ramp-weighted average of its 6-stack 30% shred).
 *  - 3053 Sterak's Gage: Lifeline shield ~80% bonus health once per fight,
 *    added to EHP.
 *  - 3065 Spirit Visage: +25% healing and shielding, applied to the heal term.
 *  - 3031 Infinity Edge: crits deal +40% bonus crit damage.
 */
export const PASSIVE_EFFECTS: Record<number, string> = {
  3153: 'BotRK on-hit (8% current HP, modelled at 50%)',
  3091: "Wit's End on-hit (15-80 by level)",
  3124: "Guinsoo's: on-hits +33%",
  3078: 'Trinity: Spellblade 200% base AD',
  3100: 'Lich Bane: Spellblade 75% base AD + 50% AP',
  3115: "Nashor's: on-hit 15 + 20% AP",
  3071: 'Cleaver: -24% effective enemy armor (ramped)',
  3053: "Sterak's: shield 80% bonus HP (EHP)",
  3065: 'Visage: +25% healing',
  3031: 'IE: +40% crit damage',
}

const BOOTS_ITEM_TAGS = ['Boots']
const EXCLUDED_ITEM_TAGS = new Set(['Trinket', 'Consumable', 'Vision', 'Jungle', 'Lane', 'GoldPer'])
const FINISHED_ITEM_GOLD = 2000
const TIER2_BOOTS_MIN_GOLD = 600
const LOCKED_ITEM_CAP = 5

/* ------------------------------------------------------------------ *
 * Item pool
 * ------------------------------------------------------------------ */

export function splitItemPool(catalog: CalcItem[], locked: number[], banned: number[]) {
  const boots: CalcItem[] = []
  const legendaries: CalcItem[] = []
  for (const item of catalog) {
    if (!item.purchasable || item.gold <= 0) continue
    if (banned.includes(item.id) || locked.includes(item.id)) continue
    if (item.tags.some((tag) => BOOTS_ITEM_TAGS.includes(tag))) {
      if (item.gold >= TIER2_BOOTS_MIN_GOLD) boots.push(item)
      continue
    }
    if (item.tags.some((tag) => EXCLUDED_ITEM_TAGS.has(tag))) continue
    legendaries.push(item)
  }
  return { boots, legendaries }
}

function isFinished(item: CalcItem) {
  return item.gold >= FINISHED_ITEM_GOLD || Object.prototype.hasOwnProperty.call(PASSIVE_EFFECTS, item.id)
}

/* ------------------------------------------------------------------ *
 * Item stat aggregation
 * ------------------------------------------------------------------ */

export type AggregatedStats = {
  ad: number
  ap: number
  hp: number
  armor: number
  mr: number
  attackSpeed: number
  abilityHaste: number
  moveSpeedPct: number
  lifeSteal: number
  crit: number
  flatArmorPen: number
  pctArmorPen: number
  flatMagicPen: number
  pctMagicPen: number
  tenacity: number
  hasIe: boolean
  hasBotrk: boolean
  hasWits: boolean
  hasGuinsoo: boolean
  hasTrinity: boolean
  hasLich: boolean
  hasNashors: boolean
  hasCleaver: boolean
  hasSteraks: boolean
  hasVisage: boolean
}

export function aggregateStats(items: CalcItem[]): AggregatedStats {
  const result: AggregatedStats = {
    ad: 0, ap: 0, hp: 0, armor: 0, mr: 0, attackSpeed: 0, abilityHaste: 0,
    moveSpeedPct: 0, lifeSteal: 0, crit: 0, flatArmorPen: 0, pctArmorPen: 0,
    flatMagicPen: 0, pctMagicPen: 0, tenacity: 0,
    hasIe: false, hasBotrk: false, hasWits: false, hasGuinsoo: false,
    hasTrinity: false, hasLich: false, hasNashors: false, hasCleaver: false,
    hasSteraks: false, hasVisage: false,
  }
  for (const item of items) {
    const s = item.stats
    result.ad += s.FlatPhysicalDamageMod ?? 0
    result.ap += s.FlatMagicDamageMod ?? 0
    result.hp += s.FlatHPPoolMod ?? 0
    result.armor += s.FlatArmorMod ?? 0
    result.mr += s.FlatSpellBlockMod ?? 0
    result.attackSpeed += s.PercentAttackSpeedMod ?? 0
    result.abilityHaste += s.AbilityHaste ?? s.AbilityHasteMod ?? 0
    result.moveSpeedPct += s.PercentMovementSpeedMod ?? 0
    result.lifeSteal += s.PercentLifeStealMod ?? 0
    result.crit += s.PercentCritChanceMod ?? 0
    result.flatArmorPen += s.FlatArmorPenetrationMod ?? 0
    result.pctArmorPen += s.PercentArmorPenetrationMod ?? 0
    result.flatMagicPen += s.FlatMagicPenetrationMod ?? 0
    result.pctMagicPen += s.PercentMagicPenetrationMod ?? 0
    result.tenacity += s.PercentTenacityMod ?? 0
    if (item.id === 3031) result.hasIe = true
    if (item.id === 3153) result.hasBotrk = true
    if (item.id === 3091) result.hasWits = true
    if (item.id === 3124) result.hasGuinsoo = true
    if (item.id === 3078) result.hasTrinity = true
    if (item.id === 3100) result.hasLich = true
    if (item.id === 3115) result.hasNashors = true
    if (item.id === 3071) result.hasCleaver = true
    if (item.id === 3053) result.hasSteraks = true
    if (item.id === 3065) result.hasVisage = true
  }
  return result
}

/* ------------------------------------------------------------------ *
 * Fight evaluation
 * ------------------------------------------------------------------ */

export function evaluateBuild(kit: KitData, ctx: BuildContext, items: CalcItem[]): BuildMetrics {
  const level = Math.min(Math.max(ctx.level, 1), 18)
  const ranks = ranksFor(level, ctx.rankOrder)
  const s = aggregateStats(items)

  const baseAd = statAtLevel(kit.baseStats.attackDamage ?? 65, kit.growthStats.attackDamage ?? 0, level)
  const totalAd = baseAd + s.ad
  const armor = statAtLevel(kit.baseStats.armor ?? 36, kit.growthStats.armor ?? 0, level) + s.armor
  const mr = statAtLevel(kit.baseStats.spellBlock ?? 30, kit.growthStats.spellBlock ?? 0, level) + s.mr
  const hp = statAtLevel(kit.baseStats.hp ?? 630, kit.growthStats.hp ?? 0, level) + s.hp
  const baseMs = kit.moveSpeed || kit.baseStats.moveSpeed || 335
  const moveSpeed = baseMs * (1 + s.moveSpeedPct)

  // Attack speed: base ratio × (1 + growth% + passive stacks + item bonus), capped.
  const passiveAs = kit.passive.maxStacks > 0
    ? Math.min(ctx.passiveStacks, kit.passive.maxStacks)
      * lerp(level, kit.passive.attackSpeedPerStack.level1, kit.passive.attackSpeedPerStack.level18)
    : 0
  const growthAs = (kit.attackSpeedPerLevel / 100) * (level - 1)
  const attackSpeed = Math.min(
    kit.attackSpeedBase * (1 + growthAs + passiveAs / 100 + s.attackSpeed),
    MAX_ATTACK_SPEED,
  )

  const haste = s.abilityHaste
  const spell = (slot: 'Q' | 'W' | 'E' | 'R') => kit.spells.find((entry) => entry.slot === slot)
  const cd = (slot: 'Q' | 'W' | 'E' | 'R') => {
    const entry = spell(slot)
    const rank = Math.min(ranks[slot] || 1, entry?.cooldown.length ?? 1)
    const raw = entry?.cooldown?.[rank - 1] ?? 10
    return raw * 100 / (100 + haste)
  }

  // Penetration and target shred.
  const effArmor = Math.max(armor * (1 - s.pctArmorPen) - s.flatArmorPen, 0)
  const effMr = Math.max(mr * (1 - s.pctMagicPen) - s.flatMagicPen, 0)
  const targetArmorAfterShred = Math.max(ctx.targetArmor * (s.hasCleaver ? 0.76 : 1), 0)
  const physMult = 100 / (100 + targetArmorAfterShred)
  const magicMult = 100 / (100 + ctx.targetMr)

  // Ability damages (one cast each, W at the chosen charge).
  const spellDamage = (slot: 'Q' | 'W' | 'E' | 'R') => {
    const entry = spell(slot)
    if (!entry) return 0
    const rank = Math.min(ranks[slot] || 1, entry.baseDamage.length || 1)
    const base = entry.baseDamage[rank - 1] ?? 0
    let raw = base + totalAd * entry.adRatio + s.ap * entry.apRatio
    if (entry.chargeMultiplier > 1) raw *= 1 + (entry.chargeMultiplier - 1) * Math.min(Math.max(ctx.wCharge, 0), 1)
    return raw * (slot === 'E' || slot === 'R' ? magicMult : physMult)
  }
  const qDamage = spellDamage('Q')
  const wDamage = spellDamage('W')
  const eDamage = spellDamage('E')
  const rDamage = spellDamage('R')

  const fightSeconds = Math.max(ctx.fightSeconds, 2)
  const qCasts = 2 + Math.max(Math.floor((fightSeconds - 1) / cd('Q')), 0)
  const wCasts = 1 + Math.max(Math.floor((fightSeconds - 1) / cd('W')), 0)
  const eCasts = 1 + Math.max(Math.floor((fightSeconds - 1) / cd('E')), 0)
  const abilityPhysical = qDamage * qCasts + wDamage * wCasts
  const abilityMagic = eDamage * eCasts + rDamage

  // On-hit bundle.
  const passiveOnHit = kit.passive.maxStacks > 0 && ctx.passiveStacks >= kit.passive.maxStacks
    ? lerp(level, kit.passive.onHitDamage.level1, kit.passive.onHitDamage.level18) + s.ad * kit.passive.onHitBonusAdRatio
    : 0
  const botrkOnHit = s.hasBotrk ? ctx.targetHp * 0.5 * 0.08 : 0
  const witsOnHit = s.hasWits ? lerp(level, 15, 80) : 0
  const nashorsOnHit = s.hasNashors ? 15 + 0.2 * s.ap : 0
  const guinsooMult = s.hasGuinsoo ? 4 / 3 : 1
  const onHitMagic = (passiveOnHit + witsOnHit + nashorsOnHit) * guinsooMult
  const onHitPhysical = botrkOnHit * guinsooMult

  // Spellblade procs after casts, throttled to 1 per 1.5 s.
  const totalCasts = qCasts + wCasts + eCasts + 1
  const spellbladeProcs = Math.min(totalCasts, Math.floor(fightSeconds / 1.5) + 1)
  const spellbladePhysical = s.hasTrinity ? 2.0 * baseAd * spellbladeProcs * physMult : 0
  const spellbladeMagic = s.hasLich ? (0.75 * baseAd + 0.5 * s.ap) * spellbladeProcs * magicMult : 0

  // Auto attacks (Q also applies on-hit effects).
  const critMultiplier = CRIT_DAMAGE + (s.hasIe ? IE_CRIT_BONUS : 0)
  const critFactor = 1 + Math.min(Math.max(s.crit, 0), 1) * (critMultiplier - 1)
  const autoPhysical = totalAd * critFactor * physMult + onHitPhysical
  const autoMagic = onHitMagic * magicMult
  const autos = attackSpeed * fightSeconds * Math.min(Math.max(ctx.autoUptime, 0), 1)
  const autoDamage = autos * (autoPhysical + autoMagic)
  const qOnHitDamage = qCasts * (onHitPhysical + onHitMagic * magicMult)

  // Burst rotation: 2 Q + charged W + E + R + 4 autos + up to 2 spellblade procs.
  const burst = qDamage * 2 + wDamage + eDamage + rDamage
    + 4 * (autoPhysical + autoMagic)
    + 2 * (onHitPhysical + onHitMagic * magicMult)
    + (spellbladePhysical + spellbladeMagic) * Math.min(2, spellbladeProcs) / Math.max(spellbladeProcs, 1)

  const totalDamage = abilityPhysical + abilityMagic + autoDamage + qOnHitDamage + spellbladePhysical + spellbladeMagic
  const dps = totalDamage / fightSeconds
  const autoMagicShare = autoPhysical + autoMagic > 0 ? autoMagic / (autoPhysical + autoMagic) : 0
  const qOnHitMagicShare = onHitPhysical + onHitMagic * magicMult > 0 ? onHitMagic * magicMult / (onHitPhysical + onHitMagic * magicMult) : 0
  const magicTotal = abilityMagic + autoDamage * autoMagicShare + qOnHitDamage * qOnHitMagicShare + spellbladeMagic
  const physicalDamageShare = totalDamage > 0 ? Math.min(Math.max(1 - magicTotal / totalDamage, 0), 1) : 0

  // Healing: Q heals + lifesteal on auto physical damage, Visage-amplified.
  const healRatio = kit.healRatio?.[Math.min(ranks.Q || 1, 5) - 1] ?? 0.12
  const qHeal = totalAd * healRatio * qCasts
  const lifeStealHeal = autos * autoPhysical * s.lifeSteal
  const healPerSecond = (qHeal + lifeStealHeal) * (s.hasVisage ? 1.25 : 1) / fightSeconds

  // Effective health vs the threat mix, W damage reduction uptime, Sterak's shield.
  const wDr = kit.defiantDance
    ? lerp(level, kit.defiantDance.physicalReduction.level1, kit.defiantDance.physicalReduction.level18)
      + kit.defiantDance.per100Ap * s.ap / 100
    : 0
  const wUptime = Math.min((0.75 + 0.5) * wCasts / fightSeconds, 1)
  const drFactor = 1 + Math.min(Math.max(wDr, 0), 0.95) * wUptime
  const steraksShield = s.hasSteraks ? 0.8 * s.hp : 0
  const threatPhys = Math.min(Math.max(ctx.threatPhysical, 0), 1)
  const ehp = (hp + steraksShield)
    * (100 + threatPhys * effArmor + (1 - threatPhys) * effMr) / 100
    * drFactor

  return {
    burst,
    dps,
    ehp,
    healPerSecond,
    ad: totalAd,
    bonusAd: s.ad,
    ap: s.ap,
    hp,
    armor,
    mr,
    attackSpeed,
    abilityHaste: haste,
    tenacity: s.tenacity,
    moveSpeed,
    physicalDamageShare,
    evidenceTilt: 1,
  }
}

/* ------------------------------------------------------------------ *
 * Scoring and evidence blend
 * ------------------------------------------------------------------ */

/**
 * Log-relative scoring: each objective contributes w × ln(metric / baseline),
 * where the baseline is the naked (no-item) champion at the same level and
 * ranks. Growth over the baseline is what an item slot actually buys, and the
 * log keeps the components comparable: doubling any metric is worth the same
 * score whether it is burst damage or effective health, and stacking more
 * tank stats hits diminishing returns instead of numerically overwhelming the
 * damage terms (raw EHP is in the tens of thousands, burst in the hundreds).
 */
function rawScore(ctx: BuildContext, metrics: BuildMetrics, base: BuildMetrics) {
  const growth = (value: number, baseline: number) => Math.log(Math.max(value, 1) / Math.max(baseline, 1))
  return growth(metrics.burst, base.burst) * ctx.weightBurst
    + growth(metrics.dps, base.dps) * ctx.weightDps
    + growth(metrics.ehp, base.ehp) * ctx.weightEhp
    + growth(metrics.healPerSecond + 1, base.healPerSecond + 1) * ctx.weightHeal
}

/** Normalised 0..1 pick-rate evidence for one item, null when unknown. */
function evidence01(id: number, evidence: Map<number, EvidenceEntry> | null, maxGames: number) {
  const entry = evidence?.get(id)
  if (!entry || maxGames <= 0) return null
  return Math.min(entry.games / maxGames, 1)
}

/**
 * Multiplicative tilt from the cached OTP build evidence: a build full of
 * items the verified one-tricks actually buy gains up to +60% at full weight,
 * a build of never-bought items is left untouched. Unknown items are ignored.
 */
function evidenceTilt(items: CalcItem[], ctx: BuildContext, evidence: Map<number, EvidenceEntry> | null, maxGames: number) {
  if (!evidence || ctx.evidenceWeight <= 0) return 1
  const known = items.map((item) => evidence01(item.id, evidence, maxGames)).filter((value): value is number => value !== null)
  if (!known.length) return 1
  const mean = known.reduce((sum, value) => sum + value, 0) / known.length
  return 1 + ctx.evidenceWeight * mean * 0.6
}

/* ------------------------------------------------------------------ *
 * Optimisation (beam search + local swap refinement)
 * ------------------------------------------------------------------ */

const BEAM_WIDTH = 24
const REFINE_CANDIDATES = 8
const REFINE_PASSES = 4

type PartialBuild = { items: CalcItem[]; cost: number; score: number; metrics: BuildMetrics }

function evaluateWithTilt(
  kit: KitData,
  ctx: BuildContext,
  items: CalcItem[],
  base: BuildMetrics,
  evidence: Map<number, EvidenceEntry> | null,
  maxGames: number,
): { score: number; metrics: BuildMetrics } {
  const metrics = evaluateBuild(kit, ctx, items)
  const tilt = evidenceTilt(items, ctx, evidence, maxGames)
  metrics.evidenceTilt = tilt
  return { score: rawScore(ctx, metrics, base) * tilt, metrics }
}

function byScoreDesc(first: PartialBuild, second: PartialBuild) {
  if (second.score !== first.score) return second.score - first.score
  return first.cost - second.cost
}

/**
 * Finds the best builds for the given context.
 *
 * The search treats the boots slot (when enabled) and the five item slots as
 * one beam of width BEAM_WIDTH: at each slot every legal candidate is appended
 * and the best partials survive. A final local-swap pass polishes the winners,
 * so synergies like "BotRK + attack speed" are captured at full-build
 * evaluation time instead of being priced one item at a time.
 */
export function optimizeBuilds(
  kit: KitData,
  ctx: BuildContext,
  catalog: CalcItem[],
  evidence: Map<number, EvidenceEntry> | null = null,
): BuildResult[] {
  const lockedIds = ctx.lockedItems.slice(0, LOCKED_ITEM_CAP)
  const locked = catalog.filter((item) => lockedIds.includes(item.id))
  const { boots, legendaries } = splitItemPool(catalog, lockedIds, ctx.bannedItems)
  const pool = ctx.finishedOnly ? legendaries.filter(isFinished) : legendaries
  if (!pool.length) return []
  const maxGames = evidence
    ? Math.max(...[...evidence.values()].map((entry) => entry.games), 1)
    : 1
  const legendarySlots = Math.max(5 - locked.length, 0)
  const minItemGold = Math.min(
    ...pool.map((item) => item.gold),
    ...(ctx.includeBoots ? boots.map((item) => item.gold) : []),
  )

  // Baseline: the naked champion at the same level/ranks. All scores are
  // log-growth over this baseline (see rawScore).
  const base = evaluateBuild(kit, ctx, [])

  // With the boots slot enabled every build must pick boots; otherwise the
  // slot is left empty and all six positions hold legendary items.
  const startCandidates = ctx.includeBoots ? [...boots] : [null]
  const beam: PartialBuild[] = startCandidates
    .map((boot) => {
      const items = boot ? [...locked, boot] : [...locked]
      const cost = items.reduce((sum, item) => sum + item.gold, 0)
      const evaluated = evaluateWithTilt(kit, ctx, items, base, evidence, maxGames)
      return { items, cost, score: evaluated.score, metrics: evaluated.metrics }
    })
    .filter((entry) => entry.cost <= ctx.budget)
    .sort(byScoreDesc)
    .slice(0, BEAM_WIDTH)
  let survivors = beam

  for (let slot = 0; slot < legendarySlots; slot += 1) {
    const next: PartialBuild[] = []
    const seen = new Set<string>()
    const key = (items: CalcItem[]) => [...items].sort((a, b) => a.id - b.id).map((item) => item.id).join(',')
    for (const partial of survivors) {
      for (const candidate of pool) {
        if (partial.items.some((item) => item.id === candidate.id)) continue
        const cost = partial.cost + candidate.gold
        if (cost > ctx.budget) continue
        const remainingSlots = legendarySlots - slot - 1
        if (remainingSlots > 0 && cost + remainingSlots * minItemGold > ctx.budget) continue
        const items = [...partial.items, candidate]
        const entryKey = key(items)
        if (seen.has(entryKey)) continue
        seen.add(entryKey)
        const evaluated = evaluateWithTilt(kit, ctx, items, base, evidence, maxGames)
        next.push({ items, cost, score: evaluated.score, metrics: evaluated.metrics })
      }
    }
    if (!next.length) break
    survivors = next.sort(byScoreDesc).slice(0, BEAM_WIDTH)
  }

  // Local refinement: swap any slot if it improves the score, until stable.
  const refined: BuildResult[] = survivors.slice(0, REFINE_CANDIDATES).map((partial) => {
    let current = [...partial.items]
    let evaluated = evaluateWithTilt(kit, ctx, current, base, evidence, maxGames)
    for (let pass = 0; pass < REFINE_PASSES; pass += 1) {
      let improved = false
      for (let index = 0; index < current.length; index += 1) {
        const currentItem = current[index]
        if (lockedIds.includes(currentItem.id)) continue
        const candidates = currentItem.tags.some((tag) => BOOTS_ITEM_TAGS.includes(tag)) ? boots : pool
        for (const candidate of candidates) {
          if (candidate.id === currentItem.id) continue
          if (current.some((item, other) => other !== index && item.id === candidate.id)) continue
          const swapped = [...current]
          swapped[index] = candidate
          const cost = swapped.reduce((sum, item) => sum + item.gold, 0)
          if (cost > ctx.budget) continue
          const candidateEval = evaluateWithTilt(kit, ctx, swapped, base, evidence, maxGames)
          if (candidateEval.score > evaluated.score + 1e-9) {
            current = swapped
            evaluated = candidateEval
            improved = true
          }
        }
      }
      if (!improved) break
    }

    const marginal = current.map((item) => {
      const without = current.filter((entry) => entry.id !== item.id)
      return Math.max(evaluated.score - evaluateWithTilt(kit, ctx, without, base, evidence, maxGames).score, 0)
    })

    return {
      items: current,
      cost: current.reduce((sum, item) => sum + item.gold, 0),
      score: evaluated.score,
      metrics: evaluated.metrics,
      marginal,
    }
  })

  refined.sort((a, b) => b.score - a.score || a.cost - b.cost)

  // Deduplicate identical item sets that converged from different beams.
  const seenSets = new Set<string>()
  const unique: BuildResult[] = []
  for (const result of refined) {
    const key = result.items.map((item) => item.id).sort((a, b) => a - b).join(',')
    if (seenSets.has(key)) continue
    seenSets.add(key)
    unique.push(result)
  }
  return unique.slice(0, ctx.topN)
}
