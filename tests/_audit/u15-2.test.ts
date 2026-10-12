import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { observe } from '../../server/git/observe.ts'
import { createCheckRunner } from '../../server/results/checks.ts'
import { createResultStore } from '../../server/results/store.ts'

// u15-2: start() only registered the check as live after its subject fingerprint (git observation)
// was taken, so Stop, delete and shutdown during that window found nothing to cancel and the
// command ran anyway.

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { env: ENV, encoding: 'utf8' })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const timeout = <T>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms))

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'cockpit-u15-2-'))
  const project = join(base, 'project')
  mkdirSync(project)
  git(project, 'init', '-q', '-b', 'main')
  writeFileSync(join(project, 'a.txt'), 'a\n')
  git(project, 'add', '.'); git(project, 'commit', '-q', '-m', 'first')
  const state = join(base, 'state')
  mkdirSync(state)
  return { project, store: createResultStore(state) }
}

describe('u15-2: a check still being fingerprinted can be stopped', () => {
  it('Stop during the fingerprint means the command never runs and the receipt says cancelled', async () => {
    const { project, store } = setup()
    const observed = await observe(project)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const checks = createCheckRunner(store, { graceMs: 100, look: async () => { await gate; return observed } })
    const marker = join(project, 'ran.marker')
    try {
      const starting = checks.start({ runId: 'run-1', threadId: 't1', projectPath: project, operationId: 'op-1', definition: { command: 'touch ran.marker' } })
      await sleep(50)
      const cancelling = checks.cancelForThread('t1')
      release()
      await cancelling
      const record = await starting
      await sleep(400)
      expect(existsSync(marker)).toBe(false)
      expect(record).toMatchObject({ phase: 'terminal', outcome: 'cancelled' })
      expect(store.get('run-1')!.checks).toHaveLength(1)
      expect(store.get('run-1')!.checks[0]).toMatchObject({ phase: 'terminal', outcome: 'cancelled' })
      expect(checks.isLive(record.id)).toBe(false)
    } finally {
      release()
      await checks.shutdown()
    }
  })

  it('shutdown during the fingerprint also stops it before it starts', async () => {
    const { project, store } = setup()
    const observed = await observe(project)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const checks = createCheckRunner(store, { graceMs: 100, look: async () => { await gate; return observed } })
    const marker = join(project, 'ran-shutdown.marker')
    const starting = checks.start({ runId: 'run-1', threadId: 't1', projectPath: project, operationId: 'op-1', definition: { command: 'touch ran-shutdown.marker' } })
    await sleep(50)
    const closing = checks.shutdown()
    release()
    await closing
    await starting
    await sleep(400)
    expect(existsSync(marker)).toBe(false)
  })

  it('a fingerprint that fails does not leave a phantom live check behind', async () => {
    const { project, store } = setup()
    const checks = createCheckRunner(store, { graceMs: 100, look: async () => { throw new Error('git went away') } })
    await expect(checks.start({ runId: 'run-1', threadId: 't1', projectPath: project, operationId: 'op-1', definition: { command: 'true' } })).rejects.toThrow('git went away')
    await expect(Promise.race([checks.shutdown().then(() => 'done'), timeout(2000, 'hung')])).resolves.toBe('done')
    await expect(Promise.race([checks.cancelForThread('t1').then(() => 'done'), timeout(2000, 'hung')])).resolves.toBe('done')
  })
})
