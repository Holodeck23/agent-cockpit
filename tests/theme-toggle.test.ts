import { describe, expect, it } from 'vitest'
import { flippedTheme, shownTheme } from '../web/src/theme-toggle.ts'

describe('the one-click theme switch', () => {
  it('flips what is on screen, System included', () => {
    expect(shownTheme('system', true)).toBe('dark')
    expect(flippedTheme('system', true)).toBe('light')
    expect(flippedTheme('system', false)).toBe('dark')
    expect(flippedTheme('dark', false)).toBe('light')
    expect(flippedTheme('light', true)).toBe('dark')
  })
})
