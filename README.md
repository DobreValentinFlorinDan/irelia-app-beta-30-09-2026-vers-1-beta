# Irelia Fieldbook

A personal, local-only research tool for playing Irelia in League of Legends. It runs as a Vite + React single-page app with a small local Node middleware plugin that talks to the Riot web API and, optionally, your live League Client.

## What it does

- **Your ranked baseline** — loads your last 20 ranked solo games (EUROPE routing) and reports your Irelia share, Irelia win rate, and recent matchups.
- **Find Irelia one-tricks** — scans a bounded sample of the KR Challenger / Grandmaster / Master ladder, verifies TOP/MID Irelia specialists, and shows their builds, runes, keystones, and lane opponents.
- **Draft composition** — plan a mock draft manually, or read your live champion select straight from the local League Client.
- **Build and rune evidence** — aggregates the verified Korean OTP games into lane-route and composition-based item, rune, and purchase-order evidence for the current patch.

Build frequencies and win rates shown are **observational**, not a guarantee of an optimal build.

## Local setup
1. Run `npm install`.
2. Keep your Personal API key as `RIOT_API_KEY` in the root `.env.local`. It is read only by the local server; never expose it in the client.
3. Either run `npm run dev` and open `http://127.0.0.1:3000/`, or launch the desktop app (see below).

Optional:

- `LEAGUE_CLIENT_LOCKFILE` — set this only if your League Client is installed somewhere other than the default Riot Games path, so the live champion-select reader can find the lockfile.

## Desktop app

The app also runs as a real Electron window. The Riot API key stays in the main
process and the local server; it is never exposed to the renderer, which only
talks to `127.0.0.1`.

```
scripts\start-desktop.cmd      # builds if needed, launches the window
```

or by hand:

```
npm run build && npm run desktop
```

`npm run desktop:server` starts the Electron shell expecting an already-built
`dist/`; `npm run server` starts only the local API + client server on
`127.0.0.1:5273`.

### ELECTRON_RUN_AS_NODE

Always launch through `scripts\start-desktop.cmd`, or ensure
`ELECTRON_RUN_AS_NODE` is unset in your shell. When that variable is set (the DSH
harness and other Electron-based tooling export it globally) Electron runs as
plain node instead of a GUI app and exits immediately with
`Cannot read properties of undefined (reading 'whenReady')`. The launcher
clears it; `electron/main.cjs` also clears it for the child server process.

## Scripts

- `npm run dev`: start the Vite dev server with the local Riot API middleware.
- `npm run build`: build the production bundle.
- `npm run preview`: preview a production build.
- `npm run lint`: run oxlint.
- `npm run server`: run the standalone local API + client server.
- `npm run desktop`: build, then open the Electron desktop app.
- `npm run desktop:server`: open the Electron app against an existing build.
- `npm run db:build`: headless cache builder (see below).
- `npm run db:validate`: diff the cached build evidence against a reference.

## Rebuilding the local database

The app's data lives in a JSON cache under `cache/` (there is no SQL database).
`scripts/build-database.mjs` populates it by calling the same `runKoreanScan`
the Scan button calls, but with no browser attached, so a multi-hour ladder
sweep is not tied to an open window and progress lands in stdout.

```
npm run db:build                                     # full 4-region ladder sweep
npm run db:build -- --roster                         # just the curated OTPs
npm run db:build -- --skip-scan --deepen 30 --budget 8000
npm run db:validate                                  # report + reference diff
```

Useful properties:

- **Resumable.** Match bodies are cached permanently and already-cached matches
  cost no API request, so re-running only pays for games that are genuinely new.
- **Timelines are fetched only for Irelia games.** Every aggregation
  (`buildMeta`, `buildMatchups`, `buildRecommendation`) filters to Irelia
  participants, so pulling a timeline for any other game spends budget on data
  nothing reads.
- **Budgeted.** `--budget` caps how many Riot requests a deepen pass may spend.

Watch the key: a development key expires 24 hours after it is issued, and the
100-requests-per-2-minutes limit is the real constraint on how fast a sweep runs.

## Notes

- The Riot web API is rate-limited by a local queue. The configured key allows
  100 requests per 2 minutes; `X-App-Rate-Limit` response headers are the
  authority and the queue is tuned below the documented app-wide limit.
- Live champion select is read directly from the local League Client lockfile; the Riot web API key is not used for it.
- This is a private personal tool. Riot Games is not affiliated with it.

