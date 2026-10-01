/**
 * Headless sanity test for the Build Calculator engine.
 *
 * Loads src/calculator.ts through the same Vite module loader the API server
 * uses, then runs the default "balanced" optimisation against the live kit and
 * item catalog served by the local API, printing the top builds for eyeballing.
 *
 * Usage (server running): node scripts/test-calculator.mjs
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer } from 'vite'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')
const API = process.env.IRELIA_TEST_URL ?? 'http://127.0.0.1:5273'

const loader = await createViteServer({
  root: projectRoot,
  configFile: false,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true },
})

const { optimizeBuilds, ranksFor } = await loader.ssrLoadModule('/src/calculator.ts')

const kit = await (await fetch(`${API}/api/calculator/kit`)).json()
const catalogPayload = await (await fetch(`${API}/api/champions`)).json()

const catalog = catalogPayload.items
  .filter((item) => item.gold > 0 && item.purchasable)
  .map((item) => ({
    id: item.id,
    name: item.name,
    gold: item.gold,
    stats: item.stats,
    tags: item.tags ?? [],
    purchasable: Boolean(item.purchasable),
  }))

console.log(`kit patch ${kit.version} damageData=${kit.damageData} items=${catalog.length}`)
console.log(`ranks at 13 (QE):`, JSON.stringify(ranksFor(13, 'QE')))

const context = {
  level: 13,
  rankOrder: 'QE',
  targetArmor: 70,
  targetMr: 45,
  targetHp: 1800,
  threatPhysical: 0.6,
  fightSeconds: 10,
  autoUptime: 0.75,
  wCharge: 1,
  passiveStacks: 4,
  includeBoots: true,
  budget: 16500,
  finishedOnly: true,
  weightBurst: 1,
  weightDps: 2.4,
  weightEhp: 0.7,
  weightHeal: 0.6,
  evidenceWeight: 0,
  lockedItems: [],
  bannedItems: [],
  topN: 3,
}

const started = Date.now()
const results = optimizeBuilds(kit, context, catalog, null)
const elapsed = Date.now() - started

console.log(`optimisation took ${elapsed} ms\n`)
results.forEach((result, index) => {
  const m = result.metrics
  console.log(`#${index + 1} score=${Math.round(result.score)} cost=${result.cost} tilt=${m.evidenceTilt.toFixed(2)}`)
  console.log(`   items: ${result.items.map((item) => `${item.name} (${item.gold})`).join(' + ')}`)
  console.log(`   burst=${Math.round(m.burst)} dps=${Math.round(m.dps)} ehp=${Math.round(m.ehp)} heal/s=${m.healPerSecond.toFixed(1)} ad=${m.ad.toFixed(0)} as=${m.attackSpeed.toFixed(2)} ah=${m.abilityHaste} phys=${(m.physicalDamageShare * 100).toFixed(0)}%`)
  console.log(`   marginal: ${result.marginal.map((value) => Math.round(value)).join(' / ')}`)
  console.log('')
})

const names = results[0]?.items.map((item) => item.name) ?? []
const expectedCore = ['Blade of The Ruined King', "Wit's End"]
const missing = expectedCore.filter((name) => !names.includes(name))
if (missing.length) {
  console.error(`FAIL: expected core items missing from the top build: ${missing.join(', ')}`)
  process.exit(1)
}
console.log('PASS: top build contains BotRK and Wit\'s End (the expected on-hit core).')
