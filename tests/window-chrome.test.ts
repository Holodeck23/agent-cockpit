import { describe, expect, it } from 'vitest'
import { trafficClearance } from '../web/src/window-chrome.ts'

describe('room for the window buttons', () => {
  it('keeps 84 points clear at normal zoom', () => {
    expect(trafficClearance(false, 1360, 1360)).toBe(84)
  })
  it('stays the same physical width when the page is zoomed', () => {
    expect(trafficClearance(false, 1360, 1133)).toBe(70)
    expect(trafficClearance(false, 1360, 1700)).toBe(105)
  })
  it('drops to the normal edge in full screen, where macOS hides the buttons', () => {
    expect(trafficClearance(true, 1512, 1512)).toBe(16)
  })
  it('falls back to the plain width when the sizes are unknown', () => {
    expect(trafficClearance(false, 0, 0)).toBe(84)
  })
})
