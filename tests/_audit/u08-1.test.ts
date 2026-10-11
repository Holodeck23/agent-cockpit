import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EventSink } from '../../server/agents/types.ts'
import type { Launcher } from '../../server/threads/manager.ts'
import { startServer, type RunningServer } from '../../server/start.ts'

// u08-1: saving a workflow whose project folder no longer exists must answer with the intended
// 400 "Project folder is unavailable" (server/http/workflow-routes.ts:16), not a 500 carrying a
// raw "ENOENT: no such file or directory, stat ..." that is also logged as an unexpected failure.
const closers: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closers.splice(0)) await close(); vi.restoreAllMocks() })

describe('u08-1: workflow save on a missing project folder', () => {
  it('answers 400 "Project folder is unavailable" and does not log an unexpected failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-u08-1-'))
    const launcher: Launcher = (_request, emit: EventSink) => {
      let alive = true
      return { agent: 'codex', alive: () => alive, send: () => undefined, respondApproval: () => undefined, interrupt: () => undefined,
        close: async () => { alive = false; emit({ kind: 'exit', code: 0 }) } }
    }
    const server: RunningServer = await startServer({ port: 0, webDist: root, stateRoot: root, launchers: { claude: launcher, codex: launcher } })
    closers.push(() => server.close())
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const missing = join(root, 'deleted-project-folder') // absolute, never created: "moved or deleted while Cockpit is open"
    const response = await fetch(`${server.url}/api/workflows`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: missing, name: 'inspect', prompt: 'Inspect this project' }),
    })
    const body = await response.json() as { error?: string }

    expect(response.status).toBe(400)
    expect(body.error).toBe('Project folder is unavailable')
    expect(logged).not.toHaveBeenCalled()
  })
})
