import { useEffect, useRef, useState, type ReactNode } from 'react'

interface PeekProps {
  /** The heading inside the peek, e.g. the file path. */
  title: string
  /** Reads what to show; called once, the first time the peek opens. */
  load: () => Promise<{ text: string; more?: number }>
  /** An action under the text, e.g. Open in Files. */
  action?: { label: string; run: () => void }
  children: ReactNode
}

const OPEN_DELAY_MS = 350
const CLOSE_GRACE_MS = 150

/** Hover (or focus) a clip to see inside it, without opening anything (A8). */
export function Peek({ title, load, action, children }: PeekProps) {
  const [open, setOpen] = useState(false)
  const [content, setContent] = useState<{ text: string; more?: number } | { error: string }>()
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const loading = useRef(false)

  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    if (!open || content || loading.current) return
    loading.current = true
    load().then(setContent, (e: unknown) => setContent({ error: e instanceof Error ? e.message : String(e) }))
  }, [open, content, load])

  // Coming back while it is open (e.g. moving onto the panel) only cancels the close.
  const show = (delay: number): void => { clearTimeout(timer.current); if (!open) timer.current = setTimeout(() => setOpen(true), delay) }
  const hide = (): void => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(false), CLOSE_GRACE_MS) }

  return (
    <span className="peek" onMouseEnter={() => show(OPEN_DELAY_MS)} onMouseLeave={hide} onFocus={() => show(0)} onBlur={hide}
      onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false) } }}>
      {children}
      {open ? (
        <span className="peek-panel" role="dialog" aria-label={title}>
          <span className="peek-title">{title}</span>
          {!content ? <span className="peek-note">Loading…</span>
            : 'error' in content ? <span className="peek-note peek-error">{content.error}</span>
              : <>
                <pre className="peek-text">{content.text || '(empty)'}</pre>
                {content.more ? <span className="peek-note">{content.more} more {content.more === 1 ? 'line' : 'lines'}</span> : null}
              </>}
          {action ? <button type="button" className="peek-action" onClick={action.run}>{action.label}</button> : null}
        </span>
      ) : null}
    </span>
  )
}
