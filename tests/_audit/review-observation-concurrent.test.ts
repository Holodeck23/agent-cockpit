import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '../../server/agents/types.ts'
import type { Observation } from '../../server/git/observe.ts'
import type { Workspace } from '../../server/projects/workspaces.ts'
import { createRunObservationStore, observeRuns } from '../../server/runs/observations.ts'
import type { ThreadManager, ThreadUpdate } from '../../server/threads/manager.ts'

// Review of u16: "another conversation working in this folder" resolved the acting conversation's
// folder from its CURRENT workspace, not the workspace the event or run came from. A conversation
// with agents in two workspaces was therefore attributed to the wrong folder.

const PROJECT = '/Users/example/proj'
const WORKTREE = '/Users/example/proj-wt-b'
const workspace = (id: string, kind: Workspace['kind'], cwd: string): Workspace => ({
  id, projectId: 'p', kind, cwd, canonicalCwd: cwd, gitCommonDir: `${PROJECT}/.git`, managed: kind === 'worktree',
  lifecycle: 'active', revision: 1, createdAt: new Date().toISOString(),
})
const registry = new Map([workspace('A', 'primary', PROJECT), workspace('B', 'worktree', WORKTREE)].map((w) => [w.id, w]))

function setup() {
  const listeners = new Set<(u: ThreadUpdate) => void>()
  // U works in the primary (A). T's current workspace is the worktree (B), but its background agent still runs in A.
  const metas = [
    { id: 'U', title: 'U-conversation', projectPath: PROJECT, workspaceId: 'A' },
    { id: 'T', title: 'T-conversation', projectPath: PROJECT, workspaceId: 'B' },
  ]
  const busy = new Set<string>()
  const manager = {
    subscribe: (l: (u: ThreadUpdate) => void) => { listeners.add(l); return () => listeners.delete(l) },
    summaries: () => metas.map((meta) => ({ meta, status: busy.has(meta.id) ? 'working' : 'idle' })),
  } as unknown as ThreadManager
  const emit = (threadId: string, workspaceId: string, event: NormalizedEvent): void => {
    if (event.kind === 'user_text') busy.add(threadId)
    if (event.kind === 'result') busy.delete(threadId)
    for (const l of listeners) l({ threadId, event, status: busy.has(threadId) ? 'working' : 'idle', workspaceId } as ThreadUpdate)
  }
  const look = (): Promise<Observation> => Promise.resolve({ repo: true, observedAt: 'now', head: null, branch: null, files: [], truncated: false, stable: true })
  const store = createRunObservationStore(mkdtempSync(join(tmpdir(), 'cockpit-review-concurrent-')))
  const observer = observeRuns(manager, store, look, (id) => registry.get(id))
  return { emit, observer, store }
}

describe('review: concurrent work is attributed to the workspace it happened in', () => {
  it('a background session in the run’s workspace counts even though the conversation is now in another one', async () => {
    const { emit, observer, store } = setup()
    emit('U', 'A', { kind: 'user_text', text: 'go', runId: 'rU' })
    await observer.settle()
    emit('T', 'A', { kind: 'tool_use', id: 'x', name: 'Write', input: {} })
    emit('U', 'A', { kind: 'result', ok: true, runId: 'rU' })
    await observer.settle()
    expect(store.get('rU')?.concurrent).toEqual(['T-conversation'])
  })

  it('work in the conversation’s current workspace does not count against a run in another one', async () => {
    const { emit, observer, store } = setup()
    // U's run is in the worktree (B); T's background session acts in A, though T's current workspace is B.
    emit('U', 'B', { kind: 'user_text', text: 'go', runId: 'rU' })
    await observer.settle()
    emit('T', 'A', { kind: 'tool_use', id: 'x', name: 'Write', input: {} })
    emit('U', 'B', { kind: 'result', ok: true, runId: 'rU' })
    await observer.settle()
    expect(store.get('rU')?.concurrent).toEqual([])
  })

  it('a conversation already working in the run’s workspace when it starts is named; one working elsewhere is not', async () => {
    const { emit, observer, store } = setup()
    // T has a run in A (its current workspace is B) and is busy.
    emit('T', 'A', { kind: 'user_text', text: 'in A', runId: 'rT' })
    await observer.settle()
    emit('U', 'A', { kind: 'user_text', text: 'go in A', runId: 'rUA' })
    emit('U', 'B', { kind: 'user_text', text: 'go in B', runId: 'rUB' })
    await observer.settle()
    emit('U', 'A', { kind: 'result', ok: true, runId: 'rUA' })
    emit('U', 'B', { kind: 'result', ok: true, runId: 'rUB' })
    await observer.settle()
    expect(store.get('rUA')?.concurrent).toEqual(['T-conversation'])
    expect(store.get('rUB')?.concurrent).toEqual([])
  })
})
