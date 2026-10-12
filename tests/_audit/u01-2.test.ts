import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

// u01-2: electron/main.ts showNotification() click handler returns early when the main window
// has been closed. On macOS closing the window keeps the app alive, and a notification posted
// while the window was open stays clickable in Notification Center. The documented behaviour
// ("clicking it brings Cockpit forward and opens that conversation") should hold then too,
// the way sendToPage() reopens the window and delivers its event once the page has loaded.

const h = vi.hoisted(() => {
  const state = {
    windows: [] as Array<{ webContents: { send: ReturnType<typeof vi.fn>; emit: (e: string, ...a: unknown[]) => boolean } }>,
    notifications: [] as Array<{ emit: (e: string) => boolean; title: string; shown: boolean }>,
    ipcOn: new Map<string, (event: unknown, value: unknown) => void>(),
    url: 'http://127.0.0.1:45871',
  }
  process.env.COCKPIT_HOME = `${process.env.TMPDIR ?? '/tmp'}/cockpit-audit-u01-2-${process.pid}`
  return state
})

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  class FakeWebContents extends Emitter {
    send = vi.fn()
    session = { setPermissionRequestHandler: vi.fn() }
    setWindowOpenHandler = vi.fn()
  }
  class FakeWindow extends Emitter {
    static getAllWindows(): unknown[] { return h.windows.filter((w) => !(w as unknown as FakeWindow).destroyed) }
    static fromWebContents(): undefined { return undefined }
    webContents = new FakeWebContents()
    destroyed = false
    minimized = false
    constructor() { super(); h.windows.push(this as never) }
    loadURL = vi.fn(async () => undefined)
    isDestroyed(): boolean { return this.destroyed }
    isMinimized(): boolean { return this.minimized }
    restore(): void { this.minimized = false }
    show = vi.fn()
    focus = vi.fn()
    maximize = vi.fn()
    isMaximized(): boolean { return false }
    isFullScreen(): boolean { return false }
    getNormalBounds(): { x: number; y: number; width: number; height: number } { return { x: 0, y: 0, width: 1360, height: 860 } }
    /** What the person does with Cmd+W: the window is destroyed, 'closed' fires. */
    destroy(): void { this.destroyed = true; this.emit('closed') }
  }
  class FakeNotification extends Emitter {
    static isSupported(): boolean { return true }
    shown = false
    title: string
    constructor(options: { title: string }) { super(); this.title = options.title; h.notifications.push(this as never) }
    show(): void { this.shown = true }
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
    Notification: FakeNotification,
    clipboard: { writeText: vi.fn() },
    dialog: { showErrorBox: vi.fn(), showMessageBox: vi.fn(), showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
    ipcMain: {
      on: (channel: string, fn: (event: unknown, value: unknown) => void) => { h.ipcOn.set(channel, fn) },
      handle: vi.fn(),
    },
    Menu: { buildFromTemplate: (t: unknown) => t, setApplicationMenu: vi.fn() },
    nativeImage: { createFromPath: () => image },
    nativeTheme: { shouldUseDarkColors: false, themeSource: 'system', on: vi.fn() },
    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] },
    session: { defaultSession: {} },
    shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn(), trashItem: vi.fn() },
  }
})

vi.mock('../../server/start.ts', () => ({
  startServer: async () => ({
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
  }),
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

const PAGE = { senderFrame: { url: `${h.url}/` } }
const THREAD = 'thread-abc-123'

async function bootMain(): Promise<void> {
  await import('../../electron/main.ts')
  await vi.waitFor(() => { expect(h.windows.length).toBe(1) })
  expect(h.ipcOn.has('cockpit:notify')).toBe(true)
}

function post(): { emit: (e: string) => boolean } {
  const before = h.notifications.length
  h.ipcOn.get('cockpit:notify')!(PAGE, { threadId: THREAD, title: 'Deploy the site', body: 'Finished: ok' })
  expect(h.notifications.length).toBe(before + 1)
  return h.notifications[before]!
}

describe('u01-2: clicking a notification', () => {
  it('opens its conversation while the window is open (harness sanity check)', async () => {
    await bootMain()
    const note = post()
    note.emit('click')
    expect(h.windows[0]!.webContents.send).toHaveBeenCalledWith('cockpit:open-thread', THREAD)
  })

  it('opens its conversation even after the window was closed', async () => {
    // The notification was posted while the window was open and is still in Notification Center.
    const note = post()
    // The person closes the window (Cmd+W). On macOS the app and its agents keep running.
    const first = h.windows[0] as unknown as EventEmitter & { destroy(): void }
    first.destroy()
    const windowsBefore = h.windows.length

    note.emit('click')

    // Correct behaviour: Cockpit comes forward with a window...
    expect(h.windows.length).toBe(windowsBefore + 1)
    const reopened = h.windows[h.windows.length - 1]!
    // ...and, once its page has loaded (the readiness signal sendToPage uses), it is told to open the thread.
    reopened.webContents.emit('did-finish-load')
    expect(reopened.webContents.send).toHaveBeenCalledWith('cockpit:open-thread', THREAD)
  })
})
