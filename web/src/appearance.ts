// Appearance choices besides the theme: list and message density, and what a conversation row
// shows. Kept in localStorage (the desktop app keeps its origin across restarts, see
// electron/app-port.ts). Defaults are the look Cockpit had before the choices existed.
import { useEffect, useState } from 'react'

export type Density = 'normal' | 'compact'
export interface RowShows {
  readonly preview: boolean
  readonly agent: boolean
  readonly date: boolean
}
export interface Appearance {
  readonly list: Density
  readonly messages: Density
  readonly rows: RowShows
}

export const DEFAULT_APPEARANCE: Appearance = { list: 'normal', messages: 'normal', rows: { preview: false, agent: true, date: true } }
const KEY = 'cockpit:appearance'

const density = (value: unknown, fallback: Density): Density => (value === 'normal' || value === 'compact' ? value : fallback)
const flag = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)

/** Whatever was stored, field by field; anything missing or malformed takes its default. */
export function parseAppearance(raw: string | null): Appearance {
  let stored: Record<string, unknown> = {}
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>
  } catch {
    // unreadable: defaults
  }
  const rows = stored.rows && typeof stored.rows === 'object' ? (stored.rows as Record<string, unknown>) : {}
  const d = DEFAULT_APPEARANCE
  return {
    list: density(stored.list, d.list),
    messages: density(stored.messages, d.messages),
    rows: { preview: flag(rows.preview, d.rows.preview), agent: flag(rows.agent, d.rows.agent), date: flag(rows.date, d.rows.date) },
  }
}

/** "Claude Code · Today", with the parts the row is set to show; the project leads on the phone. */
export function rowMeta(parts: { project?: string; agent: string; date: string }, shows: RowShows): string {
  return [parts.project, shows.agent ? parts.agent : undefined, shows.date ? parts.date : undefined].filter(Boolean).join(' · ')
}

function load(): Appearance {
  try {
    return parseAppearance(localStorage.getItem(KEY))
  } catch {
    return DEFAULT_APPEARANCE
  }
}

/** Density applies through data attributes on <html> (styles/appearance.css). */
export function useAppearance(): { appearance: Appearance; update: (patch: Partial<Appearance>) => void } {
  const [appearance, setAppearance] = useState<Appearance>(load)
  useEffect(() => {
    const root = document.documentElement.dataset
    root.listDensity = appearance.list
    root.messageDensity = appearance.messages
    try {
      localStorage.setItem(KEY, JSON.stringify(appearance))
    } catch {
      // not persisted; the choice still holds for this window
    }
  }, [appearance])
  const update = (patch: Partial<Appearance>): void => setAppearance((current) => ({ ...current, ...patch }))
  return { appearance, update }
}
