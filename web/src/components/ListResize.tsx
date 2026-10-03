import { useState, type KeyboardEvent, type PointerEvent } from 'react'

// The conversation list's width: dragged at its right edge (or arrow keys on the focused
// handle), between a minimum that keeps cards readable and a maximum that leaves the
// conversation room. Remembered across restarts. Desktop only; the phone shows one panel.

const KEY = 'cockpit:list-width'
export const LIST_MIN = 260
export const LIST_MAX = 520
const DEFAULT = 312
const STEP = 16

export const clampListWidth = (width: number): number => Math.min(LIST_MAX, Math.max(LIST_MIN, Math.round(width)))

export function useListWidth(): { width: number; setWidth: (width: number) => void } {
  const [width, setState] = useState(() => {
    try { return clampListWidth(Number(localStorage.getItem(KEY)) || DEFAULT) } catch { return DEFAULT }
  })
  return {
    width,
    setWidth: (next) => {
      const bounded = clampListWidth(next)
      setState(bounded)
      try { localStorage.setItem(KEY, String(bounded)) } catch { /* preference only */ }
    },
  }
}

/** Live width while dragging goes to `onDraft`; the final width to `onResize`. */
export function ListResize({ width, onDraft, onResize }: { width: number; onDraft: (width: number | undefined) => void; onResize: (width: number) => void }) {
  const [drag, setDrag] = useState<{ startX: number; startWidth: number; last: number }>()
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    setDrag({ startX: event.clientX, startWidth: width, last: width })
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!drag) return
    const next = clampListWidth(drag.startWidth + event.clientX - drag.startX)
    setDrag({ ...drag, last: next })
    onDraft(next)
  }
  const onPointerUp = (): void => {
    if (drag) onResize(drag.last)
    setDrag(undefined)
    onDraft(undefined)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowRight') onResize(width + STEP)
    else if (event.key === 'ArrowLeft') onResize(width - STEP)
    else return
    event.preventDefault()
  }
  return (
    <div
      className="list-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize conversation list"
      aria-valuemin={LIST_MIN}
      aria-valuemax={LIST_MAX}
      aria-valuenow={drag?.last ?? width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    />
  )
}
