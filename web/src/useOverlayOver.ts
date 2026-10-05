import { useEffect, useState, type RefObject } from 'react'

// The in-app browser page is drawn by the host above the whole window, so nothing Cockpit draws
// can sit on top of it. While a menu, dialog, popover or toast overlaps the pane, the page is
// hidden instead (W9-05: the browser never obscures approval or other controls).
const OVERLAYS = '[role="dialog"], [role="menu"], [role="listbox"], [role="alertdialog"], .toast, .peek'

const overlaps = (a: DOMRect, b: DOMRect): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

/** True while any Cockpit overlay outside `area` overlaps it. */
export function useOverlayOver(area: RefObject<HTMLElement | null>): boolean {
  const [covered, setCovered] = useState(false)
  useEffect(() => {
    let frame = 0
    const check = (): void => {
      frame = 0
      const el = area.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const hit = [...document.querySelectorAll<HTMLElement>(OVERLAYS)].some((o) => !el.contains(o) && !o.contains(el) && overlaps(o.getBoundingClientRect(), rect))
      setCovered(hit)
    }
    const soon = (): void => { if (!frame) frame = requestAnimationFrame(check) }
    const observer = new MutationObserver(soon)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'open', 'hidden', 'style', 'role'] })
    window.addEventListener('resize', soon)
    check()
    return () => { observer.disconnect(); window.removeEventListener('resize', soon); if (frame) cancelAnimationFrame(frame) }
  }, [area])
  return covered
}
