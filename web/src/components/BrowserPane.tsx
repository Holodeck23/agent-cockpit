import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { addressToUrl, originLabel } from '../../../server/browser/address.ts'
import { MOBILE_WIDTH, paneWidth, type PaneLayout } from '../browser-layout.ts'
import { native, type BrowserCapacity, type BrowserPageState } from '../native.ts'
import { useOverlayOver } from '../useOverlayOver.ts'
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, ExpandIcon, ExternalIcon, PhoneIcon, ReloadIcon, RestoreIcon, StopIcon } from './icons.tsx'

// The in-app browser pane (H1/H2, wave 9). The page itself is drawn by the host
// (electron/browser-service.ts) over the viewport box below; this component owns the controls
// and tells the host where that box is, or to hide the page when Cockpit needs the space.

interface BrowserPaneProps {
  readonly pageKey: string
  readonly projectPath: string
  readonly layout: PaneLayout
  /** Changes each time something asks to show `layout.url` again (a link, a process site). */
  readonly openNonce: number
  readonly onLayout: (change: Partial<PaneLayout>) => void
  readonly onClose: () => void
}

export function BrowserPane({ pageKey, projectPath, layout, openNonce, onLayout, onClose }: BrowserPaneProps) {
  const browser = native?.browser
  const [state, setState] = useState<BrowserPageState>()
  const [refused, setRefused] = useState<string>()
  // Every loaded page is in use (W9-10): which ones, so the person can close one.
  const [capacity, setCapacity] = useState<BrowserCapacity>()
  const [reloadNoted, setReloadNoted] = useState(false)
  useEffect(() => { setReloadNoted(false); setCapacity(undefined) }, [pageKey])
  const [draft, setDraft] = useState<string>()
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth)
  const [dragWidth, setDragWidth] = useState<number>()
  const viewport = useRef<HTMLDivElement>(null)
  const address = useRef<HTMLInputElement>(null)
  const covered = useOverlayOver(viewport)
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  // State events seen for this page. A reply that was overtaken by an event is older than it
  // (a local redirect completes inside loadURL), so it must not overwrite the newer state.
  const stateEvents = useRef(0)

  const open = useCallback((url: string) => {
    if (!browser) return
    setRefused(undefined)
    setCapacity(undefined)
    const seen = stateEvents.current
    void browser.open(pageKey, projectPath, url).then((result) => {
      if ('capacity' in result) { setRefused(result.error); setCapacity(result.capacity) }
      else if ('error' in result && !('key' in result)) setRefused(result.error)
      else if (stateEvents.current === seen) setState(result as BrowserPageState)
    })
  }, [browser, pageKey, projectPath])

  // A page that already exists comes back as it was; only a new page, or an explicit open, loads.
  const lastNonce = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!browser) return
    let cancelled = false
    const explicit = lastNonce.current !== undefined && lastNonce.current !== openNonce
    lastNonce.current = openNonce
    if (explicit) { open(layoutRef.current.url); return }
    const seen = stateEvents.current
    void browser.state(pageKey).then((existing) => {
      if (cancelled) return
      if (existing) { if (stateEvents.current === seen) setState(existing) }
      else open(layoutRef.current.url)
    })
    return () => { cancelled = true }
  }, [browser, pageKey, openNonce, open])

  useEffect(() => browser?.onState((next) => {
    if (next.key !== pageKey) return
    stateEvents.current += 1
    setState(next)
    if (!next.error && /^https?:\/\//.test(next.url)) onLayout({ url: next.url })
  }), [browser, pageKey, onLayout])

  useEffect(() => {
    const resize = (): void => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  // ⌘L puts the cursor in the address field while the pane is open.
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.metaKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'l') { event.preventDefault(); address.current?.select() }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  const showsError = Boolean(state?.error) || Boolean(refused)
  const hidden = covered || showsError || !state
  // Where the host draws the page: the viewport box, or nothing while Cockpit needs the space.
  useLayoutEffect(() => {
    if (!browser) return
    const el = viewport.current
    if (!el) return
    const report = (): void => {
      if (hidden) { browser.place(pageKey, null); return }
      const r = el.getBoundingClientRect()
      browser.place(pageKey, { x: r.left, y: r.top, width: r.width, height: r.height })
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    window.addEventListener('resize', report)
    return () => { observer.disconnect(); window.removeEventListener('resize', report) }
  }, [browser, pageKey, hidden, layout.mode, layout.expanded, dragWidth, windowWidth])
  useEffect(() => () => browser?.place(pageKey, null), [browser, pageKey])

  const resize = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    let latest = layoutRef.current.width
    const move = (next: PointerEvent): void => { latest = window.innerWidth - next.clientX; setDragWidth(latest) }
    const done = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', done)
      setDragWidth(undefined)
      onLayout({ width: latest, expanded: false })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', done)
  }

  const go = (event: FormEvent): void => {
    event.preventDefault()
    const url = addressToUrl(draft ?? '')
    if (!url) { setRefused('Type a web address, like example.com or localhost:3000.'); return }
    setDraft(undefined)
    address.current?.blur()
    open(url)
  }

  const shown = state?.url && /^https?:\/\//.test(state.url) ? state.url : layout.url
  // The room the chat and the pane share: the window less the conversation list, when it shows.
  const listWidth = document.querySelector('.layout > .list')?.getBoundingClientRect().width ?? 0
  const width = paneWidth(dragWidth === undefined ? layout : { ...layout, width: dragWidth, expanded: false }, windowWidth - listWidth)
  const label = originLabel(shown)
  return (
    <aside className={`preview-pane browser-pane${layout.expanded ? ' expanded' : ''}`} style={{ width }} aria-label="Browser">
      <button type="button" className="preview-resizer" aria-label="Resize browser" onPointerDown={resize} />
      <header className="browser-toolbar">
        <div className="browser-nav">
          <button type="button" aria-label="Back" title="Back" disabled={!state?.canGoBack} onClick={() => browser?.navigate(pageKey, 'back')}><ChevronLeftIcon /></button>
          <button type="button" aria-label="Forward" title="Forward" disabled={!state?.canGoForward} onClick={() => browser?.navigate(pageKey, 'forward')}><ChevronRightIcon /></button>
          {state?.loading
            ? <button type="button" aria-label="Stop loading" title="Stop loading" onClick={() => browser?.navigate(pageKey, 'stop')}><StopIcon /></button>
            : <button type="button" aria-label="Reload" title="Reload" onClick={() => (state?.error ? open(state.error.url) : browser?.navigate(pageKey, 'reload'))}><ReloadIcon /></button>}
        </div>
        <form className="browser-address" onSubmit={go}>
          {label ? <span className={`browser-origin${label === 'Local' ? ' local' : ''}`}>{label}</span> : null}
          <input ref={address} aria-label="Address" spellCheck={false} value={draft ?? shown}
            onFocus={(e) => { setDraft(shown); requestAnimationFrame(() => e.target.select()) }}
            onBlur={() => setDraft(undefined)}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setDraft(undefined); e.currentTarget.blur() } }} />
          <span className={`preview-light${state && !state.loading && !state.error ? ' live' : ''}`} aria-hidden />
        </form>
        <div className="browser-actions">
          <button type="button" aria-label={layout.mode === 'mobile' ? 'Desktop width' : 'Mobile width'} title={layout.mode === 'mobile' ? 'Desktop width' : `Mobile width (${MOBILE_WIDTH} px)`}
            aria-pressed={layout.mode === 'mobile'} onClick={() => onLayout({ mode: layout.mode === 'mobile' ? 'desktop' : 'mobile' })}><PhoneIcon /></button>
          <button type="button" aria-label={layout.expanded ? 'Restore' : 'Expand'} title={layout.expanded ? 'Restore' : 'Expand'} onClick={() => onLayout({ expanded: !layout.expanded })}>
            {layout.expanded ? <RestoreIcon /> : <ExpandIcon />}
          </button>
          <button type="button" aria-label="Open in browser" title="Open in your browser" onClick={() => browser?.openExternal(pageKey)}><ExternalIcon /></button>
          <button type="button" aria-label="Close browser" title="Close" onClick={onClose}><CloseIcon /></button>
        </div>
      </header>
      <div className="browser-note" role="status">
        {state?.reloaded && !reloadNoted ? (
          <>
            <span>Reloaded: Cockpit unloaded this page while it was idle. Anything typed on it was not kept.</span>
            <button type="button" className="button-soft" onClick={() => setReloadNoted(true)}>OK</button>
          </>
        ) : null}
      </div>
      <div className={`browser-stage${layout.mode === 'mobile' ? ' mobile' : ''}`}>
        <div ref={viewport} className="browser-viewport" data-page={pageKey} />
        {showsError ? (
          <div className="browser-error" role="alert">
            <strong>{refused ? 'Can’t open that here' : 'This page didn’t load'}</strong>
            <p>{refused ?? state?.error?.description}</p>
            {state?.error ? <code>{state.error.url}</code> : null}
            {state?.error ? <button type="button" className="button-soft" onClick={() => open(state.error!.url)}>Retry</button> : null}
            {refused && state ? <button type="button" className="button-soft" onClick={() => setRefused(undefined)}>Back to the page</button> : null}
            {capacity ? (
              <ul className="browser-capacity" aria-label="Loaded pages">
                {capacity.map((page) => (
                  <li key={page.key}>
                    <span>{page.title || page.url || 'Untitled page'}</span>
                    <button type="button" className="button-soft" onClick={() => { browser?.close(page.key); open(layoutRef.current.url) }}>
                      {page.unsaved ? 'Discard typing and close' : 'Close page'}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {covered && !showsError ? <div className="browser-covered" aria-hidden>Page hidden while a menu is open</div> : null}
      </div>
    </aside>
  )
}
