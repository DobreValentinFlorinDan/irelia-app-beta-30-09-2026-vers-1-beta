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
3. Run `npm run dev` and open `http://127.0.0.1:3000/`.

Optional:

- `LEAGUE_CLIENT_LOCKFILE` — set this only if your League Client is installed somewhere other than the default Riot Games path, so the live champion-select reader can find the lockfile.

## Scripts

- `npm run dev`: start the Vite dev server with the local Riot API middleware.
- `npm run build`: build the production bundle.
- `npm run preview`: preview a production build.
- `npm run lint`: run oxlint.

## Notes

- The Riot web API is rate-limited by a local queue (under 18 requests/second and 90 per two minutes per route). Riot key and endpoint limits may differ.
- Live champion select is read directly from the local League Client lockfile; the Riot web API key is not used for it.
- This is a private personal tool. Riot Games is not affiliated with it.

