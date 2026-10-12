import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserAgentHost } from '../../electron/browser-agent-host.ts'
import { createBrowserService } from '../../electron/browser-service.ts'

// u06-1 (host half): electron/browser-service.ts holds every main-frame request of a page an agent drives
// (a redirect hop, a script's navigation, a popup, a restored page) for the guard the agent installed
// (guardNavigation) before the request goes out, and cancels the ones the guard refuses.
// electron/browser-agent-host.ts turns a refusal into an error for the call, with the guard's own reason.
// Outside an agent's guard nothing changes: the person browses freely.
// (This replaced a will-redirect/will-navigate watch that only covered the agent's own call window.)

const h = vi.hoisted(() => ({
  views: [] as Array<{ webContents: { id: number; url: string; redirects: Map<string, string>; emit(event: string, ...args: unknown[]): boolean } }>,
  /** The service's onBeforeRequest listener for the (one, shared) fake partition session. */
  listener: undefined as undefined | ((details: Record<string, unknown>, callback: (response: { cancel: boolean }) => void) => void),
  ids: 0,
}))

/** One request as Electron's webRequest reports it; resolves to whether the service cancelled it. */
const request = (webContentsId: number, url: string, resourceType = 'mainFrame'): Promise<boolean> =>
  new Promise((resolve) => h.listener!({ url, resourceType, webContentsId }, ({ cancel }) => resolve(cancel)))

// Just enough of Electron for the service: a page whose loadURL asks the service's request listener for each
// hop (the first address, then each planned redirect), as Chromium does, and fails with ERR_BLOCKED_BY_CLIENT
// (-20) when a hop is cancelled.
vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  class FakeContents extends Emitter {
    id = ++h.ids
    url = 'about:blank'
    loading = false
    destroyed = false
    redirects = new Map<string, string>()
    navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    setWindowOpenHandler = vi.fn()
    getURL(): string { return this.url }
    getTitle(): string { return '' }
    isLoading(): boolean { return this.loading }
    isDestroyed(): boolean { return this.destroyed }
    reload(): void {}
    async loadURL(url: string): Promise<void> {
      this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
      this.loading = true
      let next = url
      for (let hop = 0; hop < 10; hop++) {
        if (await request(this.id, next)) {
          this.loading = false
          this.emit('did-fail-load', {}, -20, 'ERR_BLOCKED_BY_CLIENT', next, true)
          return
        }
        const to = this.redirects.get(next)
        if (!to) break
        next = to
      }
      this.url = next
      this.loading = false
      this.emit('did-navigate', {})
    }
    close(): void { this.destroyed = true; this.emit('destroyed') }
  }
  class FakeView {
    webContents = new FakeContents()
    bounds = { x: 0, y: 0, width: 800, height: 600 }
    constructor() { h.views.push(this as never) }
    setBounds(bounds: FakeView['bounds']): void { this.bounds = bounds }
    getBounds(): FakeView['bounds'] { return this.bounds }
    setVisible(): void {}
    getVisible(): boolean { return false }
  }
  const web = { webRequest: { onBeforeRequest: (listener: typeof h.listener) => { h.listener = listener } }, setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), on: vi.fn() }
  return { shell: { openExternal: vi.fn() }, WebContentsView: FakeView, session: { fromPartition: () => web } }
})

const win = { isDestroyed: () => false, contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }, getContentSize: () => [1400, 900] }
const KEY = 'thread:t1'
const LOCAL = 'http://127.0.0.1:5173/'
const REMOTE = 'https://shop.test/delete?id=1'
const services: Array<ReturnType<typeof createBrowserService>> = []
afterEach(() => { vi.useRealTimers(); for (const s of services.splice(0)) s.dispose(); h.views.length = 0; h.listener = undefined })

async function setup() {
  const service = createBrowserService({ window: () => win as never, cockpitPorts: () => [45871], publish: vi.fn() })
  services.push(service)
  const navigated = vi.fn()
  const host = createBrowserAgentHost(service, navigated)
  await host.ensure(KEY, '/Users/example/garden')
  return { service, host, navigated, contents: h.views[0]!.webContents }
}

describe('u06-1: the service holds an agent-driven main-frame request for the guard', () => {
  it('asks the guard before each main-frame request, whatever started it, and cancels the one it refuses', async () => {
    const { host, contents } = await setup()
    const seen: string[] = []
    host.guardNavigation(KEY, async (url) => { seen.push(url); if (url === REMOTE) throw new Error('Browser action denied by the user') })
    // A top-level load, a redirect hop, a script's navigation and a popup all arrive as the same kind of request.
    expect(await request(contents.id, LOCAL)).toBe(false)
    expect(await request(contents.id, REMOTE)).toBe(true)
    expect(await request(contents.id, 'http://127.0.0.1:3000/next')).toBe(false)
    expect(seen).toEqual([LOCAL, REMOTE, 'http://127.0.0.1:3000/next'])
  })

  it('lets through an approved origin, a local app and a subframe; Cockpit itself stays refused', async () => {
    const { host, contents } = await setup()
    const seen: string[] = []
    host.guardNavigation(KEY, async (url) => { seen.push(url) })
    expect(await request(contents.id, REMOTE)).toBe(false)
    expect(await request(contents.id, 'http://localhost:3000/next')).toBe(false)
    // Only a page's own navigation is held: what it loads into the page is not (and is still filtered by the existing rule).
    expect(await request(contents.id, 'https://ads.test/frame', 'subFrame')).toBe(false)
    expect(seen).toEqual([REMOTE, 'http://localhost:3000/next'])
    // Cockpit itself is still refused by the existing rule, guard or not, and never reaches the guard.
    expect(await request(contents.id, 'http://127.0.0.1:45871/')).toBe(true)
    expect(seen).not.toContain('http://127.0.0.1:45871/')
  })

  it('refuses a request whose page is gone, rather than lending it another page\'s approval', async () => {
    const { host, contents } = await setup()
    host.guardNavigation(KEY, async () => {})
    expect(await request(contents.id + 100, REMOTE)).toBe(true)
  })

  it('does nothing without an agent guard, or once the person navigates themselves', async () => {
    const { service, host, contents } = await setup()
    expect(await request(contents.id, REMOTE)).toBe(false)
    host.guardNavigation(KEY, async () => { throw new Error('Stopped run') })
    expect(await request(contents.id, REMOTE)).toBe(true)
    // The person typing an address takes the page back from the agent's guard.
    await service.open(KEY, '/Users/example/garden', 'https://elsewhere.test/')
    expect(await request(contents.id, REMOTE)).toBe(false)
  })

  it('goto reports a refused redirect as an error with the guard\'s reason, and the page stays where it was', async () => {
    const { host, contents, navigated } = await setup()
    contents.redirects.set(LOCAL, REMOTE)
    host.guardNavigation(KEY, async (url) => { if (url === REMOTE) throw new Error('Browser action denied by the user') })
    await expect(host.goto(KEY, LOCAL)).rejects.toThrow('Browser action denied by the user')
    expect(contents.url).toBe('about:blank')
    expect(navigated).not.toHaveBeenCalled()
  })

  it('goto follows the redirect when the guard lets it through, and the person browsing is not held to the agent\'s approvals afterwards', async () => {
    const { service, host, contents, navigated } = await setup()
    contents.redirects.set(LOCAL, REMOTE)
    host.guardNavigation(KEY, async () => {})
    const page = await host.goto(KEY, LOCAL)
    expect(page.url).toBe(REMOTE)
    expect(navigated).toHaveBeenCalledWith(KEY, REMOTE)
    host.guardNavigation(KEY, async () => { throw new Error('Stopped run') })
    await service.open(KEY, '/Users/example/garden', 'https://elsewhere.test/')
    expect(await request(contents.id, 'https://elsewhere.test/next')).toBe(false)
  })

  it('goto waits for the person to decide, however long that takes, instead of reporting a page still loading', async () => {
    vi.useFakeTimers()
    const { host, contents } = await setup()
    let answer!: () => void
    host.guardNavigation(KEY, () => new Promise<void>((resolve) => { answer = resolve }))
    let settled = false
    const landing = host.goto(KEY, REMOTE).finally(() => { settled = true })
    // Well past the 15 s a page gets to load: the request is held for the person, which is not a slow load.
    await vi.advanceTimersByTimeAsync(40_000)
    expect(settled).toBe(false)
    answer()
    await vi.advanceTimersByTimeAsync(500)
    expect((await landing).url).toBe(REMOTE)
    expect(contents.url).toBe(REMOTE)
  })
})
