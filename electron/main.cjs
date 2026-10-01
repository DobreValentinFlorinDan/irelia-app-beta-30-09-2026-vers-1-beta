/**
 * Electron main process for the Irelia desktop app.
 *
 * Security posture:
 *  - contextIsolation on, nodeIntegration off, sandbox on
 *  - the Riot API key never leaves this process / the local server
 *  - the renderer only ever talks to 127.0.0.1 over HTTP
 */
const { app, BrowserWindow, shell, dialog, ipcMain } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const PORT = Number(process.env.IRELIA_PORT || 5273)
const HOST = '127.0.0.1'
const BASE_URL = `http://${HOST}:${PORT}`

/**
 * ELECTRON_RUN_AS_NODE makes Electron behave as plain node, which would strip
 * the whole `electron` API (app, BrowserWindow, ...) from this process.
 *
 * Some launchers — including Electron-based tooling that shells out — export it
 * globally, so a normal `electron .` from such a terminal would die on
 * `app.whenReady` being undefined. If we got far enough to execute this file,
 * we are a real Electron main process, so the variable is wrong by definition.
 */
if (process.env.ELECTRON_RUN_AS_NODE && process.versions.electron) {
  delete process.env.ELECTRON_RUN_AS_NODE
}

/**
 * Set --dev (npm run desktop:dev) to load the Vite dev server instead of the
 * built bundle. The dev server is expected on 127.0.0.1:3000.
 */
const DEV_URL = process.env.IRELIA_DEV_URL
  || (process.argv.includes('--dev') ? 'http://127.0.0.1:3000' : '')
const IS_DEV = Boolean(DEV_URL)

let serverProcess = null
let mainWindow = null

/** Polls the local server until it reports healthy, or times out. */
async function waitForServer(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/health`)
      if (response.ok) return await response.json()
    } catch {
      // Server not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Local server did not become healthy within ${timeoutMs}ms`)
}

function startServer() {
  const serverEntry = path.join(__dirname, '..', 'server', 'server.mjs')

  // The server must run as plain node. ELECTRON_RUN_AS_NODE makes the bundled
  // Electron binary behave as node, so the app needs no system node install.
  // It must be stripped from any inherited environment first, otherwise the
  // child keeps the flag and the GUI process inherits it too.
  const childEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  delete childEnv.ELECTRON_NO_ATTACH_CONSOLE

  const child = spawn(process.execPath, [serverEntry], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...childEnv,
      IRELIA_PORT: String(PORT),
      IRELIA_DEV_URL: DEV_URL,
    },
    // The harness sandbox cannot capture a child's piped stdio; inherit so the
    // server logs land in the terminal running Electron.
    stdio: 'inherit',
    windowsHide: true,
  })

  child.on('error', (error) => {
    dialog.showErrorBox('Irelia server failed to start', String(error))
  })
  child.on('exit', (code) => {
    if (code !== 0 && code !== null && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox('Irelia server stopped', `The local API server exited with code ${code}.`)
    }
  })
  return child
}

const WIDGET_BOUNDS = { width: 400, height: 700, minWidth: 320, minHeight: 480 }
const FULL_BOUNDS = { width: 1_500, height: 1_000, minWidth: 1_100, minHeight: 760 }

let widgetMode = false

/**
 * Widget mode: a compact always-on-top window the player keeps visible during
 * champ select. The renderer asks to enter/leave it when the Widget view is
 * mounted/unmounted. Keeping the native frame (rather than going frameless)
 * means the window stays draggable and closable with no custom chrome.
 */
ipcMain.handle('irelia:set-widget-mode', (_event, enabled) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false }
  widgetMode = Boolean(enabled)
  if (widgetMode) {
    mainWindow.setMinimumSize(WIDGET_BOUNDS.minWidth, WIDGET_BOUNDS.minHeight)
    mainWindow.setSize(WIDGET_BOUNDS.width, WIDGET_BOUNDS.height)
    mainWindow.setAlwaysOnTop(true, 'floating')
  } else {
    mainWindow.setAlwaysOnTop(false)
    mainWindow.setMinimumSize(FULL_BOUNDS.minWidth, FULL_BOUNDS.minHeight)
    mainWindow.setSize(FULL_BOUNDS.width, FULL_BOUNDS.height)
  }
  return { ok: true, widgetMode }
})

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1_500,
    height: 1_000,
    minWidth: 1_100,
    minHeight: 760,
    backgroundColor: '#0b0f14',
    show: false,
    autoHideMenuBar: true,
    title: 'Irelia Build Tracker',
    icon: path.join(__dirname, 'irelia.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())

  // External links open in the system browser, never inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const target = IS_DEV ? DEV_URL : BASE_URL
  void mainWindow.loadURL(target)
  return mainWindow
}

// Taskbar identity: gives the window the app's icon on the taskbar instead of
// the generic Electron icon, and keeps its windows grouped under one entry.
if (process.platform === 'win32') {
  app.setAppUserModelId('IreliaFieldbook')
}

app.whenReady().then(async () => {
  serverProcess = startServer()

  let health = null
  try {
    health = await waitForServer()
  } catch (error) {
    dialog.showErrorBox(
      'Irelia startup problem',
      `${error.message}\n\nTry running: npm run dev`,
    )
  }

  if (health && health.configured === false) {
    dialog.showMessageBox({
      type: 'warning',
      title: 'Riot API key missing',
      message: 'No RIOT_API_KEY was found.',
      detail: 'Add RIOT_API_KEY to .env.local in the project root, then restart the app.',
    })
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill()
    serverProcess = null
  }
})

// Surface renderer crashes instead of failing silently.
app.on('render-process-gone', (_event, _contents, details) => {
  if (details && details.reason && details.reason !== 'clean-exit') {
    dialog.showErrorBox('Renderer stopped', `Reason: ${details.reason}`)
  }
})

// Guard the packaged app against a missing build.
if (!IS_DEV) {
  const indexPath = path.join(__dirname, '..', 'dist', 'index.html')
  if (!fs.existsSync(indexPath)) {
    app.whenReady().then(() => {
      dialog.showErrorBox(
        'Client bundle missing',
        'dist/index.html was not found. Run "npm run build" first, or start with npm run desktop:dev.',
      )
    })
  }
}
