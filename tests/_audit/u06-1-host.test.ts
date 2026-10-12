import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserAgentHost } from '../../electron/browser-agent-host.ts'
import { createBrowserService, PERSON_INPUT_MS } from '../../electron/browser-service.ts'
import { guardLocalPreview } from '../../electron/preview-navigation.ts'
import { createBrowserAgent } from '../../server/browser/agent.ts'
import { createBrowserLeases } from '../../server/browser/agent-policy.ts'

// u06-1 (host half): electron/browser-service.ts holds every main-frame request of a page an agent drives
// (a redirect hop, a script's navigation, a popup, a restored page) for the guard the agent installed
// (guardNavigation) before the request goes out, and cancels the ones the guard refuses.
// electron/browser-agent-host.ts turns a refusal into an error for the call, with the guard's own reason.
// Outside an agent's guard nothing changes: the person browses freely.
// (This replaced a will-redirect/will-navigate watch that only covered the agent's own call window.)
//
// The fake page below behaves as Chromium does where it matters here (each point checked in real Electron by
// scripts/proof-browser-navigation-security.ts):
//  - a main-frame request that is cancelled commits Chromium's error page for the refused address, so the page
//    is THERE, unless the navigation was stopped (webContents.stop()) before the request was cancelled;
//  - the page reports every input event, the agent's sendInputEvent included, through before-input-event and
//    before-mouse-event, at once, before sendInputEvent returns.

const h = vi.hoisted(() => ({
  views: [] as Array<{ webContents: { id: number; url: string; redirects: Map<string, string>; stops: number; sent: Array<{ type: string }>; loadURL(url: string): Promise<void>; emit(event: string, ...args: unknown[]): boolean } }>,
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
    /** Counts navigations; stop() or a newer one abandons the one in flight. */
    navigation = 0
    stops = 0
    sent: Array<{ type: string }> = []
    sendInputEvent(event: { type: string }): void {
      this.sent.push(event)
      if (event.type.startsWith('mouse')) this.emit('before-mouse-event', { preventDefault() {} }, event)
      else if (event.type === 'keyDown' || event.type === 'keyUp') this.emit('before-input-event', { preventDefault() {} }, event)
    }
    async executeJavaScriptInIsolatedWorld(): Promise<unknown> { return { text: 'start page', truncated: false, elements: [], scroll: { x: 0, y: 0 } } }
    stop(): void {
      this.stops++
      if (!this.loading) return
      this.navigation++
      this.loading = false
      this.emit('did-fail-load', {}, -3, 'ERR_ABORTED', this.url, true)
    }
    getURL(): string { return this.url }
    getTitle(): string { return '' }
    isLoading(): boolean { return this.loading }
    isDestroyed(): boolean { return this.destroyed }
    reload(): void {}
    async loadURL(url: string): Promise<void> {
      const mine = ++this.navigation
      this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
      this.loading = true
      let next = url
      for (let hop = 0; hop < 10; hop++) {
        const cancelled = await request(this.id, next)
        if (this.navigation !== mine) return // stopped while the request was held: nothing commits
        if (cancelled) {
          this.url = next // not stopped: Chromium commits its error page for the refused address
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
const DENIED = 'Browser action denied by the user'
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

// Recheck of the merge of PR #58, problem 2: a refused navigation left Chromium's error page for the refused address
// as the page, and the agent's next read asked about that site.
describe('u06-1: a navigation the guard refuses leaves the page where it was', () => {
  const START = 'http://127.0.0.1:3000/start'
  const GO = 'http://127.0.0.1:3000/go'

  it('keeps the document and its address, reports no error page, and hands the reason to the call that asked, once', async () => {
    const { service, host, contents, navigated } = await setup()
    contents.url = START
    contents.redirects.set(GO, REMOTE)
    host.guardNavigation(KEY, async (url) => { if (url === REMOTE) throw new Error(DENIED) })
    await expect(host.goto(KEY, GO)).rejects.toThrow(DENIED)
    expect(contents.url).toBe(START)
    expect(contents.stops).toBe(1)
    expect(service.state(KEY)).toMatchObject({ url: START, loading: false })
    expect(service.state(KEY)).not.toHaveProperty('error')
    expect(host.info(KEY)).toMatchObject({ url: START, origin: 'http://127.0.0.1:3000' })
    expect(host.info(KEY)).not.toHaveProperty('error')
    expect(navigated).not.toHaveBeenCalled()
    // The reason belongs to that one call: the next navigation does not inherit it.
    expect(service.takeDenial(KEY)).toBeUndefined()
    contents.redirects.delete(GO)
    await expect(host.goto(KEY, GO)).resolves.toMatchObject({ url: GO })
  })

  it('does the same for a page that starts the navigation itself (a script or a popup), with nobody waiting on it', async () => {
    const { service, host, contents } = await setup()
    contents.url = START
    host.guardNavigation(KEY, async () => { throw new Error('The browser run ended or was stopped; navigation was blocked.') })
    await contents.loadURL(REMOTE)
    expect(contents.url).toBe(START)
    expect(service.state(KEY)).not.toHaveProperty('error')
  })

  it('the agent\'s next read does not ask about the site that was refused', async () => {
    const { host, contents } = await setup()
    const asked: string[] = []
    const agent = createBrowserAgent({
      host: () => host, leases: createBrowserLeases(), cockpitPorts: () => [45871], currentRun: () => 'r1',
      approve: async (_grant, tool, input) => { asked.push(`${tool} ${String(input.origin)}`); throw new Error(DENIED) },
    })
    const call = (op: string, body: unknown = {}) => agent.handle({ threadId: 't1', projectPath: '/Users/example/garden', cwd: '/Users/example/garden' }, op, body, new AbortController().signal)
    await call('navigate', { url: START })
    contents.redirects.set(GO, REMOTE)
    await expect(call('navigate', { url: GO })).rejects.toMatchObject({ status: 409, message: DENIED })
    expect(asked).toEqual(['mcp__cockpit__browser_navigate https://shop.test'])
    // The page is the local one it was on: reading it needs no approval, and nothing says it failed to load.
    const read = await call('read') as { text: string; page: { url: string; error?: unknown } }
    expect(read).toMatchObject({ text: 'start page', page: { url: START } })
    expect(read.page.error).toBeUndefined()
    expect(asked).toEqual(['mcp__cockpit__browser_navigate https://shop.test'])
  })
})

// Recheck of the merge of PR #58, problem 3: the wait for the person's answer was one absolute 60 s budget per call.
describe('u06-1: goto waits for each ask in a redirect chain for its own approval window', () => {
  const SECOND = 'https://second.test/landing'

  it('a chain that asks twice, each answered after 44 s, lands on the last page instead of returning a half-loaded one', async () => {
    vi.useFakeTimers()
    const { host, contents } = await setup()
    contents.redirects.set(LOCAL, REMOTE)
    contents.redirects.set(REMOTE, SECOND)
    host.guardNavigation(KEY, (url) => (url === LOCAL ? Promise.resolve() : new Promise<void>((resolve) => setTimeout(resolve, 44_000))))
    const landing = host.goto(KEY, LOCAL)
    await vi.advanceTimersByTimeAsync(100_000)
    const page = await landing
    expect(page).toMatchObject({ url: SECOND, loading: false })
    expect(contents.url).toBe(SECOND)
  })

  it('an ask nobody answers still ends the wait (with the page still loading), at its own window', async () => {
    vi.useFakeTimers()
    const { host } = await setup()
    host.guardNavigation(KEY, () => new Promise<void>(() => {}))
    let settled = false
    const landing = host.goto(KEY, REMOTE).finally(() => { settled = true })
    await vi.advanceTimersByTimeAsync(55_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(25_000)
    expect(settled).toBe(true)
    expect(await landing).toMatchObject({ loading: true })
  })
})

// Recheck of the merge of PR #58, problem 1: once the run had ended the guard refused everything, the person's own
// link clicks in the pane included.
describe('u06-1: after the run is over, the person\'s own navigation works and the page\'s own does not', () => {
  const NEXT = 'http://127.0.0.1:3000/next'
  const ENDED = 'The browser run ended or was stopped; navigation was blocked.'
  const noDefault = { preventDefault() {} }
  const click = (contents: { emit(event: string, ...args: unknown[]): boolean }): void => {
    contents.emit('before-mouse-event', noDefault, { type: 'mouseDown', x: 5, y: 5 })
    contents.emit('before-mouse-event', noDefault, { type: 'mouseUp', x: 5, y: 5 })
  }
  /** The guard of a run that has ended: refuses everything, and says the run is over. */
  const endedRun = (host: ReturnType<typeof createBrowserAgentHost>): void => {
    host.guardNavigation(KEY, async () => { throw new Error(ENDED) }, { over: () => true })
  }

  it('a link the person clicks loads, and the page is the person\'s from then on', async () => {
    const { service, host, contents } = await setup()
    endedRun(host)
    click(contents)
    expect(await request(contents.id, NEXT)).toBe(false)
    expect(service.state(KEY)).not.toHaveProperty('error')
    expect(await request(contents.id, REMOTE)).toBe(false)
  })

  it('so does Enter in a form, or any key the person presses', async () => {
    const { host, contents } = await setup()
    endedRun(host)
    contents.emit('before-input-event', noDefault, { type: 'keyDown', key: 'Enter' })
    expect(await request(contents.id, NEXT)).toBe(false)
  })

  it('a navigation the page starts on its own stays refused: no input at all, or a click long ago', async () => {
    vi.useFakeTimers()
    const { host, contents } = await setup()
    endedRun(host)
    expect(await request(contents.id, REMOTE)).toBe(true)
    click(contents)
    await vi.advanceTimersByTimeAsync(PERSON_INPUT_MS + 1)
    // A click that was not followed by a navigation did not take the page away from the guard.
    expect(await request(contents.id, REMOTE)).toBe(true)
  })

  it('a pointer move, a wheel or a key release is not the person asking for a page', async () => {
    const { host, contents } = await setup()
    endedRun(host)
    for (const type of ['mouseMove', 'mouseWheel', 'mouseEnter', 'mouseLeave']) contents.emit('before-mouse-event', noDefault, { type, x: 5, y: 5 })
    contents.emit('before-input-event', noDefault, { type: 'keyUp', key: 'Enter' })
    expect(await request(contents.id, NEXT)).toBe(true)
  })

  it('while the run is still going, the person\'s click still goes through the guard, which asks as before', async () => {
    const { host, contents } = await setup()
    const seen: string[] = []
    let live = true
    host.guardNavigation(KEY, async (url) => { seen.push(url); if (url === REMOTE) throw new Error(DENIED) }, { over: () => !live })
    click(contents)
    expect(await request(contents.id, REMOTE)).toBe(true)
    expect(seen).toEqual([REMOTE])
    live = false
    expect(await request(contents.id, REMOTE)).toBe(false)
    expect(seen).toEqual([REMOTE])
  })

  it('the agent\'s own click and keys are not the person\'s, though Chromium reports them the same way', async () => {
    const { service, host, contents } = await setup()
    endedRun(host)
    service.sendAgentInput(KEY, { type: 'mouseDown', x: 5, y: 5, button: 'left', clickCount: 1 })
    service.sendAgentInput(KEY, { type: 'mouseUp', x: 5, y: 5, button: 'left', clickCount: 1 })
    service.sendAgentInput(KEY, { type: 'keyDown', keyCode: 'Enter' })
    expect(contents.sent.map((e) => e.type)).toEqual(['mouseDown', 'mouseUp', 'keyDown'])
    expect(await request(contents.id, NEXT)).toBe(true)
    // And once the agent's call returns, the person's input counts again.
    click(contents)
    expect(await request(contents.id, NEXT)).toBe(false)
  })

  it('an agent action goes through the service as the agent\'s input', async () => {
    vi.useFakeTimers()
    const { host, contents } = await setup()
    endedRun(host)
    const page = host.info(KEY)!
    const acting = host.act(KEY, { kind: 'click', x: 10, y: 10 }, { revision: page.revision, origin: page.origin })
    await vi.advanceTimersByTimeAsync(500)
    expect(await acting).toMatchObject({ outcome: 'done' })
    expect(contents.sent.map((e) => e.type)).toEqual(['mouseMove', 'mouseDown', 'mouseUp'])
    expect(await request(contents.id, NEXT)).toBe(true)
  })

  it('the preview guard yields to the person too: their link out of their own app is theirs to follow', async () => {
    const { host, contents } = await setup()
    guardLocalPreview(host, KEY, () => [45871])
    expect(await request(contents.id, 'http://127.0.0.1:3000/')).toBe(false)
    expect(await request(contents.id, REMOTE)).toBe(true)
    click(contents)
    expect(await request(contents.id, REMOTE)).toBe(false)
  })

  it('the person\'s input in one conversation\'s page does not lift another page\'s guard', async () => {
    const { host, contents } = await setup()
    await host.ensure('thread:t2', '/Users/example/garden')
    const other = h.views[1]!.webContents
    endedRun(host)
    host.guardNavigation('thread:t2', async () => { throw new Error(ENDED) }, { over: () => true })
    click(other)
    expect(await request(other.id, NEXT)).toBe(false)
    expect(await request(contents.id, NEXT)).toBe(true)
  })
})

