// Numbered shortcuts: ⌘1–9 switch project tabs (⌘9 is always the last tab), ⌥⌘1–5 switch
// sections. Matched on the physical key, since ⌥ changes the character a digit types on a Mac.
import type { Section } from './components/SubNav.tsx'

export const SECTION_ORDER: readonly Section[] = ['conversations', 'files', 'workflows', 'memory', 'processes']

interface KeyLike { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }
export type Shortcut = { kind: 'project'; index: number } | { kind: 'section'; section: Section }

export function shortcutFor(event: KeyLike, tabCount: number): Shortcut | undefined {
  const digit = /^Digit([1-9])$/.exec(event.code)?.[1]
  if (!digit || !(event.metaKey || event.ctrlKey) || event.shiftKey) return undefined
  const n = Number(digit)
  if (event.altKey) {
    const section = SECTION_ORDER[n - 1]
    return section ? { kind: 'section', section } : undefined
  }
  const index = n === 9 ? tabCount - 1 : n - 1
  return index >= 0 && index < tabCount ? { kind: 'project', index } : undefined
}

/** The hint shown in a tooltip, e.g. "⌘2", or undefined past the numbered ones. */
export function projectHint(index: number, tabCount: number): string | undefined {
  if (index < 8) return `⌘${index + 1}`
  return index === tabCount - 1 ? '⌘9' : undefined
}
