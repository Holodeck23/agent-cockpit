import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '../../server/agents/types.ts'
import type { Observation } from '../../server/git/observe.ts'
import type { Workspace } from '../../server/projects/workspaces.ts'
import { createRunObservationStore, observeRuns } from '../../server/runs/observations.ts'
import type { ThreadManager, ThreadUpdate } from '../../server/threads/manager.ts'

// u16-1: one conversation may run in two workspaces at once (W12-15). The run observer keyed its
// "current run" and its "fold every open run into this result" by thread alone, so workspace A's
// result also ended workspace B's still-working run: B's "after" was taken at A's end and never
// refreshed. CORRECT behaviour: a result (or a taken queued message) ends only runs of the
// workspace it came from, and a run's folder is the workspace the run belongs to.

const PROJECT = '/proj'
const workspace = (id: string, kind: Workspace['kind'], cwd: string): Workspace => ({
  id, projectId: 'p', kind, cwd, canonicalCwd: cwd, gitCommonDir: '/proj/.git', managed: kind === 'worktree',
  lifecycle: 'active', revision: 1, createdAt: new Date().toISOString(),
})
const registry = new Map([workspace('A', 'primary', PROJECT), workspace('B', 'worktree', '/proj-wt-b')].map((w) => [w.id, w]))

function setup() {
  const listeners = new Set<(u: ThreadUpdate) => void>()
  // The conversation now works in B (it moved there while A's agent kept going).
  const meta = { id: 'T', title: 'Mine', projectPath: PROJECT, workspaceId: 'B' }
  const manager = {
    subscribe: (l: (u: ThreadUpdate) => void) => { listeners.add(l); return () => listeners.delete(l) },
    summaries: () => [{ meta, status: 'working' }],
  } as unknown as ThreadManager
  const emit = (workspaceId: string, event: NormalizedEvent): void => {
    for (const l of listeners) l({ threadId: 'T', event, status: 'working', workspaceId } as ThreadUpdate)
  }
  const looked: string[] = []
  let n = 0
  const look = (path: string): Promise<Observation> => {
    looked.push(path)
    return Promise.resolve({ repo: true, observedAt: `obs-${++n}`, head: null, branch: null, files: [], truncated: false, stable: true })
  }
  const store = createRunObservationStore(mkdtempSync(join(tmpdir(), 'cockpit-u16-1-')))
  const observer = observeRuns(manager, store, look, (id) => registry.get(id))
  return { emit, observer, store, looked }
}

describe('u16-1 a result ends only its own workspace’s run', () => {
  it('A’s result does not end B’s in-flight run; B’s own result takes its after', async () => {
    const { emit, observer, store, looked } = setup()
    emit('A', { kind: 'user_text', text: 'in A', runId: 'run-a' })
    emit('B', { kind: 'user_text', text: 'in B', runId: 'run-b' })
    await observer.settle()
    // Each run observed the folder of the workspace it runs in.
    expect(looked).toEqual([PROJECT, '/proj-wt-b'])

    emit('A', { kind: 'result', ok: true, runId: 'run-a' })
    await observer.settle()
    expect(store.get('run-a')?.after).toBeDefined()
    // B is still working: its run is open and has no "after" yet.
    expect(observer.observing('run-b')).toBe(true)
    expect(store.get('run-b')?.after).toBeUndefined()

    emit('B', { kind: 'result', ok: true, runId: 'run-b' })
    await observer.settle()
    expect(store.get('run-b')?.after).toBeDefined()
    expect(looked).toEqual([PROJECT, '/proj-wt-b', PROJECT, '/proj-wt-b'])
  })

  it('a result without a run id in A does not fold B’s run into it', async () => {
    const { emit, observer, store } = setup()
    emit('A', { kind: 'user_text', text: 'in A', runId: 'run-a' })
    emit('B', { kind: 'user_text', text: 'in B', runId: 'run-b' })
    await observer.settle()
    emit('A', { kind: 'result', ok: true })
    await observer.settle()
    expect(store.get('run-a')?.after).toBeDefined()
    expect(observer.observing('run-b')).toBe(true)
    expect(store.get('run-b')?.after).toBeUndefined()
  })

  it('a queued message taken in A does not end B’s run', async () => {
    const { emit, observer, store } = setup()
    emit('A', { kind: 'user_text', text: 'in A', runId: 'run-a' })
    emit('B', { kind: 'user_text', text: 'in B', runId: 'run-b' })
    emit('A', { kind: 'user_text', text: 'queued in A', runId: 'run-a2', queuedId: 'q1' })
    await observer.settle()
    emit('A', { kind: 'user_taken', text: 'queued in A', id: 'q1' })
    await observer.settle()
    // The taken message ends A's earlier run and starts A's next; B's run is untouched.
    expect(store.get('run-a')?.after).toBeDefined()
    expect(observer.observing('run-b')).toBe(true)
    expect(store.get('run-b')?.after).toBeUndefined()
  })
})
