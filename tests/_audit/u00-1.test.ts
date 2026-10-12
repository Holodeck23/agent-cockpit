import { describe, expect, it } from 'vitest'
import { debugSwitches } from '../../electron/debug-flags.ts'

// u00-1: Chromium's command-line parser takes '-' as well as '--' as a switch prefix on POSIX, so
// `open -a Cockpit --args -remote-debugging-port=9222` opens the DevTools port. The release
// lockout has to see those spellings too.

describe('u00-1 debugSwitches single-dash spellings', () => {
  it('names single-dash debugger switches', () => {
    expect(debugSwitches(['/App', '-remote-debugging-port=9222', '-remote-debugging-pipe', '-remote-debugging-address=0.0.0.0', '-inspect=0', '-inspect-brk', '-inspect-port=1', '-inspect-wait', '-debug'])).toEqual(
      ['-remote-debugging-port=9222', '-remote-debugging-pipe', '-remote-debugging-address=0.0.0.0', '-inspect=0', '-inspect-brk', '-inspect-port=1', '-inspect-wait', '-debug'])
  })
  it('still names the double-dash spellings and ignores lookalikes', () => {
    expect(debugSwitches(['--remote-debugging-port=0', '--inspect'])).toEqual(['--remote-debugging-port=0', '--inspect'])
    expect(debugSwitches(['-inspector-ui', '--no-sandbox', '-remote-debugging-ports', '---inspect', 'inspect', '-x=--inspect'])).toEqual([])
  })
})
