/**
 * Preload bridge. Deliberately minimal: the renderer needs nothing from node,
 * and the Riot API key must never be exposed here.
 *
 * The only privileged call is `setWidgetMode`, which asks the main process to
 * resize/raise the window for the compact always-on-top widget. It carries no
 * data and no node access.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('irelia', {
  desktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  setWidgetMode: (enabled) => ipcRenderer.invoke('irelia:set-widget-mode', Boolean(enabled)),
})
