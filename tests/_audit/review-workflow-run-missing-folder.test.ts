import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EventSink } from '../../server/agents/types.ts'
import { startServer, type RunningServer } from '../../server/start.ts'
import { createThreadManager, type Launcher } from '../../server/threads/manager.ts'
import { createThreadStore } from '../../server/threads/store.ts'
import { createWorkflowRunner } from '../../server/workflows/runner.ts'
import { createWorkflowStore } from '../../server/workflows/store.ts'

// Review of u08: the run path (manual and scheduled) still called statSync(projectPath) without
// throwIfNoEntry, so a project folder that was moved or deleted surfaced as a raw
// "ENOENT: no such file or directory, stat ..." in lastError and as an unexpected 500.

const closers: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closers.splice(0)) await close(); vi.restoreAllMocks() })

const launcher: Launcher = (_request, emit: EventSink) => {
  let alive = true
  return { agent: 'codex', alive: () => alive, send: () => undefined, respondApproval: () => undefined, interrupt: () => undefined,
    close: async () => { alive = false; emit({ kind: 'exit', code: 0 }) } }
}

describe('review: running a workflow whose project folder is gone', () => {
  it('the runner says the folder is unavailable, keeps that as the reason and pauses the schedule', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-review-wf-'))
    const project = join(root, 'proj'); mkdirSync(project)
    const store = createWorkflowStore(root)
    const threads = createThreadStore(root)
    const manager = createThreadManager(threads, { launchers: { claude: launcher, codex: launcher } })
    const runner = createWorkflowRunner(store, manager, threads)
    closers.push(async () => { runner.close(); await manager.shutdown() })
    const workflow = store.save({ projectPath: project, name: 'inspect', prompt: 'Inspect', intervalMinutes: 5 })
    runner.setEnabled(workflow.id, true)
    rmSync(project, { recursive: true })

    expect(() => runner.run(workflow.id)).toThrow('Project folder is unavailable')
    const after = store.get(workflow.id)
    expect(after?.lastError).toBe('Project folder is unavailable')
    expect(after?.enabled).toBe(false)
  })

  it('POST /api/workflows/:id/run answers 400 with that message and logs no unexpected failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-review-wf-http-'))
    const project = join(root, 'proj'); mkdirSync(project)
    const server: RunningServer = await startServer({ port: 0, webDist: root, stateRoot: root, launchers: { claude: launcher, codex: launcher } })
    closers.push(() => server.close())
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const created = await fetch(`${server.url}/api/workflows`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: project, name: 'inspect', prompt: 'Inspect this project' }),
    })
    const { data } = await created.json() as { data: { id: string } }
    rmSync(project, { recursive: true })

    const response = await fetch(`${server.url}/api/workflows/${data.id}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const body = await response.json() as { error?: string }
    expect(response.status).toBe(400)
    expect(body.error).toBe('Project folder is unavailable')
    expect(logged).not.toHaveBeenCalled()
  })
})
