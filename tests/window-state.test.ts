import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { placeWindow, readWindowState, writeWindowState } from '../electron/window-state.ts'

const DEFAULTS = { width: 1360, height: 860, minWidth: 980, minHeight: 640 }
const laptop = { x: 0, y: 25, width: 1512, height: 920 }
const external = { x: 1512, y: 0, width: 2560, height: 1415 }

describe('window size and position memory', () => {
  it('round-trips the last bounds and whether it was maximised', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cockpit-win-')), 'nested', 'window-state.json')
    writeWindowState(file, { x: 40, y: 60, width: 1200, height: 800, maximized: true })
    expect(readWindowState(file)).toEqual({ x: 40, y: 60, width: 1200, height: 800, maximized: true })
  })
  it('ignores a missing or garbled file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-win-'))
    expect(readWindowState(join(dir, 'missing'))).toBeUndefined()
    for (const text of ['nope', '{"x":1}', '{"x":0,"y":0,"width":"wide","height":10}']) {
      writeFileSync(join(dir, 'w'), text)
      expect(readWindowState(join(dir, 'w'))).toBeUndefined()
    }
  })
  it('reopens where it was when that spot is still on a screen', () => {
    expect(placeWindow({ x: 1700, y: 100, width: 1400, height: 900, maximized: false }, [laptop, external], DEFAULTS))
      .toEqual({ bounds: { x: 1700, y: 100, width: 1400, height: 900 }, maximized: false })
  })
  it('falls back to the default size, centred, when its screen is gone', () => {
    expect(placeWindow({ x: 1700, y: 100, width: 1400, height: 900, maximized: true }, [laptop], DEFAULTS))
      .toEqual({ bounds: { width: 1360, height: 860 }, maximized: true })
    expect(placeWindow(undefined, [laptop], DEFAULTS)).toEqual({ bounds: { width: 1360, height: 860 }, maximized: false })
  })
  it('shrinks to fit a smaller screen and never below the minimum', () => {
    expect(placeWindow({ x: 10, y: 30, width: 3000, height: 2000, maximized: false }, [laptop], DEFAULTS))
      .toEqual({ bounds: { x: 0, y: 25, width: 1512, height: 920 }, maximized: false })
    expect(placeWindow({ x: 10, y: 30, width: 200, height: 100, maximized: false }, [laptop], DEFAULTS))
      .toEqual({ bounds: { x: 10, y: 30, width: 980, height: 640 }, maximized: false })
  })
})
