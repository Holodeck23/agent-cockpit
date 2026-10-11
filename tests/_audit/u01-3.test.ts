import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Audit u01-3: with Cockpit's window closed, a hidden preview-capture BrowserWindow is still in
// BrowserWindow.getAllWindows(), so the Dock "activate" handler (electron/main.ts:146) thinks a
// window exists and never reopens the main one. Everything outside main.ts is mocked; no Electron.

const home = mkdtempSync(join(tmpdir(), 'cockpit-u01-3-'))
process.env.COCKPIT_HOME = home

interface Opts { show?: boolean; title?: string }
interface FakeWindow {
  options: Opts
  destroyed: boolean
  emit(event: string, ...args: unknown[]): void
  destroy(): void
  resolveLoad(): void
  loads: string[]
}

const h = vi.hoisted(() => {
  const appHandlers = new Map<string, (...args: unknown[]) => unknown>()
  const windows: unknown[] = []
  const state = { startOptions: undefined as undefined | { capturePreview?: (url: string) => Promise<unknown> } }
  return { appHandlers, windows, state }
})

vi.mock('electron', () => {
  class Emitter {
    private readonly handlers = new Map<string, Array<(...a: unknown[]) => void>>()
    on(event: string, fn: (...a: unknown[]) => void): this { this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]); return this }
    once(event: string, fn: (...a: unknown[]) => void): this { return this.on(event, fn) }
    emit(event: string, ...args: unknown[]): void { for (const fn of this.handlers.get(event) ?? []) fn(...args) }
  }
  const fakeSession = () => ({ setPermissionRequestHandler: () => undefined, clearStorageData: async () => undefined })
  class BrowserWindow extends Emitter {
    destroyed = false
    loads: string[] = []
    private release: (() => void) | undefined
    readonly webContents: Emitter & Record<string, unknown>
    constructor(readonly options: Opts) {
      super()
      const wc = new Emitter() as Emitter & Record<string, unknown>
      Object.assign(wc, {
        session: fakeSession(),
        setWindowOpenHandler: () => undefined,
        stop: () => undefined,
        send: () => undefined,
        capturePage: async () => ({ resize: () => ({ getSize: () => ({ width: 1280, height: 800 }), toPNG: () => Buffer.from('png') }) }),
      })
      this.webContents = wc
      h.windows.push(this)
    }
    static getAllWindows(): unknown[] { return h.windows.filter((w) => !(w as BrowserWindow).destroyed) }
    static fromWebContents(): undefined { return undefined }
    // The main window's page loads at once; the capture window's load stays open until the test lets it finish.
    loadURL(url: string): Promise<void> {
      this.loads.push(url)
      if (this.options.title === 'Cockpit') return Promise.resolve()
      return new Promise<void>((resolve) => { this.release = resolve })
    }
    resolveLoad(): void { this.release?.() }
    isDestroyed(): boolean { return this.destroyed }
    destroy(): void { this.destroyed = true; this.emit('closed') }
    show(): void { /* shown */ }
    isMinimized(): boolean { return false }
    restore(): void { /* */ }
    focus(): void { /* */ }
    maximize(): void { /* */ }
    isMaximized(): boolean { return false }
    isFullScreen(): boolean { return false }
    getNormalBounds(): { x: number; y: number; width: number; height: number } { return { x: 0, y: 0, width: 1360, height: 860 } }
  }
  const app = {
    on: (event: string, fn: (...a: unknown[]) => unknown) => { h.appHandlers.set(event, fn) },
    whenReady: () => Promise.resolve(),
    requestSingleInstanceLock: () => true,
    setPath: () => undefined,
    getPath: () => home,
    getAppPath: () => home,
    getVersion: () => '0.0.0-audit',
    isPackaged: false,
    quit: () => undefined,
    exit: () => undefined,
    name: 'Cockpit',
    dock: undefined,
  }
  return {
    app,
    BrowserWindow,
    clipboard: { writeText: () => undefined },
    dialog: { showErrorBox: () => undefined, showMessageBox: async () => ({ response: 0 }) },
    ipcMain: { on: () => undefined, handle: () => undefined },
    Menu: { setApplicationMenu: () => undefined, buildFromTemplate: () => ({}) },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    nativeTheme: { shouldUseDarkColors: false, on: () => undefined, themeSource: 'system' },
    Notification: class { static isSupported(): boolean { return false } },
    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] },
    session: { defaultSession: fakeSession() },
    shell: { openExternal: async () => undefined },
  }
})

vi.mock('../../server/start.ts', () => ({
  startServer: async (options: { capturePreview?: (url: string) => Promise<unknown> }) => {
    h.state.startOptions = options
    return {
      url: 'http://127.0.0.1:47999', port: 47999,
      remote: { port: () => undefined },
      projects: { list: () => [] }, workspaces: {},
      store: { root: home, get: () => undefined },
      manager: { subscribe: () => () => undefined },
      browserInUse: () => false,
      browserLeases: { revokePage: () => undefined },
      close: async () => undefined,
    }
  },
}))
vi.mock('../../electron/crash-guard.ts', () => ({ installCrashGuard: () => undefined }))
vi.mock('../../electron/telemetry.ts', () => ({ startTelemetry: () => ({ pageError: () => undefined }) }))
vi.mock('../../electron/telemetry-choice.ts', () => ({ reportingDsn: () => undefined }))
vi.mock('../../electron/shell-path.ts', () => ({ resolveAppPath: () => ({ path: process.env.PATH ?? '' }) }))
vi.mock('../../electron/app-port.ts', () => ({ readAppPort: () => undefined, writeAppPort: () => undefined }))
vi.mock('../../electron/browser-service.ts', () => ({
  createBrowserService: () => ({ forgetAll: () => undefined, close: () => undefined, load: () => undefined, onDestroyed: () => undefined }),
}))
vi.mock('../../electron/browser-ipc.ts', () => ({ registerBrowserIpc: () => undefined }))
vi.mock('../../electron/browser-agent-host.ts', () => ({ createBrowserAgentHost: () => ({}) }))
vi.mock('../../electron/window-key.ts', () => ({ createWindowKey: () => 'k', installWindowKey: () => undefined }))
vi.mock('../../electron/dock-activity.ts', () => ({ createDockActivity: () => undefined, parseActivity: () => undefined }))
vi.mock('../../electron/debug-flags.ts', () => ({ IS_RELEASE_BUILD: false, debugSwitches: () => [] }))

const asWindow = (w: unknown): FakeWindow => w as FakeWindow
const mainWindows = (): FakeWindow[] => h.windows.map(asWindow).filter((w) => w.options.title === 'Cockpit')
const hiddenCaptures = (): FakeWindow[] => h.windows.map(asWindow).filter((w) => w.options.title !== 'Cockpit')

describe('u01-3: Dock activate with a hidden capture window open', () => {
  beforeAll(async () => {
    await import('../../electron/main.ts')
    await vi.waitFor(() => expect(mainWindows()).toHaveLength(1))
  })
  afterAll(() => { vi.restoreAllMocks() })

  it('reopens the Cockpit window even while a hidden preview capture is in flight', async () => {
    // The person closes the only window; the app (and its agents) keep running.
    asWindow(mainWindows()[0]).destroy()
    expect(h.appHandlers.has('activate')).toBe(true)

    // An evidence capture (or any direct capturePreview) starts a hidden BrowserWindow.
    const capture = h.state.startOptions!.capturePreview!('http://127.0.0.1:5173/')
    await vi.waitFor(() => expect(hiddenCaptures()).toHaveLength(1))
    expect(hiddenCaptures()[0]!.options.show).toBe(false)

    // The person clicks the Dock icon during the capture.
    h.appHandlers.get('activate')!()

    // Correct behaviour: Cockpit's window comes back (a second window titled Cockpit is created).
    const liveMainWindows = mainWindows().filter((w) => !w.destroyed).length
    // Let the capture finish so nothing is left pending.
    hiddenCaptures()[0]!.resolveLoad()
    await capture
    expect(liveMainWindows, 'live Cockpit windows right after the Dock click, capture still running').toBe(1)
  })

  it('control: with no capture running, the same Dock click does reopen the window', () => {
    // The capture above is finished and its hidden window destroyed. The person closes the Cockpit
    // window again (the Dock click above brought it back, once fixed).
    expect(hiddenCaptures().filter((w) => !w.destroyed)).toHaveLength(0)
    for (const w of mainWindows().filter((live) => !live.destroyed)) asWindow(w).destroy()
    expect(mainWindows().filter((w) => !w.destroyed)).toHaveLength(0)
    h.appHandlers.get('activate')!()
    expect(mainWindows().filter((w) => !w.destroyed)).toHaveLength(1)
  })
})
