import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { dropIndex, moveTab } from './project-tabs.ts'

// Drag a pinned tab to reorder (projects-area Move 4). Pointer events, not HTML5 drag: the drag only
// starts after 4 px of movement, so a press that barely moves is still a click that selects the tab,
// and the click that ends a real drag is swallowed. Once a press starts on a tab, the pointer is
// followed on the window: a quick drag is often over the next tab by its first move event.

export const DRAG_THRESHOLD_PX = 4

export interface TabDrag {
  /** The path being dragged and where it would land (index among the other pinned tabs). */
  readonly dragging: { readonly path: string; readonly to: number } | undefined
  /** Spread onto a pinned tab's root element. */
  handlers(path: string): {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
    onClickCapture: (e: { preventDefault(): void; stopPropagation(): void }) => void
  }
}

/**
 * `pinned` are the pinned tab paths in order; `boxOf` measures a tab by path; `onDrop` gets the new
 * order of every pinned path.
 */
export function useTabDrag(pinned: readonly string[], boxOf: (path: string) => DOMRect | undefined, onDrop: (paths: string[]) => void): TabDrag {
  const swallowClick = useRef(false)
  const stop = useRef<(() => void) | undefined>(undefined)
  const [dragging, setDragging] = useState<{ path: string; to: number }>()
  // The latest values, for listeners that outlive a render.
  const latest = useRef({ pinned, boxOf, onDrop })
  latest.current = { pinned, boxOf, onDrop }
  useEffect(() => () => stop.current?.(), [])

  const target = (path: string, x: number): number => {
    const { pinned: order, boxOf: measure } = latest.current
    return dropIndex(order.filter((p) => p !== path).flatMap((p) => measure(p) ?? []), x)
  }

  const begin = (path: string, startX: number, pointerId: number): void => {
    stop.current?.()
    let moved = false
    const move = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return
      if (!moved && Math.abs(e.clientX - startX) < DRAG_THRESHOLD_PX) return
      moved = true
      setDragging({ path, to: target(path, e.clientX) })
    }
    const up = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return
      end()
      if (!moved) return
      swallowClick.current = true
      // A drop outside any tab produces no click to swallow; don't let the flag eat the next real one.
      setTimeout(() => { swallowClick.current = false }, 0)
      const order = latest.current.pinned
      const from = order.indexOf(path)
      const to = target(path, e.clientX)
      if (from >= 0 && to !== from) latest.current.onDrop(moveTab(order, from, to))
    }
    const end = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', end)
      stop.current = undefined
      setDragging(undefined)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', end)
    stop.current = end
  }

  return {
    dragging,
    handlers: (path) => ({
      onPointerDown: (e) => {
        if (e.button !== 0 || !pinned.includes(path)) return
        // The pin and × buttons are for clicking, not for starting a drag.
        if ((e.target as Element).closest?.('.tab-close, .tab-pin')) return
        begin(path, e.clientX, e.pointerId)
      },
      onClickCapture: (e) => {
        if (!swallowClick.current) return
        swallowClick.current = false
        e.preventDefault()
        e.stopPropagation()
      },
    }),
  }
}
