import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// review of u06-1: the host holds every main-frame request of an agent's page for the guard installed with
// guardNavigation, and goto() rejects when the guard refuses one. electron/main.ts's two preview paths
// also load agent-chosen local addresses on the conversation's own page:
//  - inspect_preview ignored a refused hop, so the page stayed on its previous document and that document
//    was captured as if it were the preview (or, from a blank page, failed with "now on null");
//  - open_preview loaded the address with no gate at all, so the redirect was followed to the website.
// docs/ARCHITECTURE.md: neither tool can navigate to a remote origin.
// CORRECT behaviour: both arm the local-preview guard (electron/preview-navigation.ts) before the page is
// restored or loaded, go through the host's goto, and a refused hop is an error that names the website.
// Main runs for real against a fake Electron and a fake browser host that consults the installed guard.

const h = vi.hoisted(() => {
  const state = {
    windows: [] as Array<{ destroy(): void; webContents: EventEmitter }>,
    sent: [] as Array<{ channel: string; args: unknown[] }>,
    openUrl: undefined as undefined | ((preview: Record<string, unknown>) => Promise<void>),
    inspectPreview: undefined as undefined | ((preview: Record<string, unknown>) => Promise<{ data: string }>),
    host: { guardNavigation: vi.fn(), ensure: vi.fn(), goto: vi.fn(), capture: vi.fn() },
    /** The guard main.ts installed on the conversation's page; the fake host asks it for each address a page requests. */
    guard: undefined as undefined | ((url: string) => Promise<void>),
    service: { load: vi.fn(), forgetAll: vi.fn(), onDestroyed: vi.fn(), close: vi.fn() },
    url: 'http://127.0.0.1:45871',
  }
  process.env.COCKPIT_HOME = `${process.env.TMPDIR ?? '/tmp'}/cockpit-audit-review-preview-${process.pid}`
  return state
})

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  class FakeWebContents extends Emitter {
    session = { setPermissionRequestHandler: vi.fn() }
    setWindowOpenHandler = vi.fn()
    send(channel: string, ...args: unknown[]): void { h.sent.push({ channel, args }) }
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
    Menu: { buildFromTemplate: (t: unknown) => t, setApplicationMenu: vi.fn() },
    nativeImage: { createFromPath: () => image },
    nativeTheme: { shouldUseDarkColors: false, themeSource: 'system', on: vi.fn() },
    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] },
    session: { defaultSession: {} },
    shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn(), trashItem: vi.fn() },
  }
})

vi.mock('../../server/start.ts', () => ({
  startServer: async (options: { openUrl: NonNullable<typeof h.openUrl>; inspectPreview: NonNullable<typeof h.inspectPreview> }) => {
    h.openUrl = options.openUrl
    h.inspectPreview = options.inspectPreview
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
vi.mock('../../electron/browser-service.ts', () => ({ createBrowserService: () => h.service }))
vi.mock('../../electron/browser-ipc.ts', () => ({ registerBrowserIpc: vi.fn() }))
vi.mock('../../electron/browser-agent-host.ts', () => ({ createBrowserAgentHost: () => h.host }))

const APP = 'http://127.0.0.1:5173/'
const PREVIOUS = 'http://127.0.0.1:3000/'
const SHOP = 'https://shop.test/landing?id=1'
const THREAD = { url: APP, projectPath: '/Users/example/project', threadId: 't1' }

const pageAt = (url: string) => ({
  pageId: 'thread:t1', revision: 1, url, origin: url ? new URL(url).origin : 'null', title: '', loading: false,
  viewport: { width: 800, height: 600 }, timestamp: '2026-10-12T00:00:00.000Z',
})
/** A navigation that a local address answers with a redirect to `to`: the host asks the guard for it, as the service does. */
const redirectsTo = (to: string): void => { h.host.goto.mockImplementation(async () => { await h.guard!(to); return pageAt(to) }) }
const shot = (url: string) => ({ data: 'cG5n', mimeType: 'image/png', width: 1280, height: 800, page: pageAt(url) })

async function boot(): Promise<void> {
  if (h.windows.length === 0) await import('../../electron/main.ts')
  await vi.waitFor(() => { expect(h.windows.length).toBe(1); expect(h.inspectPreview).toBeDefined() })
}

beforeEach(async () => {
  await boot()
  h.sent.length = 0
  for (const fn of [h.host.guardNavigation, h.host.ensure, h.host.goto, h.host.capture, h.service.load]) fn.mockReset()
  h.guard = undefined
  h.host.guardNavigation.mockImplementation((_key: string, authorize: (url: string) => Promise<void>) => { h.guard = authorize })
  h.host.ensure.mockResolvedValue(pageAt(PREVIOUS))
  h.host.capture.mockResolvedValue(shot(PREVIOUS))
})

describe('inspect_preview on a local address that redirects to a website', () => {
  it('says so instead of handing back the previous document as the preview', async () => {
    redirectsTo(SHOP)
    await expect(h.inspectPreview!(THREAD)).rejects.toThrow(/redirects to https:\/\/shop\.test, not your local app/)
    expect(h.host.capture).not.toHaveBeenCalled()
  })

  it('says so from a blank page too, instead of "now on null"', async () => {
    h.host.ensure.mockResolvedValue(pageAt(''))
    redirectsTo(SHOP)
    const outcome = await h.inspectPreview!(THREAD).then(() => undefined, (e: Error) => e.message)
    expect(outcome).toMatch(/shop\.test/)
    expect(outcome).not.toMatch(/null/)
  })

  it('captures the page when the navigation stayed local (control)', async () => {
    h.host.goto.mockResolvedValue(pageAt(APP))
    h.host.capture.mockResolvedValue(shot(APP))
    await expect(h.inspectPreview!(THREAD)).resolves.toMatchObject({ data: 'cG5n', page: { url: APP } })
    expect(h.host.goto).toHaveBeenCalledWith('thread:t1', APP)
  })

  it('arms the local-preview guard before the page is restored, even when nothing needs loading', async () => {
    h.host.ensure.mockResolvedValue(pageAt('http://127.0.0.1:5173/about'))
    h.host.capture.mockResolvedValue(shot('http://127.0.0.1:5173/about'))
    await h.inspectPreview!(THREAD)
    expect(h.host.guardNavigation.mock.invocationCallOrder[0]).toBeLessThan(h.host.ensure.mock.invocationCallOrder[0]!)
    await expect(h.guard!(SHOP)).rejects.toThrow(/redirects to https:\/\/shop\.test, not your local app/)
  })

  it('does not navigate a page that is already on that app (control)', async () => {
    h.host.ensure.mockResolvedValue(pageAt('http://127.0.0.1:5173/about'))
    h.host.capture.mockResolvedValue(shot('http://127.0.0.1:5173/about'))
    await h.inspectPreview!(THREAD)
    expect(h.host.goto).not.toHaveBeenCalled()
  })
})

describe('open_preview on a local address that redirects to a website', () => {
  it('stops at the gate: an error naming the website, and the pane is not told to show it', async () => {
    redirectsTo(SHOP)
    await expect(h.openUrl!(THREAD)).rejects.toThrow(/redirects to https:\/\/shop\.test, not your local app/)
    expect(h.sent.filter((s) => s.channel === 'cockpit:preview-open')).toHaveLength(0)
  })

  it('loads the address through the host\'s gated navigation, never straight into the page', async () => {
    h.host.goto.mockResolvedValue(pageAt(APP))
    await h.openUrl!(THREAD)
    expect(h.host.goto).toHaveBeenCalledWith('thread:t1', APP)
    expect(h.service.load).not.toHaveBeenCalled()
  })

  it('arms the local-preview guard before the page is restored or loaded, and it lets only a local app through', async () => {
    h.host.goto.mockResolvedValue(pageAt(APP))
    await h.openUrl!(THREAD)
    // The person's own click in their app is theirs to follow: the guard says it can be lifted.
    expect(h.host.guardNavigation).toHaveBeenCalledWith('thread:t1', expect.any(Function), { over: expect.any(Function) })
    expect(h.host.guardNavigation.mock.invocationCallOrder[0]).toBeLessThan(h.host.ensure.mock.invocationCallOrder[0]!)
    await expect(h.guard!(APP)).resolves.toBeUndefined()
    await expect(h.guard!(SHOP)).rejects.toThrow(/not your local app/)
  })

  it('shows the pane once the page is on the app (control)', async () => {
    h.host.goto.mockResolvedValue(pageAt(APP))
    await h.openUrl!(THREAD)
    expect(h.sent).toEqual([{ channel: 'cockpit:preview-open', args: [{ ...THREAD, url: APP, loaded: true }] }])
  })

  it('does not load again a page that is already there (control)', async () => {
    h.host.ensure.mockResolvedValue(pageAt(APP))
    await h.openUrl!(THREAD)
    expect(h.host.goto).not.toHaveBeenCalled()
    expect(h.sent).toHaveLength(1)
  })

  it('passes on the error when the host refuses the address', async () => {
    h.host.goto.mockRejectedValue(new Error('That address cannot be opened'))
    await expect(h.openUrl!(THREAD)).rejects.toThrow('That address cannot be opened')
  })
})
