import { useMemo, useState } from 'react'
import './App.css'

type Mode = 'manual' | 'auto'

type BuildProfile = {
  id: string
  name: string
  mythic: string
  boots: string
  coreItems: string[]
  runes: string[]
  skillOrder: string[]
  notes: string
  weights: Record<string, number>
}

const championOptions = [
  'Irelia',
  'Aatrox',
  'Akali',
  'Ashe',
  'Darius',
  'Ezreal',
  'Garen',
  'Gwen',
  'Kha\'Zix',
  'Leona',
  'Lucian',
  'Morgana',
  'Nautilus',
  'Rell',
  'Riven',
  'Sett',
  'Syndra',
  'Vex',
  'Vi',
  'Vladimir',
  'Yasuo',
  'Yone',
  'Zed',
]

const defaultManualCurrent = ['Irelia', 'Rell', 'Nautilus', 'Morgana', 'Ezreal']
const defaultManualEnemy = ['Aatrox', 'Vex', 'Morgana', 'Kha\'Zix', 'Lucian']

const championThreats: Record<string, Record<string, number>> = {
  Aatrox: { frontline: 3, sustain: 2, dive: 1 },
  Akali: { mobility: 3, burst: 3, poke: 1 },
  Ashe: { poke: 3, ranged: 2, sustain: 1 },
  Darius: { frontline: 2, sustain: 2 },
  Ezreal: { poke: 2, ranged: 2 },
  Garen: { frontline: 2, sustain: 1 },
  Gwen: { sustain: 2, magic: 2 },
  'Kha\'Zix': { dive: 3, mobility: 2 },
  Leona: { frontline: 2, crowdControl: 3 },
  Lucian: { poke: 2, ranged: 2 },
  Morgana: { magic: 3, sustain: 2, poke: 2 },
  Nautilus: { frontline: 2, crowdControl: 3 },
  Rell: { frontline: 2, crowdControl: 2 },
  Riven: { dive: 2, mobility: 2 },
  Sett: { frontline: 2, sustain: 2 },
  Syndra: { burst: 3, magic: 2 },
  Vex: { magic: 3, poke: 2 },
  Vi: { frontline: 2, dive: 2 },
  Vladimir: { sustain: 2, magic: 2 },
  Yasuo: { mobility: 2, burst: 2 },
  Yone: { mobility: 2, ranged: 1 },
  Zed: { burst: 2, mobility: 2 },
  Irelia: { frontline: 1, mobility: 1, sustain: 1 },
}

const buildProfiles: BuildProfile[] = [
  {
    id: 'tank-shred',
    name: 'Tank shred / sustain',
    mythic: 'Goredrinker',
    boots: 'Plated Steelcaps',
    coreItems: ['Death\'s Dance', 'Black Cleaver', 'Maw of Malmortius'],
    runes: ['Resolve', 'Precision'],
    skillOrder: ['Q', 'E', 'W'],
    notes: 'Best when the enemy team is front-loaded with tankiness and sustain.',
    weights: { frontline: 3, sustain: 3, magic: 2, crowdControl: 1 },
  },
  {
    id: 'anti-poke',
    name: 'Anti-poke / kill window',
    mythic: 'Trinity Force',
    boots: 'Boots of Mobility',
    coreItems: ['Death\'s Dance', 'Black Cleaver', 'Wit\'s End'],
    runes: ['Precision', 'Domination'],
    skillOrder: ['Q', 'W', 'E'],
    notes: 'Strong versus ranged poke and burst that can be punished in close range.',
    weights: { poke: 3, mobility: 2, burst: 2, ranged: 2 },
  },
  {
    id: 'anti-dive',
    name: 'Anti-dive / split pressure',
    mythic: 'Goredrinker',
    boots: 'Plated Steelcaps',
    coreItems: ['Death\'s Dance', 'Sterak\'s Gage', 'Titanic Hydra'],
    runes: ['Resolve', 'Domination'],
    skillOrder: ['Q', 'E', 'W'],
    notes: 'Good when the enemy comp is heavy on dives and mobile assassins.',
    weights: { dive: 4, mobility: 3, crowdControl: 2, frontline: 1 },
  },
  {
    id: 'burst-train',
    name: 'Burst / tempo route',
    mythic: 'Night Harvester',
    boots: 'Ionian Boots of Lucidity',
    coreItems: ['The Collector', 'Death\'s Dance', 'Black Cleaver'],
    runes: ['Precision', 'Sorcery'],
    skillOrder: ['Q', 'E', 'W'],
    notes: 'A cleaner choice when your team wants speed and burst in prolonged fights.',
    weights: { burst: 3, magic: 2, ranged: 1, poke: 1 },
  },
]

function analyzeComp(comp: string[]) {
  const summary: Record<string, number> = {
    frontline: 0,
    sustain: 0,
    magic: 0,
    poke: 0,
    range: 0,
    burst: 0,
    dive: 0,
    mobility: 0,
    crowdControl: 0,
    ranged: 0,
  }

  comp.forEach((champion) => {
    const profile = championThreats[champion] ?? {}
    Object.entries(profile).forEach(([key, value]) => {
      summary[key] = (summary[key] ?? 0) + value
    })
  })

  return Object.entries(summary)
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => ({ key, value }))
}

function scoreBuild(build: BuildProfile, currentComp: string[], enemyComp: string[]) {
  const currentThreats = analyzeComp(currentComp)
  const enemyThreats = analyzeComp(enemyComp)

  const currentMomentum = currentThreats.reduce((total, { key, value }) => {
    return total + (build.weights[key] ?? 0) * value
  }, 0)

  const enemyPressure = enemyThreats.reduce((total, { key, value }) => {
    const weight = build.weights[key] ?? 0
    return total + weight * value
  }, 0)

  return currentMomentum + enemyPressure
}

function getRecommendation(currentComp: string[], enemyComp: string[]) {
  const ranked = buildProfiles
    .map((profile) => ({
      ...profile,
      score: scoreBuild(profile, currentComp, enemyComp),
    }))
    .sort((a, b) => b.score - a.score)

  return ranked[0]
}

function parseAutoComp(raw: string) {
  try {
    const parsed = JSON.parse(raw || '{}') as {
      myComp?: string[]
      enemyComp?: string[]
    }

    return {
      myComp: Array.isArray(parsed.myComp) ? parsed.myComp : defaultManualCurrent,
      enemyComp: Array.isArray(parsed.enemyComp) ? parsed.enemyComp : defaultManualEnemy,
    }
  } catch {
    return {
      myComp: defaultManualCurrent,
      enemyComp: defaultManualEnemy,
    }
  }
}

function App() {
  const [mode, setMode] = useState<Mode>('manual')

  const [manualCurrent, setManualCurrent] = useState(defaultManualCurrent)
  const [manualEnemy, setManualEnemy] = useState(defaultManualEnemy)

  const [autoInput, setAutoInput] = useState(
    JSON.stringify(
      {
        myComp: defaultManualCurrent,
        enemyComp: defaultManualEnemy,
      },
      null,
      2,
    ),
  )

  const activeRecommendation = useMemo(() => {
    if (mode === 'manual') {
      return getRecommendation(manualCurrent, manualEnemy)
    }

    const { myComp, enemyComp } = parseAutoComp(autoInput)
    return getRecommendation(myComp, enemyComp)
  }, [autoInput, manualCurrent, manualEnemy, mode])

  const matchupSummary = useMemo(() => {
    if (mode === 'manual') {
      return analyzeComp(manualEnemy)
    }

    const { enemyComp } = parseAutoComp(autoInput)
    return analyzeComp(enemyComp)
  }, [autoInput, manualEnemy, mode])

  const setTeamSlot = (team: 'current' | 'enemy', index: number, value: string) => {
    if (team === 'current') {
      const next = [...manualCurrent]
      next[index] = value
      setManualCurrent(next)
      return
    }

    const next = [...manualEnemy]
    next[index] = value
    setManualEnemy(next)
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Local build advisor</p>
          <h1>Irelia matchup build helper</h1>
        </div>
        <div className="mode-toggle" aria-label="Select matchup mode">
          <button
            type="button"
            className={mode === 'manual' ? 'active' : ''}
            onClick={() => setMode('manual')}
          >
            Manual
          </button>
          <button
            type="button"
            className={mode === 'auto' ? 'active' : ''}
            onClick={() => setMode('auto')}
          >
            Auto
          </button>
        </div>
      </header>

      <main className="content-grid">
        <section className="panel">
          <h2>Matchup input</h2>

          {mode === 'manual' ? (
            <>
              <div className="team-block">
                <h3>My current comp</h3>
                <div className="slot-grid">
                  {manualCurrent.map((champion, index) => (
                    <select
                      key={`current-${index}`}
                      value={champion}
                      onChange={(event) => setTeamSlot('current', index, event.target.value)}
                    >
                      {championOptions.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ))}
                </div>
              </div>

              <div className="team-block">
                <h3>Enemy comp</h3>
                <div className="slot-grid">
                  {manualEnemy.map((champion, index) => (
                    <select
                      key={`enemy-${index}`}
                      value={champion}
                      onChange={(event) => setTeamSlot('enemy', index, event.target.value)}
                    >
                      {championOptions.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="auto-block">
              <label htmlFor="auto-json">Paste detected team JSON</label>
              <textarea
                id="auto-json"
                value={autoInput}
                onChange={(event) => setAutoInput(event.target.value)}
                rows={10}
              />
            </div>
          )}
        </section>

        <section className="panel recommendation-panel">
          <h2>Best Irelia build</h2>
          <div className="recommendation-card">
            <div className="recommendation-header">
              <span className="badge">Recommended</span>
              <strong>{activeRecommendation.name}</strong>
            </div>

            <div className="build-grid">
              <div>
                <span>Mythic</span>
                <strong>{activeRecommendation.mythic}</strong>
              </div>
              <div>
                <span>Boots</span>
                <strong>{activeRecommendation.boots}</strong>
              </div>
              <div>
                <span>Runes</span>
                <strong>{activeRecommendation.runes.join(' / ')}</strong>
              </div>
              <div>
                <span>Skill order</span>
                <strong>{activeRecommendation.skillOrder.join(' > ')}</strong>
              </div>
            </div>

            <div className="item-list">
              {activeRecommendation.coreItems.map((item) => (
                <span key={item} className="item-pill">
                  {item}
                </span>
              ))}
            </div>

            <p className="notes">{activeRecommendation.notes}</p>
          </div>
        </section>

        <section className="panel full-span">
          <h2>Enemy threat profile</h2>
          <div className="summary-row">
            {matchupSummary.length === 0 ? (
              <p className="neutral">No dominant threats detected.</p>
            ) : (
              matchupSummary.slice(0, 5).map(({ key, value }) => (
                <div key={key} className="summary-chip">
                  <span>{key}</span>
                  <strong>{value}</strong>
                </div>
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
