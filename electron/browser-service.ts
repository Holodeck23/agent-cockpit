import { realpathSync } from 'node:fs'
import { shell, WebContentsView, session as sessions, type BrowserWindow, type Session } from 'electron'
import { isAllowedRequest, isNavigable, partitionFor, validBounds, type Bounds } from './browser-policy.ts'

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
}

export type NavAction = 'back' | 'forward' | 'reload' | 'stop'

interface Page {
  readonly view: WebContentsView
  readonly partition: string
  error?: PageState['error']
  attached: boolean
}

export interface BrowserServiceDeps {
  readonly window: () => BrowserWindow | undefined
  /** Cockpit's own listener ports, read per request: they are known only once the server runs. */
  readonly cockpitPorts: () => readonly number[]
  readonly publish: (state: PageState) => void
}

const canonical = (path: string): string => { try { return realpathSync(path) } catch { return path } }

export function createBrowserService(deps: BrowserServiceDeps) {
  const pages = new Map<string, Page>()
  const guarded = new Set<Session>()

  // Installed once per partition, never on the control session (whose one onBeforeSendHeaders
  // listener carries the window key, electron/window-key.ts).
  function guard(web: Session): void {
    if (guarded.has(web)) return
    guarded.add(web)
    web.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isAllowedRequest(details.url, deps.cockpitPorts()) }))
    web.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    web.setPermissionCheckHandler(() => false)
    // Downloads: no save path is set, so Electron asks the person where to save (or they cancel).
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
    const view = new WebContentsView({ webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false } })
    const page: Page = { view, partition, attached: false }
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
    return page
  }

  function attach(page: Page): BrowserWindow | undefined {
    const win = deps.window()
    if (!win || win.isDestroyed()) return undefined
    if (!page.attached) { win.contentView.addChildView(page.view); page.attached = true }
    return win
  }

  return {
    /** Opens `url` in the conversation's page, creating it in the workspace's partition if needed. */
    async open(key: string, projectPath: string, url: string): Promise<PageState | { error: string }> {
      if (!isNavigable(url, deps.cockpitPorts())) return { error: 'Only http and https pages open here, and not Cockpit itself.' }
      const page = pages.get(key) ?? create(key, projectPath)
      page.error = undefined
      await page.view.webContents.loadURL(url).catch(() => undefined)
      return stateOf(key, page)
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
      page.view.setBounds(bounds)
      page.view.setVisible(true)
    },
    navigate(key: string, action: NavAction): void {
      const contents = pages.get(key)?.view.webContents
      if (!contents) return
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
    forgetAll(): void { pages.clear() },
  }
}

export type BrowserService = ReturnType<typeof createBrowserService>
