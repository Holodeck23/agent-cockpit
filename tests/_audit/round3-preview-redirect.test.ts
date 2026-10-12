import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBrowserAgentHost } from '../../electron/browser-agent-host.ts'

// round 3 of the recheck of fe7ca68 (redirect gate for inspect_preview / open_preview). review-preview-redirect.test.ts
// fakes the browser host, so it could not see what the REAL host does around the gate:
//  - a navigation the guard refused left the page where it was, yet the host still reported
//    navigated(key, previousUrl) and main.ts opened the preview pane on that previous page, just before
//    open_preview threw "redirects to ...";
//  - a successful open_preview told the window to open the pane twice: once from the host's navigated callback,
//    once from showPreview itself.
// CORRECT behaviour: a refused navigation moves nothing, so nothing is reported and no pane opens; a successful
// open_preview opens the pane once; an agent's own navigation (browser_navigate) still opens it once.
// Here the real createBrowserAgentHost runs (directly, and inside the real main.ts); only the browser service,
// which needs Electron's WebContentsView, and Electron itself are fake.

const h = vi.hoisted(() => {
  type Redirect = { to: string }
  const state = {
    windows: [] as Array<{ destroy(): void; webContents: EventEmitter }>,
    sent: [] as Array<{ channel: string; args: unknown[] }>,
    openUrl: undefined as undefined | ((preview: Record<string, unknown>) => Promise<void>),
    browserHost: undefined as undefined | (() => { goto(key: string, url: string): Promise<{ url: string }> } | undefined),
    // The fake service's one page: where it is, which addresses redirect (to a website, say), why a request was refused.
    page: { url: '', redirects: new Map<string, Redirect>(), error: undefined as undefined | { code: number; description: string; url: string } },
    service: undefined as unknown as Record<string, unknown>,
    url: 'http://127.0.0.1:45871',
  }
  process.env.COCKPIT_HOME = `${process.env.TMPDIR ?? '/tmp'}/cockpit-audit-round3-preview-${process.pid}`
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
    WebContentsView: class {},
  }
})

vi.mock('../../server/start.ts', () => ({
  startServer: async (options: { openUrl: NonNullable<typeof h.openUrl>; browserHost: NonNullable<typeof h.browserHost> }) => {
    h.openUrl = options.openUrl
    h.browserHost = options.browserHost
    return {
      url: h.url,
      port: 45871,
      // The conversation exists, so the host's navigated callback can name its project.
      store: { root: `${process.env.COCKPIT_HOME}/store`, get: (id: string) => (id === 't1' ? { projectPath: '/Users/example/project' } : undefined) },
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
vi.mock('../../electron/browser-ipc.ts', () => ({ registerBrowserIpc: vi.fn() }))
// Only the browser service is fake: the real agent host is built on it by the real main.ts.
vi.mock('../../electron/browser-service.ts', () => ({ createBrowserService: () => h.service }))

const KEY = 'thread:t1'
const APP = 'http://127.0.0.1:5173/'
const PREVIOUS = 'http://127.0.0.1:3000/'
const SHOP = 'https://shop.test/landing?id=1'
const THREAD = { url: APP, projectPath: '/Users/example/project', threadId: 't1' }

/**
 * What the service does for the host: every main-frame request of the page (the address, then each redirect hop)
 * is held for the guard installed with guardNavigation, as electron/browser-service.ts does; a request the guard
 * refuses fails the load with that reason (ERR_BLOCKED_BY_CLIENT, -20) and the page stays where it was.
 */
function makeService(): Record<string, unknown> {
  const contents = { isDestroyed: () => false, isLoading: () => false }
  let guard: ((url: string) => Promise<void>) | undefined
  // A request the guard refuses stops the navigation, as the real service does: the page stays where it was, and
  // the reason is kept for the call that asked (takeDenial) instead of becoming an error page.
  let denial: string | undefined
  const request = async (url: string): Promise<boolean> => {
    try { await guard?.(url); return true } catch (error) {
      denial = error instanceof Error ? error.message : String(error)
      return false
    }
  }
  return {
    guardNavigation: (_key: string, authorize: (url: string) => Promise<void>) => { guard = authorize },
    agentPage: () => ({ contents, revision: 1, viewport: { width: 800, height: 600 } }),
    state: () => ({ key: KEY, url: h.page.url, title: '', canGoBack: false, canGoForward: false, loading: false, ...(h.page.error ? { error: h.page.error } : {}) }),
    ensure: async () => undefined,
    takeDenial: () => { const reason = denial; denial = undefined; return reason },
    load: (_key: string, url: string) => {
      h.page.error = undefined
      denial = undefined
      void (async () => {
        let next = url
        for (let hop = 0; hop < 5; hop++) {
          if (!(await request(next))) return
          const to = h.page.redirects.get(next)?.to
          if (!to) break
          next = to
        }
        h.page.url = next
      })()
      return undefined
    },
    navigate: vi.fn(),
    onDestroyed: vi.fn(() => () => undefined),
    forgetAll: vi.fn(),
    close: vi.fn(),
  }
}

const previewOpens = (): Array<Record<string, unknown>> => h.sent.filter((s) => s.channel === 'cockpit:preview-open').map((s) => s.args[0] as Record<string, unknown>)

async function boot(): Promise<void> {
  if (h.windows.length === 0) {
    h.service = makeService()
    await import('../../electron/main.ts')
  }
  await vi.waitFor(() => { expect(h.windows.length).toBe(1); expect(h.openUrl).toBeDefined(); expect(h.browserHost?.()).toBeDefined() })
}

beforeEach(async () => {
  await boot()
  h.sent.length = 0
  h.page.url = PREVIOUS
  h.page.redirects.clear()
  h.page.error = undefined
})

describe('the real host: a navigation the guard refused moves nothing, so it reports nothing', () => {
  const REFUSED = 'The preview redirects to https://shop.test, not your local app.'
  const setup = () => {
    const navigated = vi.fn()
    const service = makeService()
    const host = createBrowserAgentHost(service as never, navigated)
    return { navigated, service, host }
  }

  it('does not report the previous page as the place the agent moved to', async () => {
    const { host, navigated } = setup()
    host.guardNavigation(KEY, async (url) => { if (url === SHOP) throw new Error(REFUSED) })
    h.page.redirects.set(APP, { to: SHOP })
    await expect(host.goto(KEY, APP)).rejects.toThrow(REFUSED)
    expect(h.page.url).toBe(PREVIOUS)
    expect(navigated).not.toHaveBeenCalled()
  })

  it('does not report it from history navigation either', async () => {
    // history() goes through the same navigation; here Back's hop to the website is refused.
    const { host, service, navigated } = setup()
    service.navigate = () => { h.page.error = { code: -20, description: REFUSED, url: SHOP } }
    await expect(host.history(KEY, 'back')).rejects.toThrow(REFUSED)
    expect(navigated).not.toHaveBeenCalled()
  })

  it('reports where the agent landed when the navigation went through (control)', async () => {
    const { host, navigated } = setup()
    const landing = await host.goto(KEY, APP)
    expect(landing.url).toBe(APP)
    expect(navigated).toHaveBeenCalledTimes(1)
    expect(navigated).toHaveBeenCalledWith(KEY, APP)
  })

  it('reports it when the guard let the website through (control)', async () => {
    const { host, navigated } = setup()
    host.guardNavigation(KEY, async () => {})
    h.page.redirects.set(APP, { to: SHOP })
    const landing = await host.goto(KEY, APP)
    expect(landing.url).toBe(SHOP)
    expect(navigated).toHaveBeenCalledWith(KEY, SHOP)
  })
})

describe('open_preview through the real main.ts and the real host', () => {
  it('a local address that redirects to a website: an error, and the pane never opens on the previous page', async () => {
    h.page.redirects.set(APP, { to: SHOP })
    await expect(h.openUrl!(THREAD)).rejects.toThrow(/redirects to https:\/\/shop\.test, not your local app/)
    expect(previewOpens()).toEqual([])
    expect(h.page.url).toBe(PREVIOUS)
  })

  it('opens the pane once when the page loads', async () => {
    await h.openUrl!(THREAD)
    expect(h.page.url).toBe(APP)
    expect(previewOpens()).toEqual([{ ...THREAD, url: APP, loaded: true }])
  })

  it('opens the pane once when the page is already there (control)', async () => {
    h.page.url = APP
    await h.openUrl!(THREAD)
    expect(previewOpens()).toEqual([{ ...THREAD, url: APP, loaded: true }])
  })

  it('still opens the pane once for an agent\'s own navigation (control)', async () => {
    await h.browserHost!()!.goto(KEY, 'http://127.0.0.1:4000/docs')
    expect(previewOpens()).toEqual([{ url: 'http://127.0.0.1:4000/docs', projectPath: THREAD.projectPath, threadId: 't1', loaded: true }])
  })

  it('an agent navigation after an open_preview opens the pane too: the quiet window ends with the call', async () => {
    await h.openUrl!(THREAD)
    h.sent.length = 0
    await h.browserHost!()!.goto(KEY, 'http://127.0.0.1:4000/docs')
    expect(previewOpens()).toHaveLength(1)
  })

  it('two open_preview calls at once on one conversation each open the pane once', async () => {
    const other = 'http://127.0.0.1:5174/'
    await Promise.all([h.openUrl!(THREAD), h.openUrl!({ ...THREAD, url: other })])
    expect(previewOpens().map((p) => p.url).sort()).toEqual([APP, other])
  })

  it('a refused open_preview leaves nothing quiet behind for the next navigation', async () => {
    h.page.redirects.set(APP, { to: SHOP })
    await expect(h.openUrl!(THREAD)).rejects.toThrow(/redirects to/)
    h.sent.length = 0
    await h.browserHost!()!.goto(KEY, 'http://127.0.0.1:4000/docs')
    expect(previewOpens()).toHaveLength(1)
  })
})
