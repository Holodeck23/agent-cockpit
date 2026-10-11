import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EventSink } from '../../server/agents/types.ts'
import type { Launcher } from '../../server/threads/manager.ts'
import { startServer, type RunningServer } from '../../server/start.ts'

// lens-contract-1: a stale approval, a stale question card, a take-back the agent already beat, and an
// agent switch while a turn is running are refusals. /dismiss and /settings answer the same kind of
// manager refusal with 409; these four fell through to the generic 500 and logged "request failed".
const closers: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closers.splice(0)) await close(); vi.restoreAllMocks() })

describe('lens-contract-1: out-of-date requests on a conversation are refusals, not server failures', () => {
  it('answers 409 (and logs no unexpected failure) for a stale approval, question, take-back and a busy agent switch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-lens-contract-1-'))
    const launcher: Launcher = (_request, emit: EventSink) => {
      let alive = true
      return { agent: 'codex', alive: () => alive, send: () => undefined, respondApproval: () => undefined, interrupt: () => undefined,
        close: async () => { alive = false; emit({ kind: 'exit', code: 0 }) } }
    }
    const server: RunningServer = await startServer({ port: 0, webDist: root, stateRoot: root, launchers: { claude: launcher, codex: launcher } })
    closers.push(() => server.close())
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const post = (path: string, body: unknown) => fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

    const created = await post('/api/threads', { projectPath: root, text: 'go', settings: { agent: 'codex' } })
    expect(created.status).toBe(201)
    const id = ((await created.json()) as { data: { id: string } }).data.id

    const results = {
      approval: await post(`/api/threads/${id}/approvals/gone`, { behavior: 'allow' }),
      question: await post(`/api/threads/${id}/questions/gone`, { answers: { a: 'b' } }),
      takeBack: await post(`/api/threads/${id}/queued/gone/remove`, {}),
      // The turn started by the message above is still running: switching agents must wait for it.
      switchWhileRunning: await post(`/api/threads/${id}/agent`, { settings: { agent: 'claude' }, handoff: 'a'.repeat(64) }),
    }
    const statuses = Object.fromEntries(Object.entries(results).map(([name, response]) => [name, response.status]))

    expect(statuses).toEqual({ approval: 409, question: 409, takeBack: 409, switchWhileRunning: 409 })
    expect(logged).not.toHaveBeenCalled()
    // The reason still reaches the person.
    expect(((await results.approval.json()) as { error: string }).error).toMatch(/approval/)
  })

  it('keeps a malformed body a 400', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-lens-contract-1b-'))
    const launcher: Launcher = (_request, emit: EventSink) => {
      let alive = true
      return { agent: 'codex', alive: () => alive, send: () => undefined, respondApproval: () => undefined, interrupt: () => undefined,
        close: async () => { alive = false; emit({ kind: 'exit', code: 0 }) } }
    }
    const server: RunningServer = await startServer({ port: 0, webDist: root, stateRoot: root, launchers: { claude: launcher, codex: launcher } })
    closers.push(() => server.close())
    const post = (path: string, body: unknown) => fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const created = await post('/api/threads', { projectPath: root, text: 'go', settings: { agent: 'codex' } })
    const id = ((await created.json()) as { data: { id: string } }).data.id

    expect((await post(`/api/threads/${id}/approvals/gone`, { behavior: 'maybe' })).status).toBe(400)
    expect((await post(`/api/threads/${id}/agent`, { settings: { agent: 'claude' }, handoff: 'nope' })).status).toBe(400)
  })
})
