import { useEffect, useRef, useState, type RefObject } from 'react'

/** Open/close state for a menu anchored in `ref`: closes on a click outside it or on Escape. */
export function usePopover<T extends HTMLElement>(): { open: boolean; setOpen: (open: boolean) => void; ref: RefObject<T | null> } {
  const [open, setOpen] = useState(false)
  const ref = useRef<T>(null)

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return { open, setOpen, ref }
}
