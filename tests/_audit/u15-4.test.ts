import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCheckRunner } from '../../server/results/checks.ts'
import { createResultStore, RESULT_VERSION, type CheckRecord } from '../../server/results/store.ts'
import { startServer, type RunningServer } from '../../server/start.ts'

// u15-4: looking up a check that is not live scanned every result file with store.get(), which
// throws StoreReadError for one damaged or newer file, so one bad file broke the lookup for all.

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'cockpit-u15-4-'))
  const state = join(base, 'state')
  mkdirSync(join(state, 'results'), { recursive: true })
  return { state, store: createResultStore(state) }
}

const record = (id: string): CheckRecord => ({
  id, runId: 'run-good', threadId: 't1', projectPath: '/p', operationId: 'op-1',
  definition: { command: 'true', cwd: '.', env: [], timeoutSec: 60, criterion: { kind: 'exit-zero' }, inputs: [] },
  inputHash: 'h', approval: { by: 'user', at: '2026-10-05T10:00:00.000Z' }, origin: 'host', phase: 'terminal', outcome: 'passed',
  preparedAt: '2026-10-05T10:00:00.000Z', endedAt: '2026-10-05T10:00:01.000Z',
})

describe('u15-4: one unreadable result file does not break a check lookup', () => {
  it('cancel() of a finished check still finds it beside a damaged file and a newer-version file', async () => {
    const { state, store } = setup()
    store.update('run-good', 't1', (f) => ({ ...f, checks: [record('chk-good')] }))
    writeFileSync(join(state, 'results', 'aaa-damaged.json'), '{oops')
    writeFileSync(join(state, 'results', 'aab-future.json'), JSON.stringify({ version: RESULT_VERSION + 1 }))
    const checks = createCheckRunner(store)
    await expect(checks.cancel('chk-good')).resolves.toMatchObject({ id: 'chk-good', outcome: 'passed' })
    await expect(checks.cancel('chk-nobody')).resolves.toBeUndefined()
  })
})

// The main site: activeIn() in server/start.ts (removal, archive and merge preflight) read every result
// file through the same throwing store.get(), so one bad file made every worktree removal answer 500.
describe('u15-4: one unreadable result file does not block removing a worktree', () => {
  let running: RunningServer | undefined
  afterEach(async () => { await running?.close(); running = undefined })

  it('the removal check and the removal itself still work beside a damaged and a newer-version result file', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-u15-4-routes-')))
    const repo = join(dir, 'garden')
    mkdirSync(repo)
    const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' }
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'], { env })
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    execFileSync('git', ['-C', repo, 'add', '.'], { env })
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'first'], { env })

    const stateRoot = join(dir, 'state')
    mkdirSync(join(stateRoot, 'results'), { recursive: true })
    writeFileSync(join(stateRoot, 'results', 'aaa-damaged.json'), '{oops')
    writeFileSync(join(stateRoot, 'results', 'aab-future.json'), JSON.stringify({ version: RESULT_VERSION + 1 }))

    running = await startServer({ port: 0, webDist: dir, stateRoot })
    const call = async (path: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const res = await fetch(`${running!.url}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, body: await res.json() }
    }
    await call('/api/projects', { path: repo, pinned: true })
    const projectId = (await call('/api/projects')).body.data.find((p: { path: string }) => p.path === repo).projectId as string
    const worktree = (await call(`/api/projects/${projectId}/workspaces`, { name: 'Spike' })).body.data.workspace as { id: string }

    const check = await call(`/api/workspaces/${worktree.id}/removal`)
    expect(check.status).toBe(200)
    expect(check.body.data.removable).toBe(true)
    const removed = await call(`/api/workspaces/${worktree.id}/remove`, { fingerprint: check.body.data.fingerprint })
    expect(removed.status).toBe(200)
    expect(removed.body.data.workspace).toMatchObject({ lifecycle: 'removed' })
  })
})
