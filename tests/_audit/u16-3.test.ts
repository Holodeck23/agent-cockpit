import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '../../server/agents/types.ts'
import type { Observation } from '../../server/git/observe.ts'
import { createRunObservationStore, observeRuns } from '../../server/runs/observations.ts'
import type { ThreadManager, ThreadUpdate } from '../../server/threads/manager.ts'

// u16-3: the run observer called manager.summaries() (every conversation, every event) for each
// streamed token, to find the streaming conversation's title/folder. That is the per-token
// full-log work the store and broadcast deliberately avoid.
// CORRECT behaviour: streaming costs no summaries() call per token; concurrency is still noticed.

function setup() {
  const listeners = new Set<(u: ThreadUpdate) => void>()
  const threads = [
    { id: 't1', title: 'Mine', projectPath: '/proj' },
    { id: 't2', title: 'Other', projectPath: '/proj' },
    { id: 't3', title: 'Elsewhere', projectPath: '/elsewhere' },
  ]
  let calls = 0
  const manager = {
    subscribe: (l: (u: ThreadUpdate) => void) => { listeners.add(l); return () => listeners.delete(l) },
    summaries: () => { calls += 1; return threads.map((meta) => ({ meta, status: 'working' })) },
  } as unknown as ThreadManager
  const emit = (threadId: string, event: NormalizedEvent): void => {
    for (const l of listeners) l({ threadId, event, status: 'working' } as ThreadUpdate)
  }
  const look = (): Promise<Observation> => Promise.resolve({ repo: true, observedAt: 'now', head: null, branch: null, files: [], truncated: false, stable: true })
  const store = createRunObservationStore(mkdtempSync(join(tmpdir(), 'cockpit-u16-3-')))
  const observer = observeRuns(manager, store, look)
  return { emit, observer, store, calls: () => calls, resetCalls: () => { calls = 0 } }
}
const delta = (text: string): NormalizedEvent => ({ kind: 'text_delta', text })

describe('u16-3 streamed tokens do not scan every conversation', () => {
  it('a conversation streaming alone costs no summaries() call per token', async () => {
    const { emit, observer, calls, resetCalls } = setup()
    emit('t1', { kind: 'user_text', text: 'go', runId: 'run-1' })
    await observer.settle()
    resetCalls()
    for (let i = 0; i < 100; i++) emit('t1', delta('x'))
    expect(calls()).toBe(0)
  })

  it('another conversation streaming costs no per-token scan either, yet is recorded as concurrent', async () => {
    const { emit, observer, store, calls, resetCalls } = setup()
    emit('t1', { kind: 'user_text', text: 'go', runId: 'run-1' })
    await observer.settle()
    resetCalls()
    for (let i = 0; i < 100; i++) emit('t2', delta('x'))
    expect(calls()).toBeLessThanOrEqual(1)
    for (let i = 0; i < 100; i++) emit('t3', delta('x'))
    expect(calls()).toBeLessThanOrEqual(2)
    emit('t1', { kind: 'result', ok: true, runId: 'run-1' })
    await observer.settle()
    expect(store.get('run-1')?.concurrent).toEqual(['Other'])
  })
})
