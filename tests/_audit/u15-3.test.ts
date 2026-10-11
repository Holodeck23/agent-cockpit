import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCheckRunner } from '../../server/results/checks.ts'
import { createResultService } from '../../server/results/service.ts'
import { createResultStore } from '../../server/results/store.ts'
import type { StoredEvent, ThreadMeta } from '../../server/threads/types.ts'

// u15-3: the Gaps summary kept only the newest check per command text, so the same command in
// another folder (or with another required output) shadowed an older failing check.

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { env: ENV, encoding: 'utf8' })

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'cockpit-u15-3-'))
  const project = join(base, 'project')
  mkdirSync(join(project, 'packages', 'a'), { recursive: true })
  mkdirSync(join(project, 'packages', 'b'), { recursive: true })
  git(project, 'init', '-q', '-b', 'main')
  writeFileSync(join(project, 'packages', 'a', 'x.txt'), 'x\n')
  writeFileSync(join(project, 'packages', 'b', 'x.txt'), 'x\n')
  git(project, 'add', '.'); git(project, 'commit', '-q', '-m', 'first')
  const state = join(base, 'state')
  mkdirSync(state)
  const store = createResultStore(state)
  const checks = createCheckRunner(store, { graceMs: 200 })
  return { project, store, checks, service: createResultService({ store, checks }) }
}

const meta = (project: string): ThreadMeta => ({
  id: 't1', title: 'Fix it', projectPath: project, settings: { agent: 'claude', permissionMode: 'manual', useHooks: false },
  sessionId: 's1', sessionStarted: true, completed: false, createdAt: '2026-10-05T10:00:00.000Z', updatedAt: '2026-10-05T10:00:00.000Z',
})
const events: StoredEvent[] = [
  { ts: '2026-10-05T10:00:01.000Z', event: { kind: 'user_text', text: 'make it work', runId: 'run-1' } },
  { ts: '2026-10-05T10:00:03.000Z', event: { kind: 'result', ok: true, runId: 'run-1' } },
]

// Fails in packages/a, passes in packages/b: the same command text in two folders.
const COMMAND = 'test "$(basename "$PWD")" = b'

describe('u15-3: gaps judge each distinct check, not each command text', () => {
  it('a failing check in one folder is not hidden by a passing run of the same command in another', async () => {
    const s = setup()
    const run = (cwd: string, operationId: string) => s.checks.start({ runId: 'run-1', threadId: 't1', projectPath: s.project, operationId, definition: { command: COMMAND, cwd } })
    const a = await run('packages/a', 'op-a')
    await s.checks.settled(a.id)
    await new Promise((r) => setTimeout(r, 20))
    const b = await run('packages/b', 'op-b')
    await s.checks.settled(b.id)
    const view = await s.service.view(meta(s.project), events, 'run-1', false)
    expect(view.checks.map((c) => c.outcome).sort()).toEqual(['failed', 'passed'])
    expect(view.gaps.some((g) => g.includes(COMMAND) && g.includes('failed'))).toBe(true)
  })

  it('a re-run of the very same check still supersedes its earlier failure', async () => {
    const s = setup()
    const run = (operationId: string) => s.checks.start({ runId: 'run-1', threadId: 't1', projectPath: s.project, operationId, definition: { command: 'test -f x.txt || (echo once > x.txt; exit 1)', cwd: 'packages/a', inputs: [] } })
    const first = await run('op-1')
    await s.checks.settled(first.id)
    await new Promise((r) => setTimeout(r, 20))
    const second = await run('op-2')
    await s.checks.settled(second.id)
    const view = await s.service.view(meta(s.project), events, 'run-1', false)
    expect(view.checks.map((c) => c.outcome).sort()).toEqual(['passed', 'passed'])
    expect(view.gaps.filter((g) => g.includes('failed'))).toEqual([])
  })

  it('the same command with another required output is a different check', async () => {
    const s = setup()
    const first = await s.checks.start({ runId: 'run-1', threadId: 't1', projectPath: s.project, operationId: 'op-1', definition: { command: 'echo ok', criterion: { kind: 'output-includes', text: 'missing text' } } })
    await s.checks.settled(first.id)
    await new Promise((r) => setTimeout(r, 20))
    const second = await s.checks.start({ runId: 'run-1', threadId: 't1', projectPath: s.project, operationId: 'op-2', definition: { command: 'echo ok' } })
    await s.checks.settled(second.id)
    const view = await s.service.view(meta(s.project), events, 'run-1', false)
    expect(view.gaps.some((g) => g.includes('echo ok') && g.includes('failed'))).toBe(true)
  })
})
