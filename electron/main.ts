import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell, type MenuItemConstructorOptions, type OpenDialogOptions } from 'electron'
import { existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { startServer, type RunningServer } from '../server/start.ts'
import { defaultRoot } from '../server/threads/store.ts'
import { readAppPort, writeAppPort } from './app-port.ts'
import { createDockActivity, parseActivity } from './dock-activity.ts'
import { fileOnDisk, spaceSchema } from '../server/files/documents.ts'
import { resolveAppPath } from './shell-path.ts'

// The desktop app is the same loopback server as `npm start`, on a random port,
// with a native window around it. The page talks to the server over HTTP/SSE
// exactly as in a browser; the preload adds only a folder picker.

// Keep in step with --canvas-app in web/src/styles/tokens.css so the window never flashes.
const CANVAS = { light: '#fafaf9', dark: '#202020' }
// Longer than both stop ladders — agents: EOF → SIGTERM → SIGKILL (2 × 1.5s); project
// processes: group SIGTERM → SIGKILL (3s) — so nothing hung is orphaned.
const SHUTDOWN_GRACE_MS = 5000
const isDev = !app.isPackaged

let running: RunningServer | undefined
let mainWindow: BrowserWindow | undefined
let shutdownFinished = false

// A separate state folder is a separate cockpit: give it its own Electron profile, so
// the single-instance lock (and window state) never collide with the installed app.
if (process.env.COCKPIT_HOME) app.setPath('userData', join(process.env.COCKPIT_HOME, 'electron'))

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  process.env.PATH = resolveAppPath().path
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  app.whenReady().then(boot).catch((error: unknown) => {
    dialog.showErrorBox('Cockpit could not start', error instanceof Error ? error.message : String(error))
    app.exit(1)
  })
}

async function boot(): Promise<void> {
  const portFile = join(defaultRoot(), 'app-port')
  running = await startServer({
    port: 0,
    preferredPort: readAppPort(portFile),
    webDist: join(app.getAppPath(), 'dist'),
    // Each agent session spawns the cockpit MCP server with this app's own binary in
    // plain-Node mode, so it works from Finder with no Node on PATH (and reads from app.asar).
    mcp: {
      command: process.execPath,
      args: [join(app.getAppPath(), 'dist-electron', 'mcp.cjs')],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    },
    // Late-bound so the preview target can be swapped (Phase 7 pane, or a proof stub).
    openUrl: (url) => shell.openExternal(url),
  })
  writeAppPort(portFile, running.port)
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate()))
  registerIpc(running.url, join(running.store.root, 'threads'), (path) => running?.projects.list().some((p) => p.path === path) ?? false)
  mainWindow = createWindow(running.url)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && running) mainWindow = createWindow(running.url)
  })
}

function createWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: 'Cockpit',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? CANVAS.dark : CANVAS.light,
    webPreferences: {
      preload: join(app.getAppPath(), 'dist-electron', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  // Anything that is not the cockpit page opens in the default browser, never in-app.
  const origin = new URL(url).origin
  const openOutside = (target: string): void => {
    if (/^https?:\/\//.test(target)) void shell.openExternal(target)
  }
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    openOutside(target)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin === origin) return
    event.preventDefault()
    openOutside(target)
  })
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))

  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = undefined
  })
  void win.loadURL(url)
  return win
}

// Calls go through app.dock each time (not a saved reference), so the proofs can watch them.
const dockFrames = (name: string) => nativeImage.createFromPath(join(__dirname, 'dock', `${name}.png`))
const dock = process.platform === 'darwin' ? createDockActivity({
  frames: Array.from({ length: 8 }, (_, i) => dockFrames(`frame-${i}`)).filter((image) => !image.isEmpty()),
  rest: dockFrames('rest'),
  setIcon: (image) => app.dock?.setIcon(image),
  setBadge: (text) => app.dock?.setBadge(text),
  setInterval: (run, ms) => setInterval(run, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}) : undefined

function registerIpc(url: string, threadsDir: string, isProject: (path: string) => boolean): void {
  const origin = new URL(url).origin
  ipcMain.on('cockpit:activity', (event, value: unknown) => {
    if (!event.senderFrame || new URL(event.senderFrame.url).origin !== origin) return
    const activity = parseActivity(value)
    if (activity) dock?.update(activity)
  })
  ipcMain.on('cockpit:set-theme', (event, mode: unknown) => {
    if (!event.senderFrame || new URL(event.senderFrame.url).origin !== origin) return
    if (mode === 'system' || mode === 'light' || mode === 'dark') nativeTheme.themeSource = mode
  })
  // Open in the default app, show in Finder, or move to the Trash: one file of a known project,
  // in its folder or in the project's documents. Resolves to an error message, or undefined.
  ipcMain.handle('cockpit:file-action', async (event, request: unknown) => {
    if (!event.senderFrame || new URL(event.senderFrame.url).origin !== origin || !running) return 'Not allowed'
    const { projectPath, space, path, action } = (request ?? {}) as Record<string, unknown>
    if (typeof projectPath !== 'string' || typeof path !== 'string' || !isProject(projectPath)) return 'Unknown project'
    if (action !== 'open' && action !== 'reveal' && action !== 'trash') return 'Unknown action'
    try {
      const target = fileOnDisk(running.store.root, projectPath, spaceSchema.parse(space ?? undefined), path)
      if (action === 'reveal') shell.showItemInFolder(target)
      else if (action === 'open') { const failure = await shell.openPath(target); if (failure) return failure }
      else await shell.trashItem(target)
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  })
  // Opens a project's folder in Finder; only folders Cockpit already lists as projects.
  ipcMain.on('cockpit:open-folder', (event, path: unknown) => {
    if (!event.senderFrame || new URL(event.senderFrame.url).origin !== origin || typeof path !== 'string') return
    if (isProject(path) && existsSync(path)) void shell.openPath(path)
  })
  ipcMain.on('cockpit:reveal-transcript', (event, path: unknown) => {
    if (!event.senderFrame || new URL(event.senderFrame.url).origin !== origin || typeof path !== 'string') return
    const target = resolve(path)
    if (target.startsWith(`${resolve(threadsDir)}${sep}`) && target.endsWith(`${sep}messages.md`) && existsSync(target)) {
      shell.showItemInFolder(target)
    }
  })
  ipcMain.handle('cockpit:pick-folder', async (event) => {
    if (!event.senderFrame || new URL(event.senderFrame.url).origin !== origin) return undefined
    const options: OpenDialogOptions = { title: 'Choose a project folder', properties: ['openDirectory', 'createDirectory'] }
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled ? undefined : result.filePaths[0]
  })
}

function menuTemplate(): MenuItemConstructorOptions[] {
  const view: MenuItemConstructorOptions[] = [
    { role: 'reload' },
    ...(isDev ? ([{ role: 'toggleDevTools' }] as const) : []),
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ]
  return [{ role: 'appMenu' }, { role: 'editMenu' }, { label: 'View', submenu: view }, { role: 'windowMenu' }]
}

// macOS convention: closing the window keeps the app (and running agents) alive;
// quitting stops every agent session before the process exits.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  dock?.stop()
  if (shutdownFinished || !running) return
  event.preventDefault()
  const server = running
  const grace = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS))
  void Promise.race([server.close(), grace]).finally(() => {
    shutdownFinished = true
    app.quit()
  })
})
