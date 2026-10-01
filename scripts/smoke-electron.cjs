/**
 * Headless smoke test for the Build Calculator tab.
 *
 * Loads the built app from the local API server, forces the calculator view,
 * waits for the kit fetch + optimisation to settle, captures any console
 * errors and a screenshot, then exits. Not part of the normal app flow.
 *
 * Usage: node scripts/smoke-electron.cjs [url]
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const target = process.argv[2] || 'http://127.0.0.1:5273/'
const shotPath = path.join(process.cwd(), 'cache', 'scans', 'calculator-smoke.png')

const errors = []
const logs = []

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1440,
    height: 2400,
    show: false,
    webPreferences: { offscreen: true },
  })

  win.webContents.on('console-message', (_event, level, message) => {
    const text = String(message)
    if (level >= 2) errors.push(text)
    logs.push(text)
  })

  await win.loadURL(target)

  // Jump straight to the calculator tab and let it settle.
  await win.webContents.executeJavaScript(`
    localStorage.setItem('irelia-fieldbook-view-v4', JSON.stringify('calculator'));
    location.reload();
    true;
  `)

  await new Promise((resolve) => setTimeout(resolve, 9000))

  const state = await win.webContents.executeJavaScript(`(() => {
    const nav = [...document.querySelectorAll('.nav-button')].map((b) => b.textContent.trim());
    const cards = document.querySelectorAll('.calc-build').length;
    const items = [...document.querySelectorAll('.calc-build:first-of-type .calc-item-name')].map((e) => e.textContent);
    const hero = document.querySelector('.build-hero-copy h1')?.textContent ?? '';
    const errorStrip = document.querySelector('.error-strip')?.textContent ?? '';
    return { nav, cards, items, hero, errorStrip };
  })()`)

  const image = await win.webContents.capturePage()
  fs.writeFileSync(shotPath, image.toPNG())

  console.log('STATE ' + JSON.stringify(state))
  console.log('ERRORS ' + JSON.stringify(errors.slice(0, 10)))
  console.log('SCREENSHOT ' + shotPath)

  app.exit(state.cards > 0 && !state.errorStrip ? 0 : 1)
})
