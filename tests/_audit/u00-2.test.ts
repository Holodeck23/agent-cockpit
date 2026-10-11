import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserService } from '../../electron/browser-service.ts'
import { registerBrowserIpc } from '../../electron/browser-ipc.ts'

// u00-2: Page.reloaded is set when Cockpit recreates a page it unloaded, and nothing ever clears
// it, so the pane's "Reloaded: Cockpit unloaded this page" notice returns on every remount
// (BrowserPane keeps its OK only in local state, and remounts per page). The main process has to
// be told the person has seen it: acknowledgeReload(key) clears the flag for that page, and the
// page reaches it over 'cockpit:browser-reload-seen' (electron/preload.ts and BrowserPane.tsx send it).

const h = vi.hoisted(() => ({
  views: [] as Array<{ webContents: { closeCalls: number; destroyed: boolean; finishDestroy: () => void } }>,
  ipc: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
}))

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
  const ipcMain = { on: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => h.ipc.set(channel, fn), handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => h.ipc.set(channel, fn) }
  return { shell: { openExternal: vi.fn() }, WebContentsView: FakeView, session: { fromPartition: () => web }, ipcMain }
})

const win = { isDestroyed: () => false, contentView: { addChildView: vi.fn(), removeChildView: vi.fn() }, getContentSize: () => [1400, 900] }
const make = (limits = { maxIdle: 4, idleMs: 60 * 60_000, maxTotal: 8 }) =>
  createBrowserService({ window: () => win as never, cockpitPorts: () => [45871], publish: vi.fn(), limits })

const KEY = 'thread:t1'
const services: Array<ReturnType<typeof make>> = []
afterEach(() => { for (const s of services.splice(0)) s.dispose() })

describe('u00-2 reloaded notice', () => {
  it('stops reporting a page as reloaded once the person has acknowledged it', async () => {
    const service = make({ maxIdle: 4, idleMs: 0, maxTotal: 8 })
    services.push(service)
    await service.open(KEY, '/tmp/u00-2-project', 'https://example.com/a')
    await service.sweep() // idle past idleMs: unloaded, address remembered
    expect(service.state(KEY)).toBeUndefined()
    expect(await service.ensure(KEY, '/tmp/u00-2-project')).toBeUndefined()
    expect(service.state(KEY)?.reloaded).toBe(true)

    service.acknowledgeReload(KEY)
    expect(service.state(KEY)?.reloaded).toBeUndefined()
    expect(service.state(KEY)?.url).toBe('https://example.com/a')
  })

  it('reports it again when the page is unloaded and recreated again', async () => {
    const service = make({ maxIdle: 4, idleMs: 0, maxTotal: 8 })
    services.push(service)
    await service.open(KEY, '/tmp/u00-2-project', 'https://example.com/a')
    await service.sweep()
    await service.ensure(KEY, '/tmp/u00-2-project')
    service.acknowledgeReload(KEY)
    await service.sweep()
    await service.ensure(KEY, '/tmp/u00-2-project')
    expect(service.state(KEY)?.reloaded).toBe(true)
  })

  it('hears the acknowledgement from Cockpit\'s own page only', async () => {
    const service = make({ maxIdle: 4, idleMs: 0, maxTotal: 8 })
    services.push(service)
    registerBrowserIpc('http://127.0.0.1:45871', service, () => true, (event) => (event as { main?: boolean }).main === true)
    await service.open(KEY, '/tmp/u00-2-project', 'https://example.com/a')
    await service.sweep()
    await service.ensure(KEY, '/tmp/u00-2-project')
    const seen = h.ipc.get('cockpit:browser-reload-seen')!
    const from = (url: string, main: boolean) => ({ senderFrame: { url }, main })

    seen(from('https://example.com/', true), KEY) // a website, not Cockpit
    seen(from('http://127.0.0.1:45871/', false), KEY) // not the main window
    expect(service.state(KEY)?.reloaded).toBe(true)

    seen(from('http://127.0.0.1:45871/', true), KEY)
    expect(service.state(KEY)?.reloaded).toBeUndefined()
  })
})
