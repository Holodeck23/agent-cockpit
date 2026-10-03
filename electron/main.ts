import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, screen, shell, type MenuItemConstructorOptions, type OpenDialogOptions } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { startServer, type RunningServer } from '../server/start.ts'
import { defaultRoot } from '../server/threads/store.ts'
import { readAppPort, writeAppPort } from './app-port.ts'
import { createDockActivity, parseActivity } from './dock-activity.ts'
import { fileOnDisk, spaceSchema } from '../server/files/documents.ts'
import { resolveAppPath } from './shell-path.ts'
import { createUpdateChecker, isOfficialDownload, UPDATE_CHANNEL } from './updates.ts'
import { updateDialog } from './update-dialog.ts'
import { placeWindow, readWindowState, writeWindowState } from './window-state.ts'
import { assertLocalUrl } from '../server/http/mcp-routes.ts'
import { HELP, issueUrl } from '../server/help-links.ts'
import { createProjectFolder, type NewProject } from './new-project.ts'

// The desktop app is the same loopback server as `npm start`, on a random port,
// with a native window around it. The page talks to the server over HTTP/SSE
// exactly as in a browser; the preload adds only a folder picker.

// Keep in step with --canvas-app in web/src/styles/tokens.css so the window never flashes.
const CANVAS = { light: '#fafaf9', dark: '#202020' }
// Longer than both stop ladders — agents: EOF → SIGTERM → SIGKILL (2 × 1.5s); project
// processes: group SIGTERM → SIGKILL (3s) — so nothing hung is orphaned.
const SHUTDOWN_GRACE_MS = 5000
const WINDOW = { width: 1360, height: 860, minWidth: 980, minHeight: 640 }
const isDev = !app.isPackaged

let running: RunningServer | undefined
let mainWindow: BrowserWindow | undefined
// Quit ends with app.exit, which skips the window's close event, so it saves the place itself.
let saveWindowPlace: (() => void) | undefined
let shutdownFinished = false
const updates = createUpdateChecker({ fetch: (input, init) => fetch(input, init) })

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
    openUrl: showPreview,
    capturePreview,
  })
  writeAppPort(portFile, running.port)
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate()))
  registerIpc(running.url, join(running.store.root, 'threads'), (path) => running?.projects.list().some((p) => p.path === path) ?? false)
  mainWindow = createWindow(running.url)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && running) mainWindow = createWindow(running.url)
  })
}

/** Sends an event to the page, reopening the window first if it was closed. */
function sendToPage(channel: string, ...args: unknown[]): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (!running) return
    mainWindow = createWindow(running.url)
    const reopened = mainWindow
    reopened.webContents.once('did-finish-load', () => {
      if (!reopened.isDestroyed()) reopened.webContents.send(channel, ...args)
    })
    return
  }
  mainWindow.webContents.send(channel, ...args)
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
}

/** Opens the local URL in the React-owned pane. The page remains the source of truth for pane layout. */
function showPreview(url: string): void {
  sendToPage('cockpit:preview-open', assertLocalUrl(url))
}

/**
 * Render the same local URL in an isolated, hidden Chromium window so an agent receives the
 * preview itself—not a screenshot of Cockpit chrome. The window is short-lived and has no Node API.
 */
async function capturePreview(url: string): Promise<{ data: string; mimeType: 'image/png'; width: number; height: number }> {
  const target = assertLocalUrl(url)
  const preview = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    useContentSize: true,
    backgroundColor: '#ffffff',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  preview.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  preview.webContents.on('will-redirect', (event, next) => {
    try { assertLocalUrl(next) } catch { event.preventDefault() }
  })
  try {
    await preview.loadURL(target)
    await new Promise((resolve) => setTimeout(resolve, 250))
    // capturePage returns physical pixels on Retina displays. Normalise the tool payload so
    // agents get a predictable, detailed image without a needlessly large base64 response.
    const image = (await preview.webContents.capturePage()).resize({ width: 1280, height: 800, quality: 'best' })
    const size = image.getSize()
    return { data: image.toPNG().toString('base64'), mimeType: 'image/png', width: size.width, height: size.height }
  } finally {
    if (!preview.isDestroyed()) preview.destroy()
  }
}

function createWindow(url: string): BrowserWindow {
  // In the Electron profile, so a separate COCKPIT_HOME (the proofs) keeps its own.
  const stateFile = join(app.getPath('userData'), 'window-state.json')
  const place = placeWindow(readWindowState(stateFile), screen.getAllDisplays().map((d) => d.workArea), WINDOW)
  const win = new BrowserWindow({
    ...place.bounds,
    minWidth: WINDOW.minWidth,
    minHeight: WINDOW.minHeight,
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
  // A preview iframe may navigate within the local app, but it cannot turn the embedded pane
  // into an arbitrary remote browser surface. Remote links can still use target=_blank, which
  // the handler above sends to the person's default browser.
  win.webContents.on('will-frame-navigate', (details) => {
    if (details.isMainFrame) return
    try { assertLocalUrl(details.url) } catch { details.preventDefault() }
  })
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))

  // Cockpit's own page never vetoes unloading. A previewed app's beforeunload must not either:
  // it silently cancelled Quit, leaving Cockpit running with its window gone.
  win.webContents.on('will-prevent-unload', (event) => event.preventDefault())
  // Normal bounds, so a maximised or full-screen window still remembers its own size.
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  const saveState = (): void => {
    clearTimeout(saveTimer)
    if (win.isDestroyed()) return
    writeWindowState(stateFile, { ...win.getNormalBounds(), maximized: win.isMaximized() })
  }
  const saveSoon = (): void => { clearTimeout(saveTimer); saveTimer = setTimeout(saveState, 400) }
  win.on('resize', saveSoon)
  win.on('move', saveSoon)
  win.on('maximize', saveSoon)
  win.on('unmaximize', saveSoon)
  win.on('close', saveState)
  // The page drops the room it keeps for the window buttons while they are hidden.
  const sendFullScreen = (): void => { if (!win.isDestroyed()) win.webContents.send('cockpit:full-screen', win.isFullScreen()) }
  win.on('enter-full-screen', sendFullScreen)
  win.on('leave-full-screen', sendFullScreen)
  win.webContents.on('did-finish-load', sendFullScreen)
  saveWindowPlace = saveState
  win.once('ready-to-show', () => {
    if (place.maximized) win.maximize()
    win.show()
  })
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

// Shown notifications stay referenced until clicked or closed; a collected one loses its click.
const shownNotifications = new Set<Notification>()

/** A notification for one conversation; clicking it brings Cockpit forward and opens that conversation. */
function showNotification(value: unknown): void {
  const { threadId, title, body } = (value ?? {}) as Record<string, unknown>
  if (typeof threadId !== 'string' || !/^[\w-]{1,80}$/.test(threadId) || typeof title !== 'string' || typeof body !== 'string') return
  if (!Notification.isSupported()) return
  const note = new Notification({ title: title.slice(0, 120), body: body.slice(0, 240), silent: true })
  const release = (): void => { shownNotifications.delete(note) }
  note.on('click', () => {
    release()
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send('cockpit:open-thread', threadId)
  })
  note.on('close', release)
  shownNotifications.add(note)
  if (shownNotifications.size > 20) shownNotifications.delete(shownNotifications.values().next().value!)
  note.show()
}

function registerIpc(url: string, threadsDir: string, isProject: (path: string) => boolean): void {
  const origin = new URL(url).origin
  // Copy message: the system clipboard, which (unlike the web API) does not need window focus.
  ipcMain.on('cockpit:copy-text', (event, text: unknown) => {
    if (!event.senderFrame || new URL(event.senderFrame.url).origin !== origin) return
    if (typeof text === 'string' && text.length <= 2_000_000) clipboard.writeText(text)
  })
  ipcMain.on('cockpit:notify', (event, value: unknown) => {
    if (!event.senderFrame || new URL(event.senderFrame.url).origin !== origin) return
    showNotification(value)
  })
  ipcMain.on('cockpit:activity', (event, value: unknown) => {
    if (!event.senderFrame || new URL(event.senderFrame.url).origin !== origin) return
    const activity = parseActivity(value)
    if (activity) dock?.update(activity)
  })
  ipcMain.on('cockpit:set-theme', (event, mode: unknown) => {
    if (!event.senderFrame || new URL(event.senderFrame.url).origin !== origin) return
    if (mode === 'system' || mode === 'light' || mode === 'dark') nativeTheme.themeSource = mode
  })
  ipcMain.on('cockpit:open-preview', (event, target: unknown) => {
    if (!event.senderFrame || new URL(event.senderFrame.url).origin !== origin || typeof target !== 'string') return
    try { showPreview(target) } catch { /* The server remains the authority for preview URLs. */ }
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
  ipcMain.handle('cockpit:app-version', (event) => {
    if (!event.senderFrame || new URL(event.senderFrame.url).origin !== origin) return undefined
    return app.getVersion()
  })
  // Help → Release Notes: this version's notes from the same (cached) feed as Check for Updates.
  ipcMain.handle('cockpit:release-notes', async (event) => {
    if (!event.senderFrame || new URL(event.senderFrame.url).origin !== origin) return { state: 'unavailable', reason: 'Not allowed' }
    return updates.notes(app.getVersion())
  })
  // Projects → New Project…: name and location in the native Save panel, starting beside the
  // active project. Resolves to the new folder, an error message, or undefined if cancelled.
  ipcMain.handle('cockpit:new-project', async (event, near: unknown): Promise<NewProject | undefined> => {
    if (!event.senderFrame || new URL(event.senderFrame.url).origin !== origin) return undefined
    const location = typeof near === 'string' && isProject(near) ? dirname(near) : app.getPath('documents')
    const options = {
      title: 'New Project',
      message: 'Name the project and choose where its folder goes.',
      nameFieldLabel: 'Project name:',
      buttonLabel: 'Create',
      defaultPath: join(location, 'New Project'),
      showsTagField: false,
      properties: ['createDirectory'] as Array<'createDirectory'>,
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return undefined
    return createProjectFolder(result.filePath)
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
  // The standard macOS app menu (what role: 'appMenu' builds), plus Check for Updates….
  const appMenu: MenuItemConstructorOptions[] = [
    { role: 'about' },
    { label: 'Check for Updates…', click: () => void checkForUpdates() },
    { type: 'separator' },
    { role: 'services' },
    { type: 'separator' },
    { role: 'hide' },
    { role: 'hideOthers' },
    { role: 'unhide' },
    { type: 'separator' },
    { role: 'quit' },
  ]
  const open = (url: string) => () => void shell.openExternal(url)
  const help: MenuItemConstructorOptions[] = [
    { label: 'Cockpit Guide', click: open(HELP.guide) },
    { label: 'Release Notes', click: () => sendToPage('cockpit:show-release-notes') },
    { label: 'Troubleshooting', click: open(HELP.troubleshooting) },
    { type: 'separator' },
    { label: 'Report a Problem…', click: () => void shell.openExternal(issueUrl({ version: app.getVersion(), macos: process.getSystemVersion(), arch: process.arch })) },
  ]
  return [{ label: app.name, submenu: appMenu }, { role: 'editMenu' }, { label: 'View', submenu: view }, { role: 'windowMenu' }, { role: 'help', submenu: help }]
}

/**
 * User-initiated only. Shows the outcome natively; Download Update opens the official DMG in
 * the browser. Replacing the app stays manual, so running agents are never stopped from here.
 */
async function checkForUpdates(): Promise<void> {
  const content = updateDialog(await updates.check(app.getVersion(), UPDATE_CHANNEL))
  const options = {
    type: content.type,
    message: content.message,
    detail: content.detail,
    buttons: [...content.buttons],
    defaultId: 0,
    cancelId: content.helpUrl ? 0 : content.buttons.length - 1,
    noLink: true,
  }
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
  if (response === 0 && content.downloadUrl && isOfficialDownload(content.downloadUrl)) await shell.openExternal(content.downloadUrl)
  if (response === 1 && content.helpUrl) await shell.openExternal(content.helpUrl)
}

// macOS convention: closing the window keeps the app (and running agents) alive;
// quitting stops every agent session before the process exits.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  dock?.stop()
  saveWindowPlace?.()
  if (shutdownFinished || !running) return
  event.preventDefault()
  const server = running
  const grace = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS))
  void Promise.race([server.close(), grace]).finally(() => {
    shutdownFinished = true
    // Agents and servers are stopped: exit outright. A second app.quit() asks every window
    // again, and anything that refuses then leaves a windowless Cockpit running.
    app.exit(0)
  })
})
