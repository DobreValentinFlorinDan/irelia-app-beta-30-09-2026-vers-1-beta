/**
 * Validation report for the cached build evidence.
 *
 * Renders the same aggregation the Recommended Build view shows, but with item,
 * rune and champion NAMES resolved from the cached Data Dragon payload, so the
 * output can be diffed against a reference site (onetrick.gg / u.gg) instead of
 * compared icon-by-icon.
 *
 * It also checks a small set of high-confidence expectations taken from those
 * reference builds and prints PASS/DIFF for each.
 *
 * Usage (from the project root, after a scan has populated ./cache):
 *   node scripts/validate-build.mjs [--lane TOP|MID] [--opponent <championId>]
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer } from 'vite'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')

const argv = process.argv.slice(2)
function option(name, fallback) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

const laneRaw = String(option('lane', 'TOP')).toUpperCase()
const lane = laneRaw === 'MID' ? 'MID' : 'TOP'
const opponent = Number(option('opponent', 0)) || null

/* Riot spell ids are a fixed enum, not part of Data Dragon's static payload. */
const SPELL_NAMES = {
  1: 'Cleanse', 3: 'Exhaust', 4: 'Flash', 6: 'Ghost', 7: 'Heal',
  11: 'Smite', 12: 'Teleport', 13: 'Clarity', 14: 'Ignite', 21: 'Barrier',
}
const SLOT_NAMES = { 1: 'Q', 2: 'W', 3: 'E', 4: 'R' }

const loader = await createViteServer({
  root: projectRoot,
  configFile: false,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true },
})

const riot = await loader.ssrLoadModule('/server/riotApi.ts')
const disk = await loader.ssrLoadModule('/server/diskCache.ts')

const cachedStatic = await disk.readCache('scans', 'static-data-v2')
const staticData = cachedStatic?.value
if (!staticData) {
  console.error('[validate] No cached Data Dragon payload — run the builder first.')
  process.exit(2)
}

const itemName = new Map(staticData.items.map((item) => [item.id, item.name]))
const runeName = new Map(staticData.runes.map((rune) => [rune.id, rune.name]))
const championName = new Map(staticData.champions.map((champ) => [champ.id, champ.name]))
const nameOf = (id) => itemName.get(id) ?? `#${id}`

const response = await riot.buildRecommendation('', {
  opponent, allies: [], enemies: [], lane, source: 'lane',
})

const pct = (value) => `${(value * 100).toFixed(1)}%`
const line = (share) => `      ${String(nameOf(share.id)).padEnd(26)} ${pct(share.winRate).padStart(6)} WR  ${String(share.games).padStart(5)} games`

console.log('')
console.log(`=== ${lane} build evidence — patch ${response.patch}${response.patchExact ? ' (exact)' : ' (nearest)'} ===`)
console.log(`games: ${response.games}   win rate: ${pct(response.profile.winRate)}   source: ${response.source}`)
if (opponent) {
  console.log(`matchup: Irelia vs ${championName.get(opponent) ?? `#${opponent}`}`)
}
console.log(`reason: ${response.reason}`)

console.log('\n-- Starting items --')
response.profile.startingItems.slice(0, 4).forEach((s) => console.log(line(s)))

console.log('\n-- Boots --')
response.profile.boots.slice(0, 4).forEach((s) => console.log(line(s)))

console.log('\n-- Core items --')
response.profile.coreItems.slice(0, 6).forEach((s) => console.log(line(s)))

console.log('\n-- Full build path --')
response.profile.fullBuild.slice(0, 12).forEach((s) => console.log(line(s)))

console.log('\n-- Slot-by-slot --')
;(response.profile.slots ?? []).forEach((slot) => {
  const options = (slot.options ?? []).slice(0, 3)
    .map((opt) => `${nameOf(opt.id)} ${pct(opt.winRate ?? 0)} (${opt.games})`)
    .join('  |  ')
  console.log(`   slot ${slot.slot}: ${options || '(none)'}`)
})

console.log('\n-- Keystones --')
response.profile.keystones.slice(0, 5).forEach((s) => console.log(`      ${String(runeName.get(s.id) ?? '#' + s.id).padEnd(26)} ${String(s.games).padStart(5)} games`))

console.log('\n-- Rune trees (primary) --')
response.profile.primaryStyles.slice(0, 3).forEach((s) => console.log(`      ${String(runeName.get(s.id) ?? '#' + s.id).padEnd(26)} ${String(s.games).padStart(5)} games`))

console.log('\n-- Summoners --')
response.profile.spells.slice(0, 4).forEach((s) => {
  const names = s.ids.map((id) => SPELL_NAMES[id] ?? `#${id}`).join(' + ')
  console.log(`      ${names.padEnd(26)} ${pct(s.winRate).padStart(6)} WR  ${String(s.games).padStart(5)} games`)
})

const skills = response.skills
if (skills) {
  console.log('\n-- Skill priority --')
  console.log(`      ${skills.priority.map((slot) => SLOT_NAMES[slot] ?? slot).join(' > ')}`)
  console.log(`      early order (levels 1-3): ${skills.earlyOrder}   sample ${skills.sampleSize}`)
  console.log('\n-- Most common orders --')
  skills.orders.slice(0, 5).forEach((entry) => console.log(`      ${entry.order.padEnd(18)} ${String(entry.games).padStart(5)} games`))
}

/* ------------------------------------------------------------------ *
 * High-confidence expectations from the reference builds
 * ------------------------------------------------------------------ */

const IDS = { BOTRK: 3153, STEELCAPS: 3047, DORANS_BLADE: 1055, HEALTH_POTION: 2003 }

/** Skill slots arrive as Riot's numeric encoding (1=Q, 2=W, 3=E, 4=R). */
const asLetters = (digits) => String(digits ?? '').split('').map((d) => SLOT_NAMES[Number(d)] ?? '?').join('')

// The item finished first is slot 1's most-bought completed item, NOT
// purchasePath[0] — that array opens with the starting items (and the ward).
const slotOne = response.profile.slots?.[0]?.options?.[0] ?? null
const topBoots = response.profile.boots[0] ?? null
const startingIds = new Set(response.profile.startingItems.slice(0, 3).map((s) => s.id))
const priority = (skills?.priority ?? []).slice(0, 3).join('')
const earlyLetters = asLetters(skills?.earlyOrder)
const topKeystone = response.profile.keystones[0] ?? null
const topTree = response.profile.primaryStyles[0] ?? null

const checks = [
  ['First completed item is Blade of the Ruined King', slotOne?.id === IDS.BOTRK, slotOne ? nameOf(slotOne.id) : 'none'],
  ['Top boots are Plated Steelcaps', topBoots?.id === IDS.STEELCAPS, topBoots ? nameOf(topBoots.id) : 'none'],
  ["Starting items include Doran's Blade", startingIds.has(IDS.DORANS_BLADE), [...startingIds].map(nameOf).join(', ')],
  ['Starting items include Health Potion', startingIds.has(IDS.HEALTH_POTION), `${startingIds.size} starting items`],
  ['Skill priority is Q > W > E', priority === '123', priority ? asLetters(priority) : 'none'],
  // onetrick.gg's dominant 1-3 grid is Q at 1, E at 2, W at 3 (the 88% row).
  ['Early order is Q > E > W (onetrick.gg 88% grid)', earlyLetters === 'QEW', `${earlyLetters} (raw ${skills?.earlyOrder})`],
  ['Top keystone is Conqueror', runeName.get(topKeystone?.id) === 'Conqueror', runeName.get(topKeystone?.id) ?? 'none'],
  ['Primary rune tree is Precision', runeName.get(topTree?.id) === 'Precision', runeName.get(topTree?.id) ?? 'none'],
]

console.log('\n-- Diff against reference builds (onetrick.gg / u.gg) --')
let failures = 0
for (const [label, ok, actual] of checks) {
  if (!ok) failures += 1
  console.log(`   ${ok ? 'PASS' : 'DIFF'}  ${label}${ok ? '' : `  -> got: ${actual}`}`)
}
console.log(`\n   ${checks.length - failures}/${checks.length} expectations matched at ${response.games} games`)

await loader.close()
process.exit(0)
