import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Project } from '../api.ts'
import { TINTS } from './ProjectSettings.tsx'

// A tab's menu (right-click or Shift+F10): colour, pin, close, settings, remove. Removing asks first,
// in place, with the same words as the Projects menu.

export interface TabMenuProps {
  project: Project
  /** Where it opens, in viewport pixels. */
  at: { x: number; y: number }
  onColor: (color: Project['color']) => void
  onTogglePin: () => void
  onCloseTab: () => void
  onSettings: () => void
  onRemove: () => Promise<void>
  onDismiss: () => void
}

const MENU_WIDTH = 240

export function TabMenu({ project, at, onColor, onTogglePin, onCloseTab, onSettings, onRemove, onDismiss }: TabMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus()
    const onPointer = (event: MouseEvent): void => { if (ref.current && !ref.current.contains(event.target as Node)) onDismiss() }
    document.addEventListener('mousedown', onPointer)
    return () => document.removeEventListener('mousedown', onPointer)
  }, [onDismiss])

  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') { event.preventDefault(); onDismiss(); return }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]
    const i = items.indexOf(document.activeElement as HTMLElement)
    items[(i + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    try { await onRemove() } finally { setBusy(false) }
  }

  const left = Math.max(8, Math.min(at.x, window.innerWidth - MENU_WIDTH - 8))
  return (
    <div ref={ref} className="menu tab-menu" role="menu" aria-label={`${project.name} tab`} style={{ position: 'fixed', left, top: at.y, right: 'auto', width: MENU_WIDTH }} onKeyDown={onKey}>
      {confirming ? (
        <div className="project-remove" role="alertdialog" aria-label={`Remove ${project.name} from Cockpit`}>
          <span>Remove <strong>{project.name}</strong> from Cockpit? The folder and its conversations stay; schedules in it are paused.</span>
          <div>
            <button type="button" className="button-soft" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
            <button type="button" className="button-danger" disabled={busy} onClick={() => void remove()}>Remove</button>
          </div>
        </div>
      ) : (
        <>
          <p className="menu-label">Colour</p>
          <div className="tab-menu-swatches" role="group" aria-label="Colour">
            {TINTS.map((t) => (
              <button key={t.id} type="button" role="menuitemradio" aria-checked={project.color === t.id} aria-label={t.label} title={t.label}
                className={`tint-swatch avatar-${t.id}`} onClick={() => onColor(t.id)} />
            ))}
          </div>
          <div className="menu-separator" role="separator" />
          <button type="button" role="menuitem" className="menu-item" onClick={onTogglePin}>{project.pinned ? 'Unpin' : 'Pin'}</button>
          <button type="button" role="menuitem" className="menu-item" onClick={onCloseTab}>Close tab</button>
          <button type="button" role="menuitem" className="menu-item" onClick={onSettings}>Project settings…</button>
          <div className="menu-separator" role="separator" />
          <button type="button" role="menuitem" className="menu-item menu-item-danger" onClick={() => setConfirming(true)}>Remove from Cockpit…</button>
        </>
      )}
    </div>
  )
}
