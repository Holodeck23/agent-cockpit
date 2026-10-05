import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '../server/agents/types.ts'
import { CHROME_CONNECT_MS, watchChrome } from '../server/agents/claude/chrome-watch.ts'

// W9-12: Use my Chrome waits a bounded time for Chrome, says what is happening, and never retries.

function setup() {
  const events: NormalizedEvent[] = []
  let interrupts = 0
  const timers: Array<{ run: () => void; ms: number; cleared: boolean }> = []
  const sink = watchChrome((e) => events.push(e), () => { interrupts++ }, {
    set: (run, ms) => { const t = { run, ms, cleared: false }; timers.push(t); return t },
    clear: (t) => { (t as { cleared: boolean }).cleared = true },
  })
  const phases = () => events.flatMap((e) => (e.kind === 'chrome_connection' ? [e.phase] : []))
  return { sink, events, timers, phases, interrupts: () => interrupts }
}
const call = (id: string) => ({ kind: 'tool_use' as const, id, name: 'mcp__claude-in-chrome__tabs_context_mcp', input: {} })
const answer = (id: string, isError = false, content = '[]') => ({ kind: 'tool_result' as const, toolUseId: id, content, isError })

describe('Use my Chrome connection', () => {
  it('shows connecting on the first Chrome call and connected when it answers', () => {
    const h = setup()
    h.sink(call('a'))
    expect(h.phases()).toEqual(['connecting'])
    expect(h.timers[0]!.ms).toBe(CHROME_CONNECT_MS)
    h.sink(answer('a'))
    expect(h.phases()).toEqual(['connecting', 'connected'])
    expect(h.timers[0]!.cleared).toBe(true)
    h.sink(call('b'))
    expect(h.timers).toHaveLength(1)
  })

  it('fails after 30 seconds without an answer, stops the turn once, and explains', () => {
    const h = setup()
    h.sink(call('a'))
    h.timers[0]!.run()
    expect(h.interrupts()).toBe(1)
    expect(h.events.at(-1)).toMatchObject({ kind: 'chrome_connection', phase: 'failed', detail: expect.stringContaining('Google Chrome is open') })
    // The stopped turn's result does not turn the failure into a second status.
    h.sink({ kind: 'result', ok: false, stopped: true })
    expect(h.phases()).toEqual(['connecting', 'failed'])
    expect(h.interrupts()).toBe(1)
  })

  it('reports Cancel (Stop while connecting) as cancelled, with no timer left', () => {
    const h = setup()
    h.sink(call('a'))
    h.sink({ kind: 'result', ok: false, stopped: true })
    expect(h.phases()).toEqual(['connecting', 'cancelled'])
    expect(h.timers[0]!.cleared).toBe(true)
    expect(h.interrupts()).toBe(0)
  })

  it('reports an error answer as failed and a dropped connection as disconnected', () => {
    const h = setup()
    h.sink(call('a'))
    h.sink(answer('a', true, 'Browser extension is not connected'))
    expect(h.phases()).toEqual(['connecting', 'failed'])
    h.sink(call('b'))
    h.sink(answer('b'))
    h.sink(call('c'))
    h.sink(answer('c', true, 'Chrome extension disconnected'))
    expect(h.phases()).toEqual(['connecting', 'failed', 'connecting', 'connected', 'disconnected'])
  })

  it('treats Claude’s “not connected” answer as a failure, even without the error flag (2.1.289, live)', () => {
    const h = setup()
    h.sink(call('a'))
    h.sink(answer('a', false, 'Browser extension is not connected. Please ensure the Claude browser extension is installed and running (https://claude.ai/chrome)'))
    expect(h.phases()).toEqual(['connecting', 'failed'])
    expect(h.events.at(-1)).toMatchObject({ detail: expect.stringContaining('not connected') })
    h.sink(call('b'))
    h.sink(answer('b'))
    h.sink(call('c'))
    h.sink(answer('c', false, 'Browser extension is not connected.'))
    expect(h.phases()).toEqual(['connecting', 'failed', 'connecting', 'connected', 'disconnected'])
  })

  it('ignores every other tool', () => {
    const h = setup()
    h.sink({ kind: 'tool_use', id: 'x', name: 'mcp__cockpit__browser_read', input: {} })
    h.sink(answer('x'))
    expect(h.phases()).toEqual([])
    expect(h.events).toHaveLength(2)
  })
})
