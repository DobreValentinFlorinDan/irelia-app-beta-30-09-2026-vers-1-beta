/**
 * Statistical layer for Irelia build recommendation.
 *
 * Riot's public API exposes no per-champion matchup win rates, so every figure
 * this module produces is an inference from a *sample* of captured matches. The
 * design goal is therefore honesty about uncertainty:
 *
 *  - every proportion carries a Wilson score interval, which behaves correctly
 *    at small n (unlike the normal approximation, which yields impossible
 *    bounds like -3% or 130%).
 *  - games are *weighted* by how similar their context is to the query (enemy
 *    laner identity, ally/enemy composition overlap, patch recency), so a game
 *    against the exact lane opponent counts for more than an unrelated one.
 *  - the effective sample size is reported alongside the raw count, so a
 *    heavily weighted sample of 40 games cannot masquerade as 40 independent
 *    observations.
 */
import type { MatchBuildData } from './buildEngine.js'

/* ------------------------------------------------------------------ *
 * Inference primitives
 * ------------------------------------------------------------------ */

export type ConfidenceInterval = {
  /** Point estimate of the proportion (0..1). */
  estimate: number
  low: number
  high: number
  /** Raw number of observations behind the estimate. */
  sampleSize: number
  /** Kish effective sample size after weighting; equals sampleSize when unweighted. */
  effectiveSampleSize: number
  confidence: number
}

/** Two-sided z-score for a confidence level. Only 0.90/0.95/0.99 are offered. */
function zFor(confidence: number): number {
  if (confidence >= 0.99) return 2.575829
  if (confidence >= 0.95) return 1.959964
  if (confidence >= 0.90) return 1.644854
  return 1.959964
}

/**
 * Wilson score interval for a binomial proportion.
 *
 * Uses the weighted sample size so that a context-weighted estimate is not
 * presented with the precision of an unweighted one.
 */
export function wilsonInterval(
  successes: number,
  total: number,
  confidence = 0.95,
  effectiveTotal = total,
): ConfidenceInterval {
  if (total <= 0) {
    return { estimate: 0, low: 0, high: 1, sampleSize: 0, effectiveSampleSize: 0, confidence }
  }
  const n = Math.max(effectiveTotal, 1)
  const p = successes / total
  const z = zFor(confidence)
  const z2 = z * z
  const denominator = 1 + z2 / n
  const centre = p + z2 / (2 * n)
  const spread = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
  return {
    estimate: p,
    low: Math.max(0, (centre - spread) / denominator),
    high: Math.min(1, (centre + spread) / denominator),
    sampleSize: total,
    effectiveSampleSize: effectiveTotal,
    confidence,
  }
}

/**
 * Weighted proportion with a Wilson interval.
 *
 * `weights[i]` expresses how comparable observation `i` is to the query. The
 * effective sample size uses Kish's formula, (Σw)² / Σw², which collapses
 * toward 1 when a single game dominates the weighting — exactly the behaviour
 * wanted when only one match resembles the draft.
 */
export function weightedInterval(
  observations: Array<{ success: boolean; weight: number }>,
  confidence = 0.95,
): ConfidenceInterval {
  const usable = observations.filter((entry) => entry.weight > 0)
  if (!usable.length) {
    return { estimate: 0, low: 0, high: 1, sampleSize: 0, effectiveSampleSize: 0, confidence }
  }

  const totalWeight = usable.reduce((sum, entry) => sum + entry.weight, 0)
  const successWeight = usable.reduce((sum, entry) => sum + (entry.success ? entry.weight : 0), 0)
  const sumSquares = usable.reduce((sum, entry) => sum + entry.weight * entry.weight, 0)
  const effective = sumSquares > 0 ? (totalWeight * totalWeight) / sumSquares : usable.length

  const estimate = totalWeight > 0 ? successWeight / totalWeight : 0
  const z = zFor(confidence)
  const z2 = z * z
  const n = Math.max(effective, 1e-9)
  const denominator = 1 + z2 / n
  const centre = estimate + z2 / (2 * n)
  const spread = z * Math.sqrt((estimate * (1 - estimate)) / n + z2 / (4 * n * n))

  return {
    estimate,
    low: Math.max(0, (centre - spread) / denominator),
    high: Math.min(1, (centre + spread) / denominator),
    sampleSize: usable.length,
    effectiveSampleSize: effective,
    confidence,
  }
}

/* ------------------------------------------------------------------ *
 * Bayesian shrinkage
 * ------------------------------------------------------------------ */

/**
 * Shrinks a small-sample win rate toward a prior (the champion's overall win
 * rate), the way the large stats sites do. A 3-game "67% vs Ahri" is mostly
 * noise; shrinking it toward Irelia's ~52% base gives a more honest number.
 *
 * Beta-binomial: prior mean = baseRate with pseudo-count `priorStrength`
 * (default 10 = "the base rate is worth 10 games"). The returned estimate is
 * the posterior mean (wins + α) / (games + α + β).
 */
export function shrinkWinRate(
  wins: number,
  games: number,
  baseRate: number,
  priorStrength = 10,
): number {
  if (games <= 0) return baseRate
  const alpha = priorStrength * baseRate
  const beta = priorStrength * (1 - baseRate)
  return (wins + alpha) / (games + alpha + beta)
}

/**
 * Wilson interval on the *posterior* beta-binomial, so the shrunken estimate is
 * reported with an honest uncertainty that reflects the added prior strength.
 */
export function shrunkenInterval(
  wins: number,
  games: number,
  baseRate: number,
  confidence = 0.95,
  priorStrength = 10,
): ConfidenceInterval {
  const alpha = priorStrength * baseRate
  const effectiveTotal = games + priorStrength
  const effectiveSuccesses = wins + alpha
  const p = effectiveTotal > 0 ? effectiveSuccesses / effectiveTotal : baseRate
  const z = zFor(confidence)
  const z2 = z * z
  const n = Math.max(effectiveTotal, 1e-9)
  const denominator = 1 + z2 / n
  const centre = p + z2 / (2 * n)
  const spread = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
  return {
    estimate: p,
    low: Math.max(0, (centre - spread) / denominator),
    high: Math.min(1, (centre + spread) / denominator),
    sampleSize: games,
    effectiveSampleSize: effectiveTotal,
    confidence,
  }
}

/* ------------------------------------------------------------------ *
 * Contextual weighting
 * ------------------------------------------------------------------ */

export type WeightContext = {
  /** Champion ids on the enemy team, including the lane opponent. */
  enemies: number[]
  /** Champion ids on the player's team, excluding Irelia. */
  allies: number[]
  /** Champion id of the direct lane opponent, when known. */
  laneOpponent?: number | null
  position?: string
  /** The patch to prefer; matches on it receive a recency bonus. */
  patch?: string
}

/** Relative importance of each context signal. Documented so values are auditable. */
export const WEIGHT_MODEL = {
  /** A game against the exact lane opponent is the strongest single signal. */
  exactLaneOpponent: 4,
  /** Sharing the player's role keeps the comparison in the same lane. */
  samePosition: 2,
  /** Per-champion enemy overlap, excluding the lane opponent (already scored). */
  perEnemyOverlap: 1.5,
  /** Ally overlap matters less than the enemy side but still shapes the build. */
  perAllyOverlap: 0.75,
  /** Current-patch games are more relevant than older ones. */
  currentPatch: 1.0,
  /** Floor so a dissimilar game still contributes a little evidence. */
  baseline: 0.25,
} as const

/**
 * Scores how comparable a captured match is to the draft being queried.
 *
 * Enemy-side similarity is weighted above ally-side because the enemy
 * composition dictates the defensive itemisation, while the ally composition
 * mostly affects who supplies damage and crowd control.
 */
export function matchWeight(match: MatchBuildData, context: WeightContext): number {
  let weight = WEIGHT_MODEL.baseline

  if (context.laneOpponent && match.opponentChampionId === context.laneOpponent) {
    weight += WEIGHT_MODEL.exactLaneOpponent
  }
  if (context.position && match.position === context.position) {
    weight += WEIGHT_MODEL.samePosition
  }

  const enemySet = new Set(context.enemies.filter((id) => id > 0))
  if (context.laneOpponent) enemySet.delete(context.laneOpponent)
  const enemyOverlap = match.enemyChampionIds.filter((id) => enemySet.has(id)).length
  weight += Math.min(enemyOverlap, 4) * WEIGHT_MODEL.perEnemyOverlap

  const allySet = new Set(context.allies.filter((id) => id > 0))
  const allyOverlap = match.allyChampionIds.filter((id) => allySet.has(id)).length
  weight += Math.min(allyOverlap, 4) * WEIGHT_MODEL.perAllyOverlap

  if (context.patch && match.patch === context.patch) weight += WEIGHT_MODEL.currentPatch

  return weight
}

/* ------------------------------------------------------------------ *
 * Item-set optimisation
 * ------------------------------------------------------------------ */

export type ItemSetEntry = {
  /** Sorted item ids of a completed build, e.g. [3153, 3181, 3047, ...]. */
  items: number[]
  games: number
  wins: number
  winRate: ConfidenceInterval
  /** Mean game duration in seconds for this build. */
  averageDuration: number | null
}

/**
 * Optimises over *whole* completed item sets rather than treating each item
 * independently.
 *
 * Counting items independently double-counts correlated choices: Berserker's
 * Greaves and Blade of the Ruined King co-occur so often that two separate
 * frequency tables cannot express the actual build. Grouping by the finished
 * inventory preserves those correlations.
 *
 * `finalItems` is built from item0..item5 only. item6 is the trinket slot and is
 * deliberately excluded, since every player defaults to a ward and it carries no
 * build information. Duplicate ids within a build are legitimate (two Doran's
 * Blades, or a component held alongside its completed item) and are kept.
 */
export function optimiseItemSets(
  matches: MatchBuildData[],
  options: { minGames?: number; maxSets?: number; confidence?: number } = {},
): ItemSetEntry[] {
  const { minGames = 2, maxSets = 12, confidence = 0.95 } = options

  type Group = { items: number[]; games: number; wins: number; totalDuration: number; timedGames: number }
  const groups = new Map<string, Group>()

  for (const match of matches) {
    // Ignore incomplete inventories: a 5-item game is not a finished build.
    if (match.finalItems.length < 4) continue
    const items = [...match.finalItems].sort((a, b) => a - b)
    const key = items.join('+')
    const group = groups.get(key) ?? { items, games: 0, wins: 0, totalDuration: 0, timedGames: 0 }
    group.games += 1
    if (match.win) group.wins += 1
    if (match.duration > 0) {
      group.totalDuration += match.duration
      group.timedGames += 1
    }
    groups.set(key, group)
  }

  return [...groups.values()]
    .filter((group) => group.games >= minGames)
    .map((group) => ({
      items: group.items,
      games: group.games,
      wins: group.wins,
      winRate: wilsonInterval(group.wins, group.games, confidence),
      averageDuration: group.timedGames ? group.totalDuration / group.timedGames : null,
    }))
    .sort((a, b) => b.games - a.games || b.winRate.estimate - a.winRate.estimate)
    .slice(0, maxSets)
}

/* ------------------------------------------------------------------ *
 * Skill order
 * ------------------------------------------------------------------ */

export type SkillLevelRow = {
  /** 1-based champion level. */
  level: number
  /** Skill slot (1=Q, 2=W, 3=E, 4=R) most commonly chosen at this level. */
  slot: number
  /** Share of games that took `slot` at this level. */
  share: ConfidenceInterval
  /** Counts per slot, for tooltips. */
  counts: Record<number, number>
}

export type SkillOrderAnalysis = {
  rows: SkillLevelRow[]
  /** Most frequent full order strings, newest first. */
  orders: Array<{ order: string; games: number }>
  /** Slots ordered by total points invested, i.e. the max priority. */
  priority: number[]
  /** Modal first three levels, e.g. "QWE". */
  earlyOrder: string
  maxLevel: number
  sampleSize: number
  confidence: number
}

/**
 * Builds the per-level skill matrix the stats sites render as a grid.
 *
 * Skill order strings are Riot's skillSlot per level (1=Q, 2=W, 3=E, 4=R), so
 * reading position i of a game's string gives the skill taken at level i+1.
 */
export function analyseSkillOrder(
  matches: MatchBuildData[],
  options: { maxLevel?: number; confidence?: number } = {},
): SkillOrderAnalysis {
  const { maxLevel = 13, confidence = 0.95 } = options

  const usable = matches.filter((match) => match.skillOrder.length >= 6)
  const rows: SkillLevelRow[] = []

  for (let level = 0; level < maxLevel; level += 1) {
    const counts: Record<number, number> = {}
    let modal = 0
    let modalCount = -1

    for (const match of usable) {
      const slot = Number(match.skillOrder[level])
      if (!slot || slot < 1 || slot > 4) continue
      counts[slot] = (counts[slot] ?? 0) + 1
      if (counts[slot] > modalCount) {
        modalCount = counts[slot]
        modal = slot
      }
    }

    if (!usable.length) continue

    const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
    if (!total) continue

    const winners = counts[modal] ?? 0
    rows.push({
      level: level + 1,
      slot: modal,
      share: wilsonInterval(winners, total, confidence),
      counts,
    })
  }

  // Max priority is the order in which skills reach their final rank, averaged
  // across games. Total points invested is NOT a valid proxy: Q is levelled from
  // level 1 and so accumulates more early points even when E is maxed first.
  const finishLevels = new Map<number, number[]>()
  for (const match of usable) {
    for (const slot of [1, 2, 3]) {
      const lastLevel = match.skillOrder.lastIndexOf(String(slot)) + 1
      if (lastLevel <= 0) continue
      const list = finishLevels.get(slot) ?? []
      list.push(lastLevel)
      finishLevels.set(slot, list)
    }
  }
  const averageFinish = (slot: number) => {
    const levels = finishLevels.get(slot)
    if (!levels?.length) return Number.POSITIVE_INFINITY
    return levels.reduce((sum, value) => sum + value, 0) / levels.length
  }
  const priority = [1, 2, 3].sort((a, b) => averageFinish(a) - averageFinish(b))

  const orderCounts = new Map<string, number>()
  for (const match of usable) {
    orderCounts.set(match.skillOrder, (orderCounts.get(match.skillOrder) ?? 0) + 1)
  }

  const early = new Map<string, number>()
  for (const match of usable) {
    if (match.skillOrder.length < 3) continue
    const prefix = match.skillOrder.slice(0, 3)
    early.set(prefix, (early.get(prefix) ?? 0) + 1)
  }
  const earlyOrder = [...early.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''

  return {
    rows,
    orders: [...orderCounts.entries()]
      .map(([order, games]) => ({ order, games }))
      .sort((a, b) => b.games - a.games)
      .slice(0, 6),
    priority,
    earlyOrder,
    maxLevel,
    sampleSize: usable.length,
    confidence,
  }
}

/* ------------------------------------------------------------------ *
 * Ban rate (sampled, not global)
 * ------------------------------------------------------------------ */

/**
 * Ban share observed in the captured sample.
 *
 * Riot's public API exposes no global ban statistics, so this is explicitly a
 * sample-derived figure. The caller must label it as such.
 */
export function sampleBanRate(matches: Array<Record<string, any>>, championId = 39): ConfidenceInterval {
  let games = 0
  let banned = 0
  for (const match of matches) {
    const teams = match?.info?.teams
    if (!Array.isArray(teams)) continue
    games += 1
    const isBanned = teams.some((team: any) =>
      Array.isArray(team?.bans) && team.bans.some((ban: any) => ban?.championId === championId),
    )
    if (isBanned) banned += 1
  }
  return wilsonInterval(banned, games)
}

