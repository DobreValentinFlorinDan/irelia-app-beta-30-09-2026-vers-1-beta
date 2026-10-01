/**
 * Standalone local API server for the desktop app.
 *
 * The Riot route handler lives in TypeScript (server/riotApi.ts). Rather than
 * adding a second build step, we use Vite's module loader to import that module
 * and mount its middleware, then serve the built client from dist/.
 *
 * Usage: node server/server.mjs
 * Env:   RIOT_API_KEY, LEAGUE_CLIENT_LOCKFILE, IRELIA_PORT, IRELIA_DEV_URL
 */
import { createServer as createHttpServer } from 'node:http'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer } from 'vite'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')
const distDir = path.join(projectRoot, 'dist')

const PORT = Number(process.env.IRELIA_PORT ?? 5273)
const HOST = '127.0.0.1'
/** When set, unmatched non-API routes proxy to the Vite dev server. */
const DEV_URL = process.env.IRELIA_DEV_URL ?? ''

/* ------------------------------------------------------------------ *
 * Environment
 * ------------------------------------------------------------------ */

/** Minimal .env.local reader so the server needs no dotenv dependency. */
function readEnvLocal() {
  const envPath = path.join(projectRoot, '.env.local')
  const values = {}
  if (!existsSync(envPath)) return values
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!match) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    values[match[1]] = value
  }
  return values
}

const fileEnv = readEnvLocal()
const apiKey = process.env.RIOT_API_KEY || fileEnv.RIOT_API_KEY || ''
const lockfilePath = process.env.LEAGUE_CLIENT_LOCKFILE || fileEnv.LEAGUE_CLIENT_LOCKFILE || ''

const options = { apiKey: apiKey || undefined, lockfilePath: lockfilePath || undefined }

/* ------------------------------------------------------------------ *
 * TypeScript module loading
 * ------------------------------------------------------------------ */

// A Vite server in middleware mode exists purely to compile and load the
// TypeScript API module. It never serves the client, so it must not watch the
// filesystem: an EBUSY on a concurrently-written temp dir would otherwise crash
// the whole API server during a scan.
const loader = await createViteServer({
  root: projectRoot,
  configFile: false,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true },
})

const riotModule = await loader.ssrLoadModule('/server/riotApi.ts')
const { createRiotApiListener, primeApiKey } = riotModule
primeApiKey?.(options.apiKey)

// Compaction is loaded lazily so an existing multi-hundred-megabyte timeline
// cache can be shrunk once without touching the Riot API.
const engineModule = await loader.ssrLoadModule('/server/buildEngine.ts')
const { compactTimelineCache } = engineModule

// handleApiRequest expects the /api prefix already stripped, matching how
// connect dispatches a `use('/api', ...)` middleware.
const apiListener = createRiotApiListener(options)
const apiMiddleware = (request, response) => {
  if (request.url?.startsWith('/api')) {
    request.url = request.url.slice('/api'.length) || '/'
  }
  apiListener(request, response)
}

/* ------------------------------------------------------------------ *
 * Static file serving
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
}

/**
 * Data Dragon supplies every item, rune, spell, and champion icon, so the
 * content policy must allow those images. Scripts stay same-origin.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: https://ddragon.leagueoflegends.com",
  "connect-src 'self' https://ddragon.leagueoflegends.com",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ')

function sendFile(response, filePath) {
  const extension = path.extname(filePath).toLowerCase()
  response.statusCode = 200
  response.setHeader('Content-Type', MIME[extension] ?? 'application/octet-stream')
  if (extension === '.html') response.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY)
  createReadStream(filePath).pipe(response)
}

/* ------------------------------------------------------------------ *
 * Server
 * ------------------------------------------------------------------ */

async function proxyToDev(request, response) {
  const target = new URL(request.url ?? '/', DEV_URL)
  const upstream = await fetch(target, {
    method: request.method,
    headers: { accept: request.headers.accept ?? '*/*' },
  })
  response.statusCode = upstream.status
  const contentType = upstream.headers.get('content-type')
  if (contentType) response.setHeader('Content-Type', contentType)
  response.end(Buffer.from(await upstream.arrayBuffer()))
}

const server = createHttpServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`)
  const pathname = url.pathname

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    apiMiddleware(request, response)
    return
  }

  // Readiness probe: the Electron shell waits for this before showing a window.
  if (pathname === '/health') {
    response.statusCode = 200
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.end(JSON.stringify({ ok: true, configured: Boolean(options.apiKey), mode: DEV_URL ? 'dev' : 'desktop' }))
    return
  }

  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const candidate = path.join(distDir, relative)

  // Guard against path traversal before touching the filesystem.
  if (candidate.startsWith(distDir) && existsSync(candidate) && statSync(candidate).isFile()) {
    sendFile(response, candidate)
    return
  }

  if (DEV_URL) {
    void proxyToDev(request, response).catch((error) => {
      response.statusCode = 502
      response.end(`Dev proxy error: ${error.message}`)
    })
    return
  }

  // SPA fallback.
  const indexPath = path.join(distDir, 'index.html')
  if (existsSync(indexPath)) {
    sendFile(response, indexPath)
    return
  }

  response.statusCode = 404
  response.setHeader('Content-Type', 'text/plain; charset=utf-8')
  response.end('Build the client first: npm run build')
})

server.listen(PORT, HOST, () => {
  console.log(`[irelia] api+client listening on http://${HOST}:${PORT}`)
  console.log(`[irelia] riot key ${options.apiKey ? 'loaded' : 'MISSING (add RIOT_API_KEY to .env.local)'}`)

  // Shrink a legacy full-timeline cache in the background; the server stays
  // responsive because compaction only reads/writes a few files at a time.
  void compactTimelineCache((message) => console.log(`[irelia] ${message}`))
    .then((trimmed) => {
      if (trimmed > 0) console.log(`[irelia] compacted ${trimmed} timelines to save disk space`)
    })
    .catch((error) => console.error('[irelia] timeline compaction failed:', error))
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    // Do not hang forever on open keep-alive sockets.
    setTimeout(() => process.exit(0), 2_000).unref()
  })
}

// A long-lived local service should survive a stray filesystem or socket error
// rather than taking the whole app down mid-scan. Readiness is polled by the
// Electron shell, so logging is enough here.
process.on('uncaughtException', (error) => {
  console.error('[irelia] uncaught exception:', error)
})
process.on('unhandledRejection', (reason) => {
  console.error('[irelia] unhandled rejection:', reason)
})
