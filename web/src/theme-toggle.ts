// The top bar's one-click light/dark switch (D10). Pure, so it is unit-tested; System mode is
// still chosen in the Appearance popover.
import type { ThemeMode } from './theme.ts'

/** What is on screen now: System follows the Mac. */
export const shownTheme = (mode: ThemeMode, systemDark: boolean): 'light' | 'dark' => (mode === 'system' ? (systemDark ? 'dark' : 'light') : mode)

/** One click flips what is on screen. */
export const flippedTheme = (mode: ThemeMode, systemDark: boolean): 'light' | 'dark' => (shownTheme(mode, systemDark) === 'dark' ? 'light' : 'dark')
