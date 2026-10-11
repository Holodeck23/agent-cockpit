import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserService } from '../../electron/browser-service.ts'
import { createBrowserLeases } from '../../server/browser/agent-policy.ts'

// u00-4: a page's 'destroyed' event arrives after close() has already dropped its record, and
// may arrive after a new page exists under the same key. main.ts wires every notification to
// leases.revokePage(key), so the late event wiped the grants the agent had just been given on
// the replacement page. Grants must end when the old page's record goes (close, forgetAll), and a
// late 'destroyed' from a superseded page must not touch its successor's.

const h = vi.hoisted(() => ({ views: [] as Array<{ webContents: { closeCalls: number; destroyed: boolean; finishDestroy: () => void } }> }))

// Just enough of Electron for electron/browser-service.ts: a view whose WebContents is closed
// now and finishes being destroyed only when the test says so (Electron does it later).
vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  class FakeContents extends Emitter {
    url = ''
    destroyed = false
    closeCalls = 0
    navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    setWindowOpenHandler = vi.fn()
    executeJavaScriptInIsolatedWorld = vi.fn(async () => false)
    getURL(): string { return this.url }
    getTitle(): string { return '' }
    isLoading(): boolean { return false }
    isDestroyed(): boolean { return this.destroyed }
    async loadURL(url: string): Promise<void> { this.url = url }
    close(): void { this.closeCalls++ }
    finishDestroy(): void { this.destroyed = true; this.emit('destroyed') }
  }
  class FakeView {
    webContents = new FakeContents()
    visible = false
    bounds = { x: 0, y: 0, width: 0, height: 0 }
    constructor() { h.views.push(this as never) }
    setBounds(bounds: FakeView['bounds']): void { this.bounds = bounds }
    getBounds(): FakeView['bounds'] { return this.bounds }
    setVisible(visible: boolean): void { this.visible = visible }
    getVisible(): boolean { return this.visible }
  }
  const web = { webRequest: { onBeforeRequest: vi.fn() }, setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), on: vi.fn() }
  return { shell: { openExternal: vi.fn() }, WebContentsView: FakeView, session: { fromPartition: () => web } }
})

const win = { isDestroyed: () => false, contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }, getContentSize: () => [1400, 900] }
const make = (limits = { maxIdle: 4, idleMs: 60 * 60_000, maxTotal: 8 }) =>
  createBrowserService({ window: () => win as never, cockpitPorts: () => [45871], publish: vi.fn(), limits })

const KEY = 'thread:t1'
const scope = (origin: string) => ({ threadId: 't1', runId: 'r1', pageKey: KEY, origin })
const services: Array<ReturnType<typeof make>> = []
afterEach(() => { for (const s of services.splice(0)) s.dispose(); h.views.length = 0 })

function wired() {
  const service = make()
  services.push(service)
  const leases = createBrowserLeases()
  service.onDestroyed((key) => leases.revokePage(key)) // as electron/main.ts does
  return { service, leases }
}

describe('u00-4 superseded page', () => {
  it('a late destroyed event from a closed page keeps the replacement page\'s grants', async () => {
    const { service, leases } = wired()
    await service.open(KEY, '/tmp/u00-4-project', 'https://old.example/')
    leases.grant(scope('https://old.example'))
    service.close(KEY) // the old WebContents is still being torn down
    await service.open(KEY, '/tmp/u00-4-project', 'https://new.example/')
    leases.grant(scope('https://new.example'))

    h.views[0]!.webContents.finishDestroy() // the old page's event, after the new page exists

    expect(leases.has(scope('https://new.example'))).toBe(true)
    // The old page's grants ended with it, not carried over to the new page.
    expect(leases.has(scope('https://old.example'))).toBe(false)
  })

  it('still revokes a page\'s grants when the page is closed', async () => {
    const { service, leases } = wired()
    await service.open(KEY, '/tmp/u00-4-project', 'https://old.example/')
    leases.grant(scope('https://old.example'))
    service.close(KEY)
    h.views[0]!.webContents.finishDestroy()
    expect(leases.has(scope('https://old.example'))).toBe(false)
  })

  it('still revokes grants when a page is destroyed under its record', async () => {
    const { service, leases } = wired()
    await service.open(KEY, '/tmp/u00-4-project', 'https://old.example/')
    leases.grant(scope('https://old.example'))
    h.views[0]!.webContents.finishDestroy()
    expect(service.state(KEY)).toBeUndefined()
    expect(leases.has(scope('https://old.example'))).toBe(false)
  })

  it('a late destroyed event after forgetAll keeps the page recreated by the reopened window', async () => {
    const { service, leases } = wired()
    await service.open(KEY, '/tmp/u00-4-project', 'https://old.example/')
    leases.grant(scope('https://old.example'))
    service.forgetAll()
    await service.open(KEY, '/tmp/u00-4-project', 'https://new.example/')
    leases.grant(scope('https://new.example'))
    h.views[0]!.webContents.finishDestroy()
    expect(leases.has(scope('https://new.example'))).toBe(true)
    expect(leases.has(scope('https://old.example'))).toBe(false)
  })
})
