import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, screen, session, shell, type MenuItemConstructorOptions, type OpenDialogOptions } from 'electron'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { startServer, type RunningServer } from '../server/start.ts'
import { defaultRoot } from '../server/threads/store.ts'
import { readAppPort, writeAppPort } from './app-port.ts'
import { createDockActivity, parseActivity } from './dock-activity.ts'
import { fileOnDisk, spaceRoot, spaceSchema } from '../server/files/documents.ts'
import { copyInto } from '../server/files/copy-in.ts'
import { isKnownFolder } from '../server/projects/folders.ts'
import { launchReason, visibleName } from '../server/files/visible-name.ts'
import { resolveAppPath } from './shell-path.ts'
import { oneAtATime, withinTime } from './one-at-a-time.ts'
import { createUpdateChecker, isOfficialDownload, UPDATE_CHANNEL } from './updates.ts'
import { updateDialog } from './update-dialog.ts'
import { placeWindow, readWindowState, writeWindowState } from './window-state.ts'
import { assertLocalUrl as assertLocalTarget } from '../server/http/mcp-routes.ts'
import { HELP, issueUrl } from '../server/help-links.ts'
import { createProjectFolder, type NewProject } from './new-project.ts'
import { createWindowKey, installWindowKey } from './window-key.ts'
import { debugSwitches, IS_RELEASE_BUILD } from './debug-flags.ts'
import { installCrashGuard } from './crash-guard.ts'
import type { PreviewCapture, PreviewOpen } from '../server/preview/types.ts'
import { originClass } from '../server/browser/agent-policy.ts'
import { createBrowserService, type BrowserService } from './browser-service.ts'
import { registerBrowserIpc } from './browser-ipc.ts'
import { createBrowserAgentHost } from './browser-agent-host.ts'
import { RESIDENCY } from './browser-policy.ts'
import type { BrowserHost } from '../server/browser/agent.ts'

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
let browser: BrowserService | undefined
let browserHost: BrowserHost | undefined
// Quit ends with app.exit, which skips the window's close event, so it saves the place itself.
let saveWindowPlace: (() => void) | undefined
let shutdownFinished = false
const updates = createUpdateChecker({ fetch: (input, init) => fetch(input, init) })

// An uncaught error in the server must not freeze Cockpit behind Electron's modal error dialog:
// it goes to <state>/logs/main-errors.log and Cockpit keeps running (electron/crash-guard.ts).
installCrashGuard(process, join(defaultRoot(), 'logs', 'main-errors.log'))

// A released app will not run under a debugger (electron/debug-flags.ts).
if (IS_RELEASE_BUILD && debugSwitches(process.argv).length > 0) {
  console.error(`Cockpit does not start with ${debugSwitches(process.argv).join(' ')}.`)
  process.exit(1)
}

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
  const windowKey = createWindowKey()
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
    inspectPreview,
    windowKey,
    // Created just below, once the server's ports are known; agents call it only later.
    browserHost: () => browserHost,
    ...proofInstallers(),
    ...proofPreviews(),
  })
  // Before the window loads, so its very first API call carries the key.
  installWindowKey(session.defaultSession, new URL(running.url).origin, windowKey, () => mainWindow)
  writeAppPort(portFile, running.port)
  // The Dock icon follows Cockpit's appearance (System, Light or Dark).
  dock?.setDark(nativeTheme.shouldUseDarkColors)
  nativeTheme.on('updated', () => dock?.setDark(nativeTheme.shouldUseDarkColors))
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate()))
  const isProject = (path: string): boolean => running?.projects.list().some((p) => p.path === path) ?? false
  // A project's folder, or the folder of one of its registered worktrees: where a page's files and website data live.
  const isFolder = (path: string): boolean => (running ? isKnownFolder(running.projects, running.workspaces, path) : false)
  registerIpc(running.url, join(running.store.root, 'threads'), isProject, isFolder)
  // The in-app browser (wave 9): pages live in this process, the window's page drives them.
  browser = createBrowserService({
    window: () => mainWindow,
    cockpitPorts,
    publish: (state) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('cockpit:browser-state', state) },
    inUse: (key) => running?.browserInUse(key) ?? false,
    limits: browserLimits(),
  })
  // An agent's navigation shows its page beside that conversation, without bringing the window forward.
  browserHost = createBrowserAgentHost(browser, (key, url) => {
    const threadId = key.startsWith('thread:') ? key.slice('thread:'.length) : undefined
    const projectPath = threadId ? running?.store.get(threadId)?.projectPath : undefined
    if (threadId && projectPath && /^https?:\/\//.test(url) && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('cockpit:preview-open', { url, projectPath, threadId, loaded: true })
    }
  })
  // A page that goes away takes its agent grants with it (W9-09).
  const leases = running.browserLeases
  browser.onDestroyed((key) => leases.revokePage(key))
  // A deleted conversation's page goes with it.
  const pages = browser
  running.manager.subscribe((update) => { if (update.event.kind === 'thread_deleted') pages.close(`thread:${update.threadId}`) })
  registerBrowserIpc(new URL(running.url).origin, browser, isFolder, (event) => Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents))
  mainWindow = createWindow(running.url)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && running) mainWindow = createWindow(running.url)
  })
}

/**
 * W9-10 limits. A proof build may shorten the idle time and lower the page limit, so the packaged
 * proof can watch an unload and a full house in seconds; a release build ignores both.
 */
function browserLimits(): { maxIdle: number; idleMs: number; maxTotal: number } {
  const idle = Number(process.env.COCKPIT_PROOF_BROWSER_IDLE_MS)
  const max = Number(process.env.COCKPIT_PROOF_BROWSER_MAX)
  if (IS_RELEASE_BUILD) return { ...RESIDENCY }
  return {
    ...RESIDENCY,
    ...(Number.isFinite(idle) && idle >= 1000 ? { idleMs: idle } : {}),
    ...(Number.isInteger(max) && max >= 2 && max <= RESIDENCY.maxTotal ? { maxTotal: max } : {}),
  }
}

/**
 * W10 gate. A proof build may read the official installers from local stand-ins
 * (COCKPIT_PROOF_INSTALLERS/<vendor host>.sh), so the packaged proof can drive install without the
 * network. The pinned sha256 check still applies to them; a release build ignores this.
 */
function proofInstallers(): { installerDownload?: (url: string) => Promise<Buffer> } {
  const dir = process.env.COCKPIT_PROOF_INSTALLERS
  if (IS_RELEASE_BUILD || !dir) return {}
  return { installerDownload: async (url) => readFileSync(join(dir, `${new URL(url).hostname}.sh`)) }
}

/**
 * W11 gate. A proof build may shorten how long a phone preview waits for a dev server's first
 * byte (default 60 s), so the packaged proof can watch the slow-app page; a release build ignores it.
 */
function proofPreviews(): { remote?: { previewFirstByteMs: number } } {
  const ms = Number(process.env.COCKPIT_PROOF_PREVIEW_FIRST_BYTE_MS)
  if (IS_RELEASE_BUILD || !Number.isFinite(ms) || ms < 1000) return {}
  return { remote: { previewFirstByteMs: ms } }
}

// In memory only (no "persist:"), and cleared after every capture.
const CAPTURE_PARTITION = 'cockpit-capture'

/** A local preview target that is not Cockpit itself (its own page in a frame would share the keyed window's origin). */
const cockpitPorts = (): number[] => (running ? [running.port, ...(running.remote.port() ? [running.remote.port()!] : [])] : [])
const assertLocalUrl = (url: string): string => assertLocalTarget(url, cockpitPorts())

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

/**
 * open_preview: a conversation's preview opens in that conversation's own page (W9-11), loaded
 * here so it exists even while the person looks at another conversation; the window then shows
 * it beside the chat. The page remains the source of truth for pane layout.
 */
async function showPreview(preview: PreviewOpen): Promise<void> {
  const url = assertLocalUrl(preview.url)
  if (preview.threadId && browser && browserHost) {
    const key = `thread:${preview.threadId}`
    const page = await browserHost.ensure(key, preview.cwd ?? preview.projectPath)
    if (page.url !== url) {
      const refused = browser.load(key, url)
      if (refused) throw new Error(refused)
    }
    sendToPage('cockpit:preview-open', { ...preview, url, loaded: true })
    return
  }
  sendToPage('cockpit:preview-open', { ...preview, url })
}

/**
 * inspect_preview: an image of the conversation's own page (W9-11), not of a fresh copy. A page
 * already on that local app is captured as it is; otherwise it is opened there first. A preview
 * that ends up on a remote site is not captured: that needs browser_screenshot and its approval.
 */
async function inspectPreview(preview: PreviewOpen): Promise<PreviewCapture> {
  const url = assertLocalUrl(preview.url)
  if (!preview.threadId || !browserHost) return capturePreview(url)
  const key = `thread:${preview.threadId}`
  const page = await browserHost.ensure(key, preview.cwd ?? preview.projectPath)
  if (page.origin !== new URL(url).origin) await browserHost.goto(key, url)
  const shot = await browserHost.capture(key)
  if (originClass(shot.page.url, cockpitPorts()) !== 'local') {
    throw new Error(`The preview is now on ${shot.page.origin}, not your local app. Use browser_screenshot for other sites; it asks you first.`)
  }
  return { data: shot.data, mimeType: shot.mimeType, width: shot.width, height: shot.height, page: { pageId: shot.page.pageId, revision: shot.page.revision, url: shot.page.url } }
}

/**
 * Render the same local URL in an isolated, hidden Chromium window so an agent receives the
 * preview itself—not a screenshot of Cockpit chrome. The window is short-lived and has no Node API.
 */
// Captures share one in-memory session that is cleared after each, so they run one at a time:
// a capture finishing must not clear the storage of another still loading. Each load has a time
// limit, so one page that never finishes cannot stall every capture after it.
const CAPTURE_LOAD_MS = 15_000
const capturePreview = oneAtATime(captureOne)

async function captureOne(url: string): Promise<{ data: string; mimeType: 'image/png'; width: number; height: number }> {
  const target = assertLocalUrl(url)
  const preview = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    useContentSize: true,
    backgroundColor: '#ffffff',
    // Its own in-memory session: no cookies or storage shared with Cockpit's window or with other
    // local apps you have opened, so an agent cannot screenshot a page as you are signed in to it.
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, partition: CAPTURE_PARTITION },
  })
  preview.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  preview.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  const stayLocal = (event: { preventDefault(): void }, next: string): void => {
    try { assertLocalUrl(next) } catch { event.preventDefault() }
  }
  preview.webContents.on('will-redirect', stayLocal)
  // The page cannot navigate itself to a remote site during the capture either.
  preview.webContents.on('will-navigate', stayLocal)
  preview.webContents.on('will-frame-navigate', (details) => { if (!details.isMainFrame) stayLocal(details, details.url) })
  try {
    await withinTime(preview.loadURL(target), CAPTURE_LOAD_MS, `The preview did not finish loading within ${CAPTURE_LOAD_MS / 1000} s`,
      () => { if (!preview.isDestroyed()) preview.webContents.stop() })
    await new Promise((resolve) => setTimeout(resolve, 250))
    // capturePage returns physical pixels on Retina displays. Normalise the tool payload so
    // agents get a predictable, detailed image without a needlessly large base64 response.
    const image = (await preview.webContents.capturePage()).resize({ width: 1280, height: 800, quality: 'best' })
    const size = image.getSize()
    return { data: image.toPNG().toString('base64'), mimeType: 'image/png', width: size.width, height: size.height }
  } finally {
    const capture = preview.webContents.session
    if (!preview.isDestroyed()) preview.destroy()
    await capture.clearStorageData().catch(() => undefined)
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
  win.on('closed', () => browser?.forgetAll())
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
const dockLook = (dir: string) => ({
  frames: Array.from({ length: 8 }, (_, i) => dockFrames(`${dir}frame-${i}`)).filter((image) => !image.isEmpty()),
  rest: dockFrames(`${dir}rest`),
})
const darkDock = dockLook('dark/')
const dock = process.platform === 'darwin' ? createDockActivity({
  ...dockLook(''),
  dark: darkDock.rest.isEmpty() ? undefined : darkDock,
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

function registerIpc(url: string, threadsDir: string, isProject: (path: string) => boolean, isFolder: (path: string) => boolean): void {
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
  // Open in the default app, show in Finder, or move to the Trash: one file of a known project,
  // in its folder or in the project's documents. Resolves to an error message, or undefined.
  ipcMain.handle('cockpit:file-action', async (event, request: unknown) => {
    if (!event.senderFrame || new URL(event.senderFrame.url).origin !== origin || !running) return 'Not allowed'
    const { projectPath, space, path, action } = (request ?? {}) as Record<string, unknown>
    if (typeof projectPath !== 'string' || typeof path !== 'string') return 'Unknown project'
    const where = spaceSchema.safeParse(space ?? undefined)
    if (!where.success) return 'Unknown project'
    // Documents belong to the project itself; project files may be in one of its registered worktrees.
    if (!(where.data === 'documents' ? isProject(projectPath) : isFolder(projectPath))) return 'Unknown project'
    if (action !== 'open' && action !== 'reveal' && action !== 'trash') return 'Unknown action'
    try {
      const target = fileOnDisk(running.store.root, projectPath, where.data, path)
      if (action === 'reveal') shell.showItemInFolder(target)
      else if (action === 'open') {
        // A repository can carry a script or app named to look like a document. Opening one runs it,
        // outside any agent approval, so the real name and what it can do are shown first.
        const reason = launchReason(target, statSync(target).mode)
        if (reason) {
          const win = BrowserWindow.fromWebContents(event.sender)
          const options = { type: 'warning' as const, buttons: ['Cancel', 'Open'], defaultId: 0, cancelId: 0,
            message: `Open “${visibleName(basename(target))}”?`,
            detail: `Opening it may run a program on your Mac: ${reason}. Open it only if you trust where it came from.` }
          const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
          if (response !== 1) return undefined
        }
        const failure = await shell.openPath(target)
        if (failure) return failure
      }
      else await shell.trashItem(target)
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  })
  // Files dropped on the Files explorer: copied (never moved, never over a file) into a folder of
  // a known project or its documents. The paths come from the drop, through the preload.
  ipcMain.handle('cockpit:copy-into', async (event, request: unknown) => {
    if (!event.senderFrame || new URL(event.senderFrame.url).origin !== origin || !running) return { error: 'Not allowed' }
    const { projectPath, space, folder, sources } = (request ?? {}) as Record<string, unknown>
    if (typeof projectPath !== 'string') return { error: 'Unknown project' }
    const where = spaceSchema.safeParse(space ?? undefined)
    if (!where.success || !(where.data === 'documents' ? isProject(projectPath) : isFolder(projectPath))) return { error: 'Unknown project' }
    if (typeof folder !== 'string' || !Array.isArray(sources) || sources.length > 100 || !sources.every((s) => typeof s === 'string')) return { error: 'Nothing to copy' }
    try {
      return copyInto(spaceRoot(running.store.root, projectPath, where.data), folder, sources as string[])
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
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
