import { useEffect, useState } from 'react'
import { native } from './native.ts'

export type ThemeMode = 'system' | 'light' | 'dark'

const KEY = 'cockpit:theme'

function load(): ThemeMode {
  try {
    const stored = localStorage.getItem(KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    return 'system'
  }
}

/**
 * Runs `change` with every transition held off until two frames later, so a theme switch lands all
 * at once instead of each surface fading from the old colours at its own pace (styles.css
 * .theme-switching).
 */
function withoutTransitions(change: () => void): void {
  const root = document.documentElement
  root.classList.add('theme-switching')
  change()
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')))
}

/** tokens.css switches on data-theme; the desktop app's native chrome follows along. */
function apply(mode: ThemeMode): void {
  withoutTransitions(() => {
    if (mode === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = mode
  })
  native?.setTheme(mode)
}

// Following the OS: when its appearance changes, switch at once too.
try {
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!document.documentElement.dataset.theme) withoutTransitions(() => undefined)
  })
} catch {
  // no matchMedia (tests): nothing to follow
}

export function useTheme(): { mode: ThemeMode; set: (mode: ThemeMode) => void } {
  const [mode, setMode] = useState<ThemeMode>(load)

  useEffect(() => {
    apply(mode)
    try {
      localStorage.setItem(KEY, mode)
    } catch {
      // not persisted; the choice still holds for this window
    }
  }, [mode])

  return { mode, set: setMode }
}
