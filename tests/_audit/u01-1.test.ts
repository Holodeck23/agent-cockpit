import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

// u01-1: main pushes an event to a window it just reopened (open_preview, Help > Release Notes,
// a notification click) on 'did-finish-load'. The page is "loaded" long before React mounts and
// subscribes (it awaits the server and the beta terms first), and Electron drops an event that
// finds no ipcRenderer listener. So the page must hold what main sent until it subscribes.
// Main and preload run for real against a fake Electron; the fake page drops what has no listener.

const h = vi.hoisted(() => {
  type Listener = (event: unknown, ...args: unknown[]) => void
  const state = {
    windows: [] as Array<{ destroy(): void; webContents: EventEmitter }>,
    menu: undefined as undefined | Array<{ submenu?: Array<{ label?: string; click?: () => void }> }>,
    openUrl: undefined as undefined | ((preview: { url: string; projectPath: string }) => Promise<void>),
    bridge: undefined as undefined | Record<string, (listener: (value?: never) => void) => () => void>,
    /** The page's ipcRenderer listeners; main's send reaches only these. */
    listeners: new Map<string, Set<Listener>>(),
    url: 'http://127.0.0.1:45871',
  }
  process.env.COCKPIT_HOME = `${process.env.TMPDIR ?? '/tmp'}/cockpit-audit-u01-1-${process.pid}`
  return state
})

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  class FakeWebContents extends Emitter {
    session = { setPermissionRequestHandler: vi.fn() }
    setWindowOpenHandler = vi.fn()
    /** Electron delivers to the page's listeners as they are now; with none, the event is lost. */
    send(channel: string, ...args: unknown[]): void {
      for (const listener of h.listeners.get(channel) ?? []) listener({}, ...args)
    }
  }
  class FakeWindow extends Emitter {
    static getAllWindows(): unknown[] { return h.windows.filter((w) => !(w as unknown as FakeWindow).destroyed) }
    static fromWebContents(): undefined { return undefined }
    webContents = new FakeWebContents()
    destroyed = false
    constructor() { super(); h.windows.push(this as never) }
    loadURL = vi.fn(async () => undefined)
    isDestroyed(): boolean { return this.destroyed }
    isMinimized(): boolean { return false }
    restore = vi.fn()
    show = vi.fn()
    focus = vi.fn()
    maximize = vi.fn()
    isMaximized(): boolean { return false }
    isFullScreen(): boolean { return false }
    getNormalBounds(): { x: number; y: number; width: number; height: number } { return { x: 0, y: 0, width: 1360, height: 860 } }
    destroy(): void { this.destroyed = true; this.emit('closed') }
  }
  const image = { isEmpty: () => true }
  return {
    app: {
      requestSingleInstanceLock: () => true,
      // main.ts asks Electron's own command-line parser which debugger switches were passed.
      commandLine: { hasSwitch: () => false },
      on: vi.fn(),
      whenReady: () => Promise.resolve(),
      getPath: () => process.env.COCKPIT_HOME,
      setPath: vi.fn(),
      getAppPath: () => '/nonexistent/app',
      getVersion: () => '0.0.0-audit',
      name: 'Cockpit',
      isPackaged: false,
      quit: vi.fn(),
      exit: vi.fn(),
      dock: undefined,
    },
    BrowserWindow: FakeWindow,
    Notification: class { static isSupported(): boolean { return false } },
    clipboard: { writeText: vi.fn() },
    dialog: { showErrorBox: vi.fn(), showMessageBox: vi.fn(), showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
    ipcMain: { on: vi.fn(), handle: vi.fn() },
    Menu: { buildFromTemplate: (t: unknown) => t, setApplicationMenu: (t: never) => { h.menu = t } },
    nativeImage: { createFromPath: () => image },
    nativeTheme: { shouldUseDarkColors: false, themeSource: 'system', on: vi.fn() },
    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] },
    session: { defaultSession: {} },
    shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn(), trashItem: vi.fn() },
    // The page's side (electron/preload.ts).
    contextBridge: { exposeInMainWorld: (_name: string, api: never) => { h.bridge = api } },
    ipcRenderer: {
      on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => { h.listeners.set(channel, new Set([...(h.listeners.get(channel) ?? []), listener])) },
      removeListener: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => { h.listeners.get(channel)?.delete(listener) },
      send: vi.fn(),
      invoke: vi.fn(),
    },
    webUtils: { getPathForFile: () => '' },
  }
})

vi.mock('../../server/start.ts', () => ({
  startServer: async (options: { openUrl: (preview: { url: string; projectPath: string }) => Promise<void> }) => {
    h.openUrl = options.openUrl
    return {
      url: h.url,
      port: 45871,
      store: { root: `${process.env.COCKPIT_HOME}/store`, get: () => undefined },
      projects: { list: () => [] },
      workspaces: {},
      remote: { port: () => undefined },
      manager: { subscribe: vi.fn() },
      browserLeases: { revokePage: vi.fn() },
      browserInUse: () => false,
      close: async () => undefined,
    }
  },
}))
vi.mock('../../electron/crash-guard.ts', () => ({ installCrashGuard: vi.fn() }))
vi.mock('../../electron/telemetry.ts', () => ({ startTelemetry: () => ({ status: vi.fn() }) }))
vi.mock('../../electron/shell-path.ts', () => ({ resolveAppPath: () => ({ path: process.env.PATH ?? '' }) }))
vi.mock('../../electron/app-port.ts', () => ({ readAppPort: () => undefined, writeAppPort: vi.fn() }))
vi.mock('../../electron/window-key.ts', () => ({ createWindowKey: () => 'k', installWindowKey: vi.fn() }))
vi.mock('../../electron/dock-activity.ts', () => ({ createDockActivity: () => undefined, parseActivity: () => undefined }))
vi.mock('../../electron/browser-service.ts', () => ({
  createBrowserService: () => ({ forgetAll: vi.fn(), onDestroyed: vi.fn(), close: vi.fn() }),
}))
vi.mock('../../electron/browser-ipc.ts', () => ({ registerBrowserIpc: vi.fn() }))
vi.mock('../../electron/browser-agent-host.ts', () => ({ createBrowserAgentHost: () => ({}) }))

const PREVIEW = { url: 'http://127.0.0.1:5173/', projectPath: '/Users/example/project' }

/** The person closes the window (Cmd+W); the app stays alive on macOS. Returns once the window is gone. */
async function closeWindow(): Promise<void> {
  if (h.windows.length === 0) {
    await import('../../electron/main.ts')
    await vi.waitFor(() => { expect(h.windows.length).toBe(1) })
  }
  h.windows[h.windows.length - 1]!.destroy()
}

/** A new page in the newest window: its preload runs (with no listeners yet), then the document finishes loading. */
async function loadPage(): Promise<EventEmitter> {
  h.listeners.clear()
  vi.resetModules()
  await import('../../electron/preload.ts')
  const contents = h.windows[h.windows.length - 1]!.webContents
  contents.emit('did-finish-load')
  return contents
}

/** React mounts later than did-finish-load: after the page-mode fetch and the beta-terms check. */
const reactMounts = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

describe('u01-1: an event for a reopened window waits for the page to subscribe', () => {
  it('open_preview with the window closed reaches the page once it subscribes', async () => {
    await closeWindow()
    await h.openUrl!(PREVIEW)
    expect(h.windows.length).toBe(2)
    await loadPage()
    await reactMounts()

    const received = vi.fn()
    h.bridge!.onPreviewOpen!(received as never)

    expect(received).toHaveBeenCalledTimes(1)
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ url: PREVIEW.url, projectPath: PREVIEW.projectPath }))
  })

  it('Help > Release Notes with the window closed shows the notes once the page subscribes', async () => {
    await closeWindow()
    const help = h.menu!.flatMap((item) => item.submenu ?? []).find((item) => item.label === 'Release Notes')!
    help.click!()
    expect(h.windows.length).toBe(3)
    await loadPage()
    await reactMounts()

    const shown = vi.fn()
    h.bridge!.onShowReleaseNotes!(shown as never)

    expect(shown).toHaveBeenCalledTimes(1)
  })

  it('a page that subscribed before the event still gets it once, and not after it unsubscribes', async () => {
    const contents = h.windows[h.windows.length - 1]!.webContents as unknown as { send(channel: string, ...args: unknown[]): void }
    const seen: string[] = []
    const off = h.bridge!.onOpenThread!(((id: string) => seen.push(id)) as never)

    contents.send('cockpit:open-thread', 'thread-1')
    expect(seen).toEqual(['thread-1'])

    off()
    contents.send('cockpit:open-thread', 'thread-2')
    expect(seen).toEqual(['thread-1'])
  })

  it('an event is handed to the first subscriber only, not replayed to a later one', async () => {
    await closeWindow()
    await h.openUrl!(PREVIEW)
    await loadPage()

    const first = vi.fn()
    const second = vi.fn()
    h.bridge!.onPreviewOpen!(first as never)
    h.bridge!.onPreviewOpen!(second as never)

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  })
})
