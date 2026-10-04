import { describe, expect, it } from 'vitest'
import { createWindowKey, shouldCarryKey, type MainFrame } from '../electron/window-key.ts'
import { debugSwitches } from '../electron/debug-flags.ts'

const origin = 'http://127.0.0.1:4317'
const main: MainFrame = { webContentsId: 1, processId: 7, routingId: 3 }
const topFrame = { processId: 7, routingId: 3, url: `${origin}/?thread=abc` }

describe('shouldCarryKey', () => {
  it('keys API calls from the main window top frame showing Cockpit', () => {
    expect(shouldCarryKey({ url: `${origin}/api/threads`, webContentsId: 1, frame: topFrame }, main, origin)).toBe(true)
    expect(shouldCarryKey({ url: `${origin}/api/threads/x/images/a.png`, webContentsId: 1, frame: topFrame }, main, origin)).toBe(true)
  })

  it('never keys the preview iframe, the capture window, or a request without a frame', () => {
    const iframe = { processId: 7, routingId: 9, url: 'http://127.0.0.1:5173/' }
    expect(shouldCarryKey({ url: `${origin}/api/threads`, webContentsId: 1, frame: iframe }, main, origin)).toBe(false)
    // The hidden capture window is its own web contents, with its own top frame.
    const capture = { processId: 8, routingId: 1, url: 'http://127.0.0.1:5173/' }
    expect(shouldCarryKey({ url: `${origin}/api/threads`, webContentsId: 2, frame: capture }, main, origin)).toBe(false)
    expect(shouldCarryKey({ url: `${origin}/api/threads`, webContentsId: 1, frame: null }, main, origin)).toBe(false)
    expect(shouldCarryKey({ url: `${origin}/api/threads`, frame: topFrame }, main, origin)).toBe(false)
  })

  it('never keys the main frame once it shows another origin, nor requests outside /api on Cockpit', () => {
    const elsewhere = { ...topFrame, url: 'http://127.0.0.1:5173/' }
    expect(shouldCarryKey({ url: `${origin}/api/threads`, webContentsId: 1, frame: elsewhere }, main, origin)).toBe(false)
    expect(shouldCarryKey({ url: 'http://127.0.0.1:9999/api/threads', webContentsId: 1, frame: topFrame }, main, origin)).toBe(false)
    expect(shouldCarryKey({ url: `${origin}/assets/app.js`, webContentsId: 1, frame: topFrame }, main, origin)).toBe(false)
  })

  it('keys nothing while there is no main window', () => {
    expect(shouldCarryKey({ url: `${origin}/api/threads`, webContentsId: 1, frame: topFrame }, undefined, origin)).toBe(false)
  })

  it('makes a fresh 256-bit key each time', () => {
    const a = createWindowKey()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(createWindowKey()).not.toBe(a)
  })
})

describe('debugSwitches', () => {
  it('names the switches that let another program drive the app', () => {
    expect(debugSwitches(['/App', '--remote-debugging-port=9222', '--inspect=0', '--inspect-brk', '--remote-debugging-pipe'])).toEqual(
      ['--remote-debugging-port=9222', '--inspect=0', '--inspect-brk', '--remote-debugging-pipe'])
  })
  it('ignores ordinary arguments', () => {
    expect(debugSwitches(['/App', '--no-sandbox-lookalike', '--inspector-ui', 'file.txt'])).toEqual([])
  })
})
