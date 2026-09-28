import { useEffect, useState } from 'react'
import { native } from './native.ts'

export type ThemeMode = 'system' | 'light' | 'dark'

const KEY = 'cockpit:theme'
const ORDER: readonly ThemeMode[] = ['system', 'light', 'dark']

function load(): ThemeMode {
  try {
    const stored = localStorage.getItem(KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    return 'system'
  }
}

/** tokens.css switches on data-theme; the desktop app's native chrome follows along. */
function apply(mode: ThemeMode): void {
  if (mode === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = mode
  native?.setTheme(mode)
}

export function useTheme(): { mode: ThemeMode; cycle: () => void } {
  const [mode, setMode] = useState<ThemeMode>(load)

  useEffect(() => {
    apply(mode)
    try {
      localStorage.setItem(KEY, mode)
    } catch {
      // not persisted; the choice still holds for this window
    }
  }, [mode])

  const cycle = (): void => setMode((current) => ORDER[(ORDER.indexOf(current) + 1) % ORDER.length] ?? 'system')
  return { mode, cycle }
}
