import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { ACTIVITY_STATE_LABEL, duration, type ActivityRow } from '../activity.ts'
import { Bars } from './icons.tsx'

// The activity pane: every tool call of the open conversation, beside it, so the
// conversation itself keeps only what was said and decided.

const WIDTH_KEY = 'cockpit:activity-width'
const OPEN_KEY = 'cockpit:activity-open'
const MIN_WIDTH = 260
const MAX_WIDTH = 640
const DEFAULT_WIDTH = 340
const KEY_STEP = 16

const clampWidth = (width: number): number => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)))

// Storage can be unavailable (private contexts, blocked site data): fall back to defaults.
function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function writeSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Preference only; the pane still works without it.
  }
}

/** Open state and width, remembered across conversations and restarts. */
export function useActivityPrefs(): { open: boolean; setOpen: (open: boolean) => void; width: number; setWidth: (width: number) => void } {
  const [open, setOpenState] = useState(() => readSetting(OPEN_KEY) === 'true')
  const [width, setWidthState] = useState(() => clampWidth(Number(readSetting(WIDTH_KEY)) || DEFAULT_WIDTH))
  return {
    open,
    setOpen: (next) => {
      setOpenState(next)
      writeSetting(OPEN_KEY, String(next))
    },
    width,
    setWidth: (next) => {
      const bounded = clampWidth(next)
      setWidthState(bounded)
      writeSetting(WIDTH_KEY, String(bounded))
    },
  }
}

/** Re-renders every second while `active`, for running rows' timers. */
function useTick(active: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

interface ActivityPaneProps {
  rows: readonly ActivityRow[]
  width: number
  onResize: (width: number) => void
  onClose: () => void
}

export function ActivityPane({ rows, width, onResize, onClose }: ActivityPaneProps) {
  const now = useTick(rows.some((row) => row.state === 'running'))
  const drag = useRef<{ startX: number; startWidth: number } | undefined>(undefined)
  const [draft, setDraft] = useState<number | undefined>(undefined)
  const shown = draft ?? width
  const list = useRef<HTMLOListElement>(null)

  // Follow new activity unless the user has scrolled up to read.
  useEffect(() => {
    const el = list.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight
  }, [rows.length])

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    drag.current = { startX: event.clientX, startWidth: width }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current) setDraft(clampWidth(drag.current.startWidth + drag.current.startX - event.clientX))
  }
  const onPointerUp = (): void => {
    if (draft !== undefined) onResize(draft)
    drag.current = undefined
    setDraft(undefined)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowLeft') onResize(width + KEY_STEP)
    else if (event.key === 'ArrowRight') onResize(width - KEY_STEP)
    else return
    event.preventDefault()
  }

  return (
    <aside className="activity-pane" aria-label="Activity" style={{ width: shown }}>
      <div
        className="activity-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize activity"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={shown}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      />
      <header className="activity-head">
        <h2>Activity</h2>
        <span className="activity-count">{rows.length === 1 ? '1 step' : `${rows.length} steps`}</span>
        <button type="button" className="activity-close" aria-label="Close activity" title="Close (⌘⇧A)" onClick={onClose}>
          ×
        </button>
      </header>
      {rows.length === 0 ? (
        <p className="activity-empty">Tool calls appear here as the agent works.</p>
      ) : (
        <ol className="activity-list" ref={list}>
          {rows.map((row) => {
            const end = row.endedAt ? Date.parse(row.endedAt) : row.state === 'running' ? now : undefined
            return (
              <li key={row.id} className={`activity-row activity-${row.state}`}>
                <details>
                  <summary>
                    <span className="activity-mark" aria-hidden="true">
                      {row.state === 'running' ? <Bars live /> : null}
                    </span>
                    <span className="activity-label">{row.label}</span>
                    <span className="activity-meta">
                      <span className="activity-state">{ACTIVITY_STATE_LABEL[row.state]}</span>
                      {end !== undefined ? <span className="activity-time">{duration(row.startedAt, end)}</span> : null}
                    </span>
                  </summary>
                  <div className="activity-detail">
                    <div className="activity-tool">{row.tool}</div>
                    {row.input ? (
                      <>
                        <h3>Input</h3>
                        <pre>{row.input}</pre>
                      </>
                    ) : null}
                    {row.output !== undefined ? (
                      <>
                        <h3>{row.state === 'error' ? 'Error' : 'Output'}</h3>
                        <pre>{row.output || '(empty)'}</pre>
                      </>
                    ) : (
                      <p className="activity-none">{row.state === 'interrupted' ? 'No result: the turn ended before this step reported back.' : 'Waiting for the result…'}</p>
                    )}
                  </div>
                </details>
              </li>
            )
          })}
        </ol>
      )}
    </aside>
  )
}
