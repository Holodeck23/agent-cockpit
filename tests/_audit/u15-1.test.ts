import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCheckRunner } from '../../server/results/checks.ts'
import { createResultStore, type ResultStore } from '../../server/results/store.ts'

// u15-1: finish() marks a check terminal, then writes the terminal receipt. If that write throws
// (disk full, permissions), live.delete() and resolveDone() never ran, so the check stayed live
// forever: cancel() and shutdown() awaited its `done` for ever, and the card read "Running".

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { env: ENV, encoding: 'utf8' })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const timeout = <T>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(value), ms))

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'cockpit-u15-1-'))
  const project = join(base, 'project')
  mkdirSync(project)
  git(project, 'init', '-q', '-b', 'main')
  writeFileSync(join(project, 'a.txt'), 'a\n')
  git(project, 'add', '.'); git(project, 'commit', '-q', '-m', 'first')
  const state = join(base, 'state')
  mkdirSync(state)
  return { project, real: createResultStore(state) }
}

/** A store whose write of a terminal check record fails, as a full disk would. */
function failingTerminalWrites(real: ResultStore): ResultStore {
  return {
    ...real,
    update(runId, threadId, change) {
      const probe = change(real.get(runId) ?? { version: 1, runId, threadId, revision: 0, createdAt: '', updatedAt: '', checks: [], evidence: [], assessments: [] })
      if (probe.checks.some((c) => c.phase === 'terminal')) throw new Error('ENOSPC: no space left on device')
      return real.update(runId, threadId, change)
    },
  }
}

describe('u15-1: a failed terminal write still settles the check', () => {
  it('leaves nothing live, and cancel and shutdown return', async () => {
    const { project, real } = setup()
    const checks = createCheckRunner(failingTerminalWrites(real), { graceMs: 100 })
    // An event-handler throw would reach the process as an uncaught exception; capture instead of crashing the runner.
    const uncaught: unknown[] = []
    const saved = process.listeners('uncaughtException')
    process.removeAllListeners('uncaughtException')
    process.on('uncaughtException', (error) => { uncaught.push(error) })
    try {
      const running = await checks.start({ runId: 'run-1', threadId: 't1', projectPath: project, operationId: 'op-1', definition: { command: 'true' } })
      const deadline = Date.now() + 4000
      while (checks.isLive(running.id) && Date.now() < deadline) await sleep(50)
      expect(uncaught).toEqual([])
      expect(checks.isLive(running.id)).toBe(false)
      // Neither hangs on a check whose receipt could not be written.
      await expect(Promise.race([checks.cancel(running.id), timeout(2000, 'hung')])).resolves.not.toBe('hung')
      await expect(Promise.race([checks.shutdown().then(() => 'done'), timeout(2000, 'hung')])).resolves.toBe('done')
    } finally {
      process.removeAllListeners('uncaughtException')
      for (const l of saved) process.on('uncaughtException', l)
    }
  })
})
