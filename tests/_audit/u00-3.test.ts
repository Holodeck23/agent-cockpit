import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserService } from '../../electron/browser-service.ts'

// u00-3: forgetAll() (the main window closed) clears the page records and says "its views went
// with it", but never closes the WebContents. Cockpit stays alive on macOS after the window
// closes, so the renderers keep running (media, polling, logins) where the idle sweep can no
// longer see them. Every teardown path closes the WebContents; this one has to as well.

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

const services: Array<ReturnType<typeof make>> = []
afterEach(() => { for (const s of services.splice(0)) s.dispose(); h.views.length = 0 })

describe('u00-3 forgetAll', () => {
  it('closes every page it forgets, and announces each key once', async () => {
    const service = make()
    services.push(service)
    const gone: string[] = []
    service.onDestroyed((key) => gone.push(key))
    await service.open('thread:a', '/tmp/u00-3-project', 'https://example.com/a')
    await service.open('thread:b', '/tmp/u00-3-project', 'https://example.com/b')
    expect(h.views).toHaveLength(2)

    service.forgetAll()

    expect(h.views.map((v) => v.webContents.closeCalls)).toEqual([1, 1])
    expect(service.state('thread:a')).toBeUndefined()
    expect(service.state('thread:b')).toBeUndefined()
    expect(gone.sort()).toEqual(['thread:a', 'thread:b'])
  })

  it('leaves a WebContents that is already destroyed alone', async () => {
    const service = make()
    services.push(service)
    await service.open('thread:a', '/tmp/u00-3-project', 'https://example.com/a')
    h.views[0]!.webContents.destroyed = true
    expect(() => service.forgetAll()).not.toThrow()
    expect(h.views[0]!.webContents.closeCalls).toBe(0)
  })
})
