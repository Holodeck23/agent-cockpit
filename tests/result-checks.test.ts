import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { groupAlive } from '../server/processes/group.ts'
import { createCheckRunner, CheckConflictError, redact } from '../server/results/checks.ts'
import { freshness, takeFingerprint } from '../server/results/fingerprint.ts'
import { createResultService } from '../server/results/service.ts'
import { createResultStore } from '../server/results/store.ts'
import { StoreReadError } from '../server/state/read-error.ts'
import type { StoredEvent, ThreadMeta } from '../server/threads/types.ts'

// W7-08/09/10, CROSS-08 at the service level: host receipts, freshness and evidence integrity.

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { env: ENV, encoding: 'utf8' })

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'cockpit-checks-'))
  const project = join(base, 'project')
  mkdirSync(project)
  git(project, 'init', '-q', '-b', 'main')
  writeFileSync(join(project, 'input.txt'), 'one\n')
  writeFileSync(join(project, 'other.txt'), 'other\n')
  git(project, 'add', '.'); git(project, 'commit', '-q', '-m', 'first')
  const state = join(base, 'state')
  mkdirSync(state)
  const store = createResultStore(state)
  const checks = createCheckRunner(store, { graceMs: 300 })
  return { base, project, state, store, checks }
}

const meta = (project: string): ThreadMeta => ({
  id: 't1', title: 'Fix it', projectPath: project, settings: { agent: 'claude', permissionMode: 'manual', useHooks: false },
  sessionId: 's1', sessionStarted: true, completed: false, createdAt: '2026-10-05T10:00:00.000Z', updatedAt: '2026-10-05T10:00:00.000Z',
})
const events = (text = 'All tests passed. Receipt chk-forged-123.'): StoredEvent[] => [
  { ts: '2026-10-05T10:00:01.000Z', event: { kind: 'user_text', text: 'make it work', runId: 'run-1' } },
  { ts: '2026-10-05T10:00:02.000Z', event: { kind: 'assistant_text', messageId: 'assistant-1', text } },
  { ts: '2026-10-05T10:00:03.000Z', event: { kind: 'result', ok: true, runId: 'run-1' } },
]

const start = (s: ReturnType<typeof setup>, command: string, extra: Record<string, unknown> = {}, operationId = `op-${Math.random()}`) =>
  s.checks.start({ runId: 'run-1', threadId: 't1', projectPath: s.project, operationId, definition: { command, ...extra } })

describe('finite host checks (W7-08)', () => {
  it('records a failing command as failed, with its output stored before the outcome is readable', async () => {
    const s = setup()
    const running = await start(s, 'echo nope; exit 3')
    expect(running.phase).toBe('running')
    expect(s.store.get('run-1')!.checks[0]!.subject?.head).toMatch(/^[0-9a-f]{40}$/)
    await s.checks.settled(running.id)
    const done = s.store.get('run-1')!.checks[0]!
    expect(done).toMatchObject({ phase: 'terminal', outcome: 'failed', exitCode: 3, origin: 'host', approval: { by: 'user' } })
    const out = s.store.get('run-1')!.evidence.find((e) => e.id === done.output!.evidenceId)!
    expect(s.store.readEvidence('run-1', out)).toMatchObject({ state: 'ok' })
  })

  it('keeps a narrow criterion: exit 0 without the required text is a failure, and the criterion is recorded', async () => {
    const s = setup()
    const c = await start(s, 'echo "3 tests ran"', { criterion: { kind: 'output-includes', text: '0 failed' } })
    await s.checks.settled(c.id)
    const done = s.store.get('run-1')!.checks[0]!
    expect(done.outcome).toBe('failed')
    expect(done.exitCode).toBe(0)
    expect(done.definition.criterion).toEqual({ kind: 'output-includes', text: '0 failed' })
    const ok = await start(s, 'echo "12 passed, 0 failed"', { criterion: { kind: 'output-includes', text: '0 failed' } })
    await s.checks.settled(ok.id)
    expect(s.store.get('run-1')!.checks.find((x) => x.id === ok.id)!.outcome).toBe('passed')
  })

  it('cannot be made green by the agent: its "passed" text and a forged receipt ID are only the agent’s words', async () => {
    const s = setup()
    const service = createResultService({ store: s.store, checks: s.checks })
    const view = await service.view(meta(s.project), events(), 'run-1', false)
    expect(view.checks).toEqual([])
    expect(view.agentReport).toContain('chk-forged-123')
    expect(view.gaps).toContain('No checks were run for this result.')
    await expect(s.checks.cancel('chk-forged-123')).resolves.toBeUndefined()
  })

  it('replays one operation ID to its receipt, and refuses it for a different check', async () => {
    const s = setup()
    const first = await start(s, 'true', {}, 'op-1')
    await s.checks.settled(first.id)
    expect((await start(s, 'true', {}, 'op-1')).id).toBe(first.id)
    await expect(start(s, 'false', {}, 'op-1')).rejects.toBeInstanceOf(CheckConflictError)
    expect(s.store.get('run-1')!.checks).toHaveLength(1)
  })

  it('refuses a folder or declared input outside the workspace', async () => {
    const s = setup()
    await expect(start(s, 'true', { cwd: '..' })).rejects.toThrow(/inside the workspace/)
    await expect(start(s, 'true', { inputs: ['../state'] })).rejects.toThrow(/inside the workspace/)
  })

  it('redacts likely credentials and passed-through values from stored output', () => {
    expect(redact('API_KEY=abc123def token sk-abcdefghijklmnopqrstu', ['supersecretvalue'])).toBe('API_KEY=[redacted] token [redacted]')
    expect(redact('value supersecretvalue here', ['supersecretvalue'])).toBe('value [redacted] here')
  })
})

describe('cancelling a check (W7-10)', () => {
  it('ends cancelled even though the command exits 0 when stopped; its group is gone and another server is untouched', async () => {
    const s = setup()
    const other = spawn('/bin/sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' })
    try {
      // Traps the stop and exits 0, the way a test runner reports success on SIGTERM.
      const c = await start(s, "trap 'exit 0' TERM; echo started; sleep 30 & wait")
      await new Promise((r) => setTimeout(r, 200))
      const cancelled = await s.checks.cancel(c.id)
      expect(cancelled).toMatchObject({ phase: 'terminal', outcome: 'cancelled' })
      expect(s.store.get('run-1')!.checks.filter((x) => x.phase === 'terminal')).toHaveLength(1)
      expect(groupAlive(c.pid!)).toBe(false)
      expect(groupAlive(other.pid!)).toBe(true)
      // A second cancel changes nothing.
      expect((await s.checks.cancel(c.id))!.outcome).toBe('cancelled')
    } finally { process.kill(-other.pid!, 'SIGKILL') }
  })

  it('times out to a terminal state, never an endless running check', async () => {
    const s = setup()
    const c = await start(s, 'sleep 30', { timeoutSec: 1 })
    await s.checks.settled(c.id)
    expect(s.store.get('run-1')!.checks[0]!.outcome).toBe('timed-out')
  })

  it('reports a check an earlier launch left running as interrupted, without signalling it', async () => {
    const s = setup()
    const c = await start(s, 'sleep 30', { timeoutSec: 60 })
    // A new launch: a runner that never started it.
    const later = createCheckRunner(s.store)
    const service = createResultService({ store: s.store, checks: later })
    const view = await service.view(meta(s.project), events(), 'run-1', false)
    expect(view.checks[0]).toMatchObject({ outcome: 'interrupted', phase: 'terminal' })
    expect(groupAlive(c.pid!)).toBe(true)
    await s.checks.shutdown()
  })
})

describe('freshness and evidence (W7-09, CROSS-08)', () => {
  it('turns a pass stale when a declared input is edited, and keeps it stale across a restart', async () => {
    const s = setup()
    const c = await start(s, 'cat input.txt', { inputs: ['input.txt'] })
    await s.checks.settled(c.id)
    const service = createResultService({ store: s.store, checks: s.checks })
    expect((await service.view(meta(s.project), events(), 'run-1', false)).checks[0]!.freshness).toEqual({ state: 'fresh' })
    writeFileSync(join(s.project, 'input.txt'), 'two\n')
    git(s.project, 'commit', '-qam', 'edit input') // an external edit that is committed: clean tree, new HEAD
    const restarted = createResultService({ store: createResultStore(s.state), checks: createCheckRunner(createResultStore(s.state)) })
    const view = await restarted.view(meta(s.project), events(), 'run-1', false)
    expect(view.checks[0]!.outcome).toBe('passed')
    expect(view.checks[0]!.freshness).toMatchObject({ state: 'stale' })
    expect(view.gaps.some((g) => g.includes('earlier state'))).toBe(true)
  })

  it('names the edited declared input, even outside Git', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-nongit-'))
    writeFileSync(join(dir, 'a.txt'), 'a')
    const then = await takeFingerprint(dir, ['a.txt'])
    expect(then.repo).toBe(false)
    writeFileSync(join(dir, 'a.txt'), 'b')
    const result = freshness(then, await takeFingerprint(dir, ['a.txt']))
    expect(result).toMatchObject({ state: 'stale' })
    expect(JSON.stringify(result)).toContain('a.txt')
  })

  it('treats a capture as evidence, not a pass, and reports deleted or corrupt evidence without replacing it', async () => {
    const s = setup()
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')
    const service = createResultService({ store: s.store, checks: s.checks, capturePreview: async () => ({ data: png, mimeType: 'image/png', width: 1280, height: 800 }) })
    const shot = await service.capture(meta(s.project), 'run-1', 'http://localhost:5173/')
    let view = await service.view(meta(s.project), events(), 'run-1', false)
    expect(view.previews[0]).toMatchObject({ integrity: 'ok', assessments: [], preview: { url: 'http://localhost:5173/', viewport: { width: 1280, height: 800 } } })
    expect(view.gaps).toContain('A preview was captured but nobody has said whether it looks right.')
    service.assess(meta(s.project), 'run-1', shot.id, 'looks-right')
    view = await service.view(meta(s.project), events(), 'run-1', false)
    expect(view.previews[0]!.assessments[0]).toMatchObject({ by: 'human', verdict: 'looks-right' })

    const file = join(s.state, 'results', 'run-1', shot.file)
    writeFileSync(file, 'tampered')
    view = await service.view(meta(s.project), events(), 'run-1', false)
    expect(view.previews[0]!.integrity).toBe('corrupt')
    expect(readFileSync(file, 'utf8')).toBe('tampered')
    unlinkSync(file)
    view = await service.view(meta(s.project), events(), 'run-1', false)
    expect(view.previews[0]!.integrity).toBe('missing')
    expect(view.gaps.some((g) => g.includes('missing'))).toBe(true)
  })

  it('leaves a damaged result file untouched, shows the rest of the card and refuses new checks', async () => {
    const s = setup()
    mkdirSync(join(s.state, 'results'), { recursive: true })
    writeFileSync(join(s.state, 'results', 'run-1.json'), '{oops')
    const service = createResultService({ store: s.store, checks: s.checks })
    const view = await service.view(meta(s.project), events(), 'run-1', false)
    expect(view.recordError).toMatch(/cannot read/)
    expect(view.agentReport).toBeDefined()
    await expect(start(s, 'true')).rejects.toBeInstanceOf(StoreReadError)
    expect(readFileSync(join(s.state, 'results', 'run-1.json'), 'utf8')).toBe('{oops')
  })
})

describe('whose run a result is (CROSS-04 evidence attribution)', () => {
  const ACC = '0f1e2d3c-4b5a-4968-8776-655443322110'
  const run = (n: number, binding: string, account?: { id: string; generation: number }): StoredEvent[] => [
    // As the manager records them: the launch's boundary, then the message that started it.
    { ts: `2026-10-05T10:0${n}:00.000Z`, event: { kind: 'session_boundary', generation: n, bindingId: binding, ...(account ? { account } : {}) } },
    { ts: `2026-10-05T10:0${n}:01.000Z`, event: { kind: 'user_text', text: `run ${n}`, runId: `run-${n}` } },
    { ts: `2026-10-05T10:0${n}:02.000Z`, event: { kind: 'result', ok: true, runId: `run-${n}` } },
  ]

  it('names the account its session ran on, and keeps it after the project moves to another account', async () => {
    const s = setup()
    const service = createResultService({ store: s.store, checks: s.checks })
    const history = [...run(1, 'b-default', { id: 'default-claude', generation: 0 }), ...run(2, 'b-work', { id: ACC, generation: 3 }), ...run(3, 'b-default2', { id: 'default-claude', generation: 0 })]
    const m = { ...meta(s.project), bindingId: 'b-default2' } as ThreadMeta
    expect((await service.view(m, history, 'run-1', false)).identity.account).toBe('default')
    expect((await service.view(m, history, 'run-2', false)).identity.account).toEqual({ id: ACC, generation: 3 })
    expect((await service.view(m, history, 'run-3', false)).identity.account).toBe('default')
  })

  it('reads a run from before account profiles as the default', async () => {
    const s = setup()
    const service = createResultService({ store: s.store, checks: s.checks })
    expect((await service.view(meta(s.project), events(), 'run-1', false)).identity.account).toBe('default')
  })
})
