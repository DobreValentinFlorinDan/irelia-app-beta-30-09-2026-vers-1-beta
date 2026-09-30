import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { createRiotApiPlugin } from './server/riotApi.js'

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react(), createRiotApiPlugin({
      apiKey: environment.RIOT_API_KEY,
      lockfilePath: environment.LEAGUE_CLIENT_LOCKFILE,
    })],
    server: {
      host: '127.0.0.1',
    },
  }
})
