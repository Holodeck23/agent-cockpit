import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell, type MenuItemConstructorOptions, type OpenDialogOptions } from 'electron'
import { join } from 'node:path'
import { startServer, type RunningServer } from '../server/start.ts'
import { resolveAppPath } from './shell-path.ts'

// The desktop app is the same loopback server as `npm start`, on a random port,
// with a native window around it. The page talks to the server over HTTP/SSE
// exactly as in a browser; the preload adds only a folder picker.

// Keep in step with --canvas-app in web/src/styles/tokens.css so the window never flashes.
const CANVAS = { light: '#fafaf9', dark: '#202020' }
// Longer than stopChild's EOF → SIGTERM → SIGKILL ladder (2 × 1.5s), so a hung agent is killed, not orphaned.
const SHUTDOWN_GRACE_MS = 4000
const isDev = !app.isPackaged

let running: RunningServer | undefined
let mainWindow: BrowserWindow | undefined
let shutdownFinished = false

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
  running = await startServer({ port: 0, webDist: join(app.getAppPath(), 'dist') })
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate()))
  registerIpc(running.url)
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

function registerIpc(url: string): void {
  const origin = new URL(url).origin
  ipcMain.on('cockpit:set-theme', (event, mode: unknown) => {
    if (!event.senderFrame || new URL(event.senderFrame.url).origin !== origin) return
    if (mode === 'system' || mode === 'light' || mode === 'dark') nativeTheme.themeSource = mode
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
  if (shutdownFinished || !running) return
  event.preventDefault()
  const server = running
  const grace = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS))
  void Promise.race([server.close(), grace]).finally(() => {
    shutdownFinished = true
    app.quit()
  })
})
