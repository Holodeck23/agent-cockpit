// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TranscriptView } from '../../web/src/components/TranscriptView.tsx'
import type { TranscriptItem } from '../../web/src/transcript.ts'

// u26-4: TranscriptView's tick clock starts at mount and only refreshes after the first second
// interval, so a timer that starts hours into the session (an approval with a deadline, a running
// step) first renders from the clock of the moment the view mounted: "3660s remaining to decide".
// CORRECT behaviour: the first render of a timer reads the present.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const T0 = Date.parse('2026-10-10T09:00:00Z')
const HOUR = 3_600_000
let root: Root | undefined
let host: HTMLElement | undefined

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(T0)
})
afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  vi.useRealTimers()
})

const noop = (): void => undefined
const show = (items: TranscriptItem[], open: string[] = [], running = false): void => {
  act(() => {
    root!.render(createElement(TranscriptView, {
      threadId: 't1', items, openApprovals: new Set(open), running, streaming: '', streamingAuthor: 'claude', onApprove: noop, onAnswer: noop,
    }))
  })
}
const mount = (): void => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  show([]) // an idle conversation: nothing ticks
}

describe('u26-4: timers that start late in a session read the present', () => {
  it('an approval with a 60 s deadline raised an hour in does not start from an hour of seconds', () => {
    mount()
    vi.setSystemTime(T0 + HOUR)
    const approval: TranscriptItem = {
      type: 'approval', key: 'a1', requestId: 'r1', agent: 'claude', toolName: 'Bash', detail: 'ls', canAllowForSession: false,
      expiresAt: new Date(T0 + HOUR + 60_000).toISOString(),
    }
    show([approval], ['r1'])
    expect(host!.querySelector('.approval-countdown')?.textContent).toBe('60s remaining to decide')
  })

  it('a running step reports the time it has run, not 0:00 until the first tick', () => {
    mount()
    vi.setSystemTime(T0 + HOUR)
    show([{ type: 'step', key: 's1', label: 'Reading files', startedAt: new Date(T0 + HOUR - 30_000).toISOString() }], [], true)
    expect(host!.querySelector('.step-time')?.textContent).toBe('· 0:30')
  })
})
