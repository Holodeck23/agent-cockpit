import { realpathSync } from 'node:fs'
import { shell, WebContentsView, session as sessions, type BrowserWindow, type Session, type WebContents } from 'electron'
import { evictions, isAllowedRequest, isNavigable, partitionFor, RESIDENCY, roomForPage, validBounds, type Bounds, type ResidentPage } from './browser-policy.ts'
import { withinTime } from './one-at-a-time.ts'

// The in-app browser (H1/H2, wave 9): one page per conversation, owned by this process.
// Each page is a sandboxed WebContentsView with no preload, in its workspace's own persistent
// partition, so website logins never meet Cockpit's control session or another workspace.
// The page reports the pane's rectangle; only one page is visible at a time, and a page is
// hidden (not destroyed) while a Cockpit menu or dialog needs that part of the window.

export interface PageState {
  readonly key: string
  readonly url: string
  readonly title: string
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly loading: boolean
  readonly error?: { readonly code: number; readonly description: string; readonly url: string }
  /** Cockpit unloaded this page while it was idle and loaded it again: typed input did not survive. */
  readonly reloaded?: boolean
}

/** A page that could not open because every loaded page is in use (W9-10). */
export interface CapacityRefusal {
  readonly error: string
  readonly capacity: ReadonlyArray<{ readonly key: string; readonly title: string; readonly url: string; readonly unsaved: boolean }>
}

export type NavAction = 'back' | 'forward' | 'reload' | 'stop'

interface Page {
  readonly view: WebContentsView
  readonly partition: string
  readonly projectPath: string
  error?: PageState['error']
  attached: boolean
  /** Changes on every navigation and viewport resize; drawn from one counter, so no two pages share one. */
  revision: number
  lastUsed: number
  downloads: number
  reloaded: boolean
}

/** A page's size before the pane has ever placed it (an agent opened it in the background). */
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const

export interface BrowserServiceDeps {
  readonly window: () => BrowserWindow | undefined
  /** Cockpit's own listener ports, read per request: they are known only once the server runs. */
  readonly cockpitPorts: () => readonly number[]
  readonly publish: (state: PageState) => void
  /** An agent call or grant is using this page now (server/browser/agent.ts). */
  readonly inUse?: (key: string) => boolean
  readonly limits?: { readonly maxIdle: number; readonly idleMs: number; readonly maxTotal: number }
}

/** True when the page holds input the person typed and has not sent (checked before unloading it). */
const UNSAVED_SCRIPT = `(() => [...document.querySelectorAll('input,textarea,select')].some((el) =>
  el.type === 'checkbox' || el.type === 'radio' ? el.checked !== el.defaultChecked
    : el.tagName === 'SELECT' ? [...el.options].some((o) => o.selected !== o.defaultSelected)
    : !['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(el.type) && el.value !== el.defaultValue))()`
const PROBE_WORLD = 1718
const PROBE_MS = 1000

const canonical = (path: string): string => { try { return realpathSync(path) } catch { return path } }

export function createBrowserService(deps: BrowserServiceDeps) {
  const pages = new Map<string, Page>()
  const guarded = new Set<Session>()
  const destroyedListeners = new Set<(key: string) => void>()
  const limits = deps.limits ?? RESIDENCY
  /** Pages Cockpit unloaded while idle, with the address each was on. */
  const unloaded = new Map<string, string>()
  let lastShown: string | undefined
  let revisions = 0
  const bump = (page: Page): void => { page.revision = ++revisions }

  // Installed once per partition, never on the control session (whose one onBeforeSendHeaders
  // listener carries the window key, electron/window-key.ts).
  function guard(web: Session): void {
    if (guarded.has(web)) return
    guarded.add(web)
    web.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isAllowedRequest(details.url, deps.cockpitPorts()) }))
    web.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    web.setPermissionCheckHandler(() => false)
    // Downloads: no save path is set, so Electron asks the person where to save (or they cancel).
    // A page with a download under way is not unloaded.
    web.on('will-download', (_event, item, contents) => {
      const page = [...pages.values()].find((p) => p.view.webContents === contents)
      if (!page) return
      page.downloads++
      item.once('done', () => { page.downloads = Math.max(0, page.downloads - 1) })
    })
  }

  function stateOf(key: string, page: Page): PageState {
    const contents = page.view.webContents
    return {
      key,
      url: contents.getURL(),
      title: contents.getTitle(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      loading: contents.isLoading(),
      ...(page.error ? { error: page.error } : {}),
      ...(page.reloaded ? { reloaded: true } : {}),
    }
  }
  const publish = (key: string): void => {
    const page = pages.get(key)
    if (page && !page.view.webContents.isDestroyed()) deps.publish(stateOf(key, page))
  }

  function create(key: string, projectPath: string): Page {
    const partition = partitionFor(canonical(projectPath))
    const web = sessions.fromPartition(partition)
    guard(web)
    // backgroundThrottling off: a page the person is not looking at still takes hover and wheel
    // input from its agent (order 11 input experiment); W9-10 residency bounds what that costs.
    const view = new WebContentsView({ webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    const page: Page = { view, partition, projectPath, attached: false, revision: 0, lastUsed: Date.now(), downloads: 0, reloaded: unloaded.delete(key) }
    bump(page)
    view.setBounds({ x: 0, y: 0, ...DEFAULT_VIEWPORT })
    view.setVisible(false)
    const contents = view.webContents
    // A new window opens in this same page when it is an allowed address; nothing else opens.
    contents.setWindowOpenHandler(({ url }) => {
      if (isNavigable(url, deps.cockpitPorts())) void contents.loadURL(url).catch(() => undefined)
      return { action: 'deny' }
    })
    const stay = (event: { preventDefault(): void }, url: string): void => { if (!isNavigable(url, deps.cockpitPorts())) event.preventDefault() }
    contents.on('will-navigate', stay)
    contents.on('will-redirect', stay)
    contents.on('will-frame-navigate', (details) => { if (!isAllowedRequest(details.url, deps.cockpitPorts())) details.preventDefault() })
    contents.on('did-start-navigation', (details) => { if (details.isMainFrame && !details.isSameDocument) page.error = undefined })
    contents.on('did-navigate', () => bump(page))
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => { if (isMainFrame) bump(page) })
    contents.once('destroyed', () => {
      if (pages.get(key) === page) pages.delete(key)
      for (const listener of destroyedListeners) listener(key)
    })
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // -3 is an aborted load: a new navigation replaced it, or Stop.
      if (isMainFrame && code !== -3) page.error = { code, description, url }
      publish(key)
    })
    contents.on('will-prevent-unload', (event) => event.preventDefault())
    for (const event of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated'] as const) {
      contents.on(event as 'did-start-loading', () => publish(key))
    }
    pages.set(key, page)
    attach(page)
    return page
  }

  const touch = (page: Page | undefined): void => { if (page) page.lastUsed = Date.now() }

  // ---------- residency (W9-10): at most `maxIdle` idle pages, idle ones unloaded after `idleMs` ----------
  // The last page shown (hidden now only by an overlay, or just left) is spared by the idle sweep,
  // but not when the person opens another page: their attention has moved to that one.
  const pinned = (key: string, page: Page, opening = false): boolean =>
    page.view.getVisible() || (!opening && key === lastShown) || page.downloads > 0 || (deps.inUse?.(key) ?? false)
  const resident = (opening = false): ResidentPage[] => [...pages].map(([key, page]) => ({ key, lastUsed: page.lastUsed, pinned: pinned(key, page, opening) }))
  /** Unsaved input, or a page too busy to answer, keeps a page loaded. */
  async function unsaved(page: Page): Promise<boolean> {
    if (page.view.webContents.isDestroyed()) return false
    try {
      return await withinTime(page.view.webContents.executeJavaScriptInIsolatedWorld(PROBE_WORLD, [{ code: UNSAVED_SCRIPT }]) as Promise<boolean>, PROBE_MS, 'busy') === true
    } catch {
      return true
    }
  }
  /** Unloads one page, remembering its address so it can come back (visibly reloaded). */
  async function unload(key: string, opening = false): Promise<boolean> {
    const page = pages.get(key)
    if (!page || pinned(key, page, opening) || await unsaved(page)) return false
    if (pages.get(key) !== page || pinned(key, page, opening)) return false
    const url = page.view.webContents.getURL()
    if (/^https?:\/\//.test(url)) unloaded.set(key, url)
    service.close(key)
    return true
  }
  async function sweep(): Promise<void> {
    for (const key of evictions(resident(), Date.now(), limits)) await unload(key)
  }
  /**
   * Before a new page loads: unloads the oldest idle page when all `maxTotal` are loaded. A page
   * that turns out to hold unsaved typing stays, and the next oldest is tried.
   */
  async function makeRoom(): Promise<CapacityRefusal | undefined> {
    const tried = new Set<string>()
    for (;;) {
      const room = roomForPage(resident(true).map((p) => (tried.has(p.key) ? { ...p, pinned: true } : p)), limits.maxTotal)
      if (!('full' in room) && !room.evict) return undefined
      if ('evict' in room && room.evict) { tried.add(room.evict); await unload(room.evict, true); continue }
      const capacity = await Promise.all([...pages].map(async ([key, page]) => ({ key, title: page.view.webContents.getTitle(), url: page.view.webContents.getURL(), unsaved: await unsaved(page) })))
      return { error: `Cockpit already has ${pages.size} pages loaded and all of them are in use (shown, used by an agent, downloading or holding unsaved typing). Close one of them to open another.`, capacity }
    }
  }
  const timer = setInterval(() => void sweep(), Math.max(1000, Math.min(30_000, limits.idleMs / 2)))
  timer.unref?.()

  function attach(page: Page): BrowserWindow | undefined {
    const win = deps.window()
    if (!win || win.isDestroyed()) return undefined
    if (!page.attached) { win.contentView.addChildView(page.view); page.attached = true }
    return win
  }

  const service = {
    /** Opens `url` in the conversation's page, creating it in the workspace's partition if needed. */
    async open(key: string, projectPath: string, url: string): Promise<PageState | { error: string } | CapacityRefusal> {
      if (!isNavigable(url, deps.cockpitPorts())) return { error: 'Only http and https pages open here, and not Cockpit itself.' }
      if (!pages.has(key)) {
        const full = await makeRoom()
        if (full) return full
      }
      const page = pages.get(key) ?? create(key, projectPath)
      touch(page)
      page.error = undefined
      // Not awaited: a page that never finishes loading must not hold the caller. Progress,
      // the final address and any error arrive as state events.
      void page.view.webContents.loadURL(url).catch(() => undefined)
      return stateOf(key, page)
    },
    /** Loads `url` in an existing page (the agent's navigate); an error message when it may not. */
    load(key: string, url: string): string | undefined {
      const page = pages.get(key)
      if (!page) return 'This conversation has no page.'
      // Checked here as well as on the server: no path into a page skips the host's own rule.
      if (!isNavigable(url, deps.cockpitPorts())) return 'Only http and https pages open here, and not Cockpit itself.'
      touch(page)
      page.error = undefined
      void page.view.webContents.loadURL(url).catch(() => undefined)
      return undefined
    },
        /** The page's place in the window; undefined hides it. Showing one page hides the others. */
    place(key: string, rect: unknown): void {
      const page = pages.get(key)
      if (!page) return
      const win = attach(page)
      if (!win) return
      const [width, height] = win.getContentSize()
      const bounds: Bounds | undefined = rect === null ? undefined : validBounds(rect, { width: width!, height: height! })
      if (!bounds) { page.view.setVisible(false); return }
      for (const [other, p] of pages) if (other !== key) p.view.setVisible(false)
      lastShown = key
      touch(page)
      const before = page.view.getBounds()
      if (before.width !== bounds.width || before.height !== bounds.height) bump(page)
      page.view.setBounds(bounds)
      page.view.setVisible(true)
    },
    navigate(key: string, action: NavAction): void {
      const contents = pages.get(key)?.view.webContents
      if (!contents) return
      touch(pages.get(key))
      if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
      else if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
      else if (action === 'reload') contents.reload()
      else if (action === 'stop') contents.stop()
    },
    state(key: string): PageState | undefined {
      const page = pages.get(key)
      return page && !page.view.webContents.isDestroyed() ? stateOf(key, page) : undefined
    },
    /** Opens the page's address in the default browser: an explicit person action only. */
    openExternal(key: string): void {
      const url = pages.get(key)?.view.webContents.getURL()
      if (url && /^https?:\/\//.test(url)) void shell.openExternal(url)
    },
    close(key: string): void {
      const page = pages.get(key)
      if (!page) return
      pages.delete(key)
      if (lastShown === key) lastShown = undefined
      const win = deps.window()
      if (page.attached && win && !win.isDestroyed()) win.contentView.removeChildView(page.view)
      if (!page.view.webContents.isDestroyed()) page.view.webContents.close()
    },
    /** Clears one workspace's website data (logins, storage, cache), refused while one of its pages loads. */
    async clearData(projectPath: string): Promise<string | undefined> {
      const partition = partitionFor(canonical(projectPath))
      if ([...pages.values()].some((p) => p.partition === partition && p.view.webContents.isLoading())) return 'A page in this project is still loading. Try again when it has finished.'
      const web = sessions.fromPartition(partition)
      await web.clearStorageData()
      await web.clearCache()
      return undefined
    },
    /** The window was closed: its views went with it. */
    forgetAll(): void {
      const keys = [...pages.keys()]
      pages.clear()
      for (const key of keys) for (const listener of destroyedListeners) listener(key)
    },
    /** For the agent tools (electron/browser-agent-host.ts): the page itself, never handed to the renderer. */
    agentPage(key: string): { readonly contents: WebContents; readonly revision: number; readonly viewport: { width: number; height: number } } | undefined {
      const page = pages.get(key)
      if (!page || page.view.webContents.isDestroyed()) return undefined
      touch(page)
      const { width, height } = page.view.getBounds()
      return { contents: page.view.webContents, revision: page.revision, viewport: { width, height } }
    },
    /**
     * The conversation's page, created hidden in its workspace's partition when it has none: blank,
     * or back at its last address (marked reloaded) when Cockpit unloaded it. An error when full.
     */
    async ensure(key: string, projectPath: string): Promise<string | undefined> {
      if (pages.has(key)) return undefined
      const full = await makeRoom()
      if (full) return `${full.error} Loaded pages: ${full.capacity.map((p) => p.title || p.url).join(', ')}.`
      if (pages.has(key)) return undefined
      const last = unloaded.get(key)
      const page = create(key, projectPath)
      if (last) void page.view.webContents.loadURL(last).catch(() => undefined)
      return undefined
    },
    /** For the capacity explanation: does this page hold unsaved typing? */
    async hasUnsaved(key: string): Promise<boolean> {
      const page = pages.get(key)
      return page ? unsaved(page) : false
    },
    sweep,
    onDestroyed(listener: (key: string) => void): () => void {
      destroyedListeners.add(listener)
      return () => destroyedListeners.delete(listener)
    },
    dispose(): void { clearInterval(timer) },
  }
  return service
}

export type BrowserService = ReturnType<typeof createBrowserService>
