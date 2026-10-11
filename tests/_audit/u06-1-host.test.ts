import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserAgentHost } from '../../electron/browser-agent-host.ts'
import { createBrowserService } from '../../electron/browser-service.ts'

// u06-1 (host half): while an agent's navigation settles, electron/browser-service.ts stops a main-frame
// hop to a remote origin the call did not approve, before the request goes out (will-redirect,
// will-navigate, will-frame-navigate), and electron/browser-agent-host.ts reports it as `blocked` so
// server/browser/agent.ts can ask. Outside an agent's navigation nothing changes: the person browses freely.

const h = vi.hoisted(() => ({
  views: [] as Array<{ webContents: { emit(event: string, ...args: unknown[]): boolean; url: string; redirects: Map<string, string> } }>,
}))

// Just enough of Electron for the service: a page whose loadURL follows a planned redirect the way
// Electron does, asking will-redirect first and staying where it was when a listener stops the hop.
vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  class FakeContents extends Emitter {
    url = 'about:blank'
    destroyed = false
    redirects = new Map<string, string>()
    navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    setWindowOpenHandler = vi.fn()
    getURL(): string { return this.url }
    getTitle(): string { return '' }
    isLoading(): boolean { return false }
    isDestroyed(): boolean { return this.destroyed }
    async loadURL(url: string): Promise<void> {
      const to = this.redirects.get(url)
      if (to) {
        let stopped = false
        this.emit('will-redirect', { url: to, isMainFrame: true, isSameDocument: false, preventDefault: () => { stopped = true } }, to, false, true)
        if (stopped) return
        this.url = to
        return
      }
      this.url = url
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
  const web = { webRequest: { onBeforeRequest: vi.fn() }, setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), on: vi.fn() }
  return { shell: { openExternal: vi.fn() }, WebContentsView: FakeView, session: { fromPartition: () => web } }
})

const win = { isDestroyed: () => false, contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }, getContentSize: () => [1400, 900] }
const KEY = 'thread:t1'
const LOCAL = 'http://127.0.0.1:5173/'
const REMOTE = 'https://shop.test/delete?id=1'
const services: Array<ReturnType<typeof createBrowserService>> = []
afterEach(() => { for (const s of services.splice(0)) s.dispose(); h.views.length = 0 })

async function setup() {
  const service = createBrowserService({ window: () => win as never, cockpitPorts: () => [45871], publish: vi.fn() })
  services.push(service)
  const host = createBrowserAgentHost(service)
  await host.ensure(KEY, '/Users/example/garden')
  return { service, host, contents: h.views[0]!.webContents }
}

/** A hop as Electron reports it: the details object, then the legacy positional arguments. */
const hop = (contents: { emit(event: string, ...args: unknown[]): boolean }, event: string, url: string, isMainFrame = true) => {
  const details = { url, isMainFrame, isSameDocument: false, preventDefault: vi.fn() }
  contents.emit(event, details, url, false, isMainFrame)
  return details.preventDefault
}

describe('u06-1: the service stops an agent-driven hop to an unapproved remote site', () => {
  it('stops a remote hop in each navigation event, and reports the first one when the watch ends', async () => {
    const { service, contents } = await setup()
    const end = service.watchNavigation(KEY, [])
    for (const event of ['will-redirect', 'will-navigate', 'will-frame-navigate']) expect(hop(contents, event, REMOTE)).toHaveBeenCalled()
    expect(end()).toBe(REMOTE)
  })

  it('lets through an approved origin, a local app and a subframe; Cockpit itself stays refused', async () => {
    const { service, contents } = await setup()
    const end = service.watchNavigation(KEY, ['https://shop.test'])
    expect(hop(contents, 'will-redirect', REMOTE)).not.toHaveBeenCalled()
    expect(hop(contents, 'will-redirect', 'http://localhost:3000/next')).not.toHaveBeenCalled()
    expect(hop(contents, 'will-redirect', 'https://ads.test/frame', false)).not.toHaveBeenCalled()
    // Cockpit itself is still refused by the existing rule, watch or not.
    expect(hop(contents, 'will-redirect', 'http://127.0.0.1:45871/')).toHaveBeenCalled()
    expect(end()).toBeUndefined()
  })

  it('does nothing when no agent navigation is being watched, or after it ended', async () => {
    const { service, contents } = await setup()
    expect(hop(contents, 'will-redirect', REMOTE)).not.toHaveBeenCalled()
    const end = service.watchNavigation(KEY, [])
    end()
    expect(hop(contents, 'will-navigate', REMOTE)).not.toHaveBeenCalled()
  })

  it('goto reports a vetoed redirect as blocked, and the page stays where it was', async () => {
    const { host, contents } = await setup()
    contents.redirects.set(LOCAL, REMOTE)
    const landing = await host.goto(KEY, LOCAL)
    expect(landing.blocked).toBe(REMOTE)
    expect(landing.url).toBe('about:blank')
    expect(contents.url).toBe('about:blank')
  })

  it('goto follows the redirect when its origin was approved for the call, and the watch ends with the call', async () => {
    const { host, contents } = await setup()
    contents.redirects.set(LOCAL, REMOTE)
    const landing = await host.goto(KEY, LOCAL, ['https://shop.test'])
    expect(landing.blocked).toBeUndefined()
    expect(landing.url).toBe(REMOTE)
    // Afterwards the person browsing is not held to the agent's approvals.
    expect(hop(contents, 'will-navigate', 'https://elsewhere.test/')).not.toHaveBeenCalled()
  })
})
