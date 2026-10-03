import { describe, expect, it } from 'vitest'
import { SECTION_ORDER, shortcutFor } from '../web/src/shortcuts.ts'

const key = (code: string, mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) =>
  ({ code, metaKey: mods.meta ?? false, ctrlKey: mods.ctrl ?? false, altKey: mods.alt ?? false, shiftKey: mods.shift ?? false })

describe('numbered shortcuts', () => {
  it('⌘1–8 pick that project tab and ⌘9 the last one', () => {
    expect(shortcutFor(key('Digit1', { meta: true }), 4)).toEqual({ kind: 'project', index: 0 })
    expect(shortcutFor(key('Digit3', { meta: true }), 4)).toEqual({ kind: 'project', index: 2 })
    expect(shortcutFor(key('Digit9', { meta: true }), 4)).toEqual({ kind: 'project', index: 3 })
    expect(shortcutFor(key('Digit6', { meta: true }), 4)).toBeUndefined()
    expect(shortcutFor(key('Digit1', { ctrl: true }), 4)).toEqual({ kind: 'project', index: 0 })
  })
  it('⌥⌘1–5 pick a section, in the order the bar shows them', () => {
    expect(SECTION_ORDER).toEqual(['conversations', 'files', 'workflows', 'memory', 'processes'])
    expect(shortcutFor(key('Digit2', { meta: true, alt: true }), 4)).toEqual({ kind: 'section', section: 'files' })
    expect(shortcutFor(key('Digit5', { meta: true, alt: true }), 4)).toEqual({ kind: 'section', section: 'processes' })
    expect(shortcutFor(key('Digit6', { meta: true, alt: true }), 4)).toBeUndefined()
  })
  it('leaves everything else alone', () => {
    expect(shortcutFor(key('Digit1'), 4)).toBeUndefined()
    expect(shortcutFor(key('Digit1', { meta: true, shift: true }), 4)).toBeUndefined()
    expect(shortcutFor(key('Digit0', { meta: true }), 4)).toBeUndefined()
    expect(shortcutFor(key('KeyA', { meta: true }), 4)).toBeUndefined()
    expect(shortcutFor(key('Digit1', { meta: true }), 0)).toBeUndefined()
  })
})
