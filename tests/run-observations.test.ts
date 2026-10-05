import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '../server/agents/types.ts'
import { observe, type Observation } from '../server/git/observe.ts'
import { runChanges } from '../server/runs/run-changes.ts'
import { createRunObservationStore, observeRuns } from '../server/runs/observations.ts'
import type { ThreadManager, ThreadUpdate } from '../server/threads/manager.ts'
import { StoreReadError } from '../server/state/read-error.ts'

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { env: ENV, encoding: 'utf8' })

function repo(): string {
  const root = join(mkdtempSync(join(tmpdir(), 'cockpit-runobs-')), 'project')
  mkdirSync(root)
  git(root, 'init', '-q', '-b', 'main')
  for (const name of ['pre.txt', 'again.txt', 'clean.txt', 'reverted.txt']) writeFileSync(join(root, name), `${name}\n`)
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'first')
  return root
}

/** Just enough of the manager: its event stream and the conversations' folders and statuses. */
function fakeManager(threads: Array<{ id: string; title: string; projectPath: string }>) {
  const listeners = new Set<(u: ThreadUpdate) => void>()
  const busy = new Set<string>()
  const manager = {
    subscribe: (l: (u: ThreadUpdate) => void) => { listeners.add(l); return () => listeners.delete(l) },
    summaries: () => threads.map((t) => ({ meta: { ...t }, status: busy.has(t.id) ? 'working' : 'idle' })),
  } as unknown as ThreadManager
  const emit = (threadId: string, event: NormalizedEvent): void => {
    if (event.kind === 'user_text') busy.add(threadId)
    if (event.kind === 'result') busy.delete(threadId)
    for (const l of listeners) l({ threadId, event, status: busy.has(threadId) ? 'working' : 'idle' } as ThreadUpdate)
  }
  return { manager, emit }
}

describe('a run’s before/after observations (W7-05)', () => {
  it('tells changes made during the run from changes that were already there, and names concurrent work', async () => {
    const root = repo()
    writeFileSync(join(root, 'pre.txt'), 'already dirty\n')
    writeFileSync(join(root, 'again.txt'), 'already dirty\n')
    writeFileSync(join(root, 'reverted.txt'), 'dirty, then put back\n')
    const store = createRunObservationStore(mkdtempSync(join(tmpdir(), 'cockpit-runobs-state-')))
    const { manager, emit } = fakeManager([{ id: 't1', title: 'Mine', projectPath: root }, { id: 't2', title: 'Other', projectPath: root }])
    const observer = observeRuns(manager, store)
    emit('t1', { kind: 'user_text', text: 'go', runId: 'run-1' })
    await observer.settle()
    expect(store.get('run-1')?.before?.files.map((f) => f.path)).toEqual(['again.txt', 'pre.txt', 'reverted.txt'])

    writeFileSync(join(root, 'again.txt'), 'changed again\n')
    writeFileSync(join(root, 'new.txt'), 'new\n')
    writeFileSync(join(root, 'reverted.txt'), 'reverted.txt\n')
    // Another conversation in the same folder acts during the run: nothing is anyone's exclusively.
    emit('t2', { kind: 'tool_use', id: 'x', name: 'Write', input: {} })
    emit('t1', { kind: 'result', ok: true, runId: 'run-1' })
    await observer.settle()

    const view = runChanges('run-1', store.get('run-1'), false)
    expect(view.state).toBe('recorded')
    expect(view.preexisting).toBe(3)
    expect(view.comparison?.files).toEqual([
      { path: 'again.txt', status: 'modified', change: 'changed-again' },
      { path: 'new.txt', status: 'untracked', change: 'changed' },
      { path: 'pre.txt', status: 'modified', change: 'unchanged' },
      { path: 'reverted.txt', change: 'cleaned' },
    ])
    expect(view.concurrent).toEqual(['Other'])
    expect(view.comparison?.uncertain.join(' ')).toMatch(/Other conversations were working in this folder: Other/)
    observer.stop()
  })

  it('a commit or branch move during the run is reported, not folded into file changes', async () => {
    const root = repo()
    const store = createRunObservationStore(mkdtempSync(join(tmpdir(), 'cockpit-runobs-state-')))
    const { manager, emit } = fakeManager([{ id: 't1', title: 'Mine', projectPath: root }])
    const observer = observeRuns(manager, store)
    emit('t1', { kind: 'user_text', text: 'go', runId: 'run-2' })
    await observer.settle()
    writeFileSync(join(root, 'clean.txt'), 'committed\n')
    git(root, 'commit', '-q', '-am', 'during')
    emit('t1', { kind: 'result', ok: true, runId: 'run-2' })
    await observer.settle()
    const view = runChanges('run-2', store.get('run-2'), false)
    expect(view.comparison?.headMoved).toBe(true)
    expect(view.comparison?.files).toEqual([])
    expect(view.comparison?.uncertain.join(' ')).toMatch(/commit was made/)
  })

  it('a queued message’s run starts when the agent takes it; an agent acting before “before” is read marks it late', async () => {
    const root = repo()
    const store = createRunObservationStore(mkdtempSync(join(tmpdir(), 'cockpit-runobs-state-')))
    const { manager, emit } = fakeManager([{ id: 't1', title: 'Mine', projectPath: root }])
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const slow = async (path: string): Promise<Observation> => { await gate; return observe(path) }
    const observer = observeRuns(manager, store, slow)
    emit('t1', { kind: 'user_text', text: 'first', runId: 'run-a' })
    emit('t1', { kind: 'user_text', text: 'second', runId: 'run-b', queuedId: 'q1' })
    emit('t1', { kind: 'tool_use', id: 'x', name: 'Write', input: {} })
    release()
    await observer.settle()
    expect(store.get('run-a')?.lateBefore).toBe(true)
    expect(store.get('run-b')).toBeUndefined()
    emit('t1', { kind: 'user_taken', text: 'second', id: 'q1' })
    await observer.settle()
    expect(store.get('run-a')?.after).toBeDefined()
    expect(store.get('run-b')?.before).toBeDefined()
    expect(runChanges('run-b', store.get('run-b'), true).state).toBe('running')
    expect(runChanges('run-b', store.get('run-b'), false).state).toBe('incomplete')
    expect(runChanges('run-z', undefined, false).state).toBe('unrecorded')
  })

  it('a damaged or newer record fails visibly and is left exactly as found', () => {
    const state = mkdtempSync(join(tmpdir(), 'cockpit-runobs-state-'))
    const store = createRunObservationStore(state)
    mkdirSync(join(state, 'runs'))
    writeFileSync(join(state, 'runs', 'bad.json'), '{ not json')
    writeFileSync(join(state, 'runs', 'future.json'), JSON.stringify({ version: 99 }))
    expect(() => store.get('bad')).toThrow(StoreReadError)
    expect(() => store.get('future')).toThrow(/newer Cockpit/)
    expect(readFileSync(join(state, 'runs', 'bad.json'), 'utf8')).toBe('{ not json')
    expect(() => store.get('../escape')).toThrow(/Not a run ID/)
  })
})
