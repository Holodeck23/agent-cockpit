import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EventSink } from '../../server/agents/types.ts'
import type { Launcher } from '../../server/threads/manager.ts'
import { startServer, type RunningServer } from '../../server/start.ts'

// lens-contract-2: the workflow store and runner refuse with plain Errors (name taken, schedule
// missing). The route answered 500 and logged "request failed" for
// each; they are refusals the person can fix, like the missing-folder one u08-1 already made a 4xx.
const closers: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closers.splice(0)) await close(); vi.restoreAllMocks() })

describe('lens-contract-2: workflow refusals are 4xx, not unexpected failures', () => {
  it('answers 409 for a taken name and for enabling a workflow that has no schedule', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-lens-contract-2-'))
    const project = join(root, 'project')
    mkdirSync(project)
    const launcher: Launcher = (_request, emit: EventSink) => {
      let alive = true
      return { agent: 'codex', alive: () => alive, send: () => undefined, respondApproval: () => undefined, interrupt: () => undefined,
        close: async () => { alive = false; emit({ kind: 'exit', code: 0 }) } }
    }
    const server: RunningServer = await startServer({ port: 0, webDist: root, stateRoot: root, launchers: { claude: launcher, codex: launcher } })
    closers.push(() => server.close())
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const post = (path: string, body: unknown) => fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const dataOf = async (response: Response) => ((await response.json()) as { data: { id: string } }).data

    const first = await post('/api/workflows', { projectPath: project, name: 'review', prompt: 'Review the changes' })
    expect(first.status).toBe(201)
    const firstId = (await dataOf(first)).id

    const duplicate = await post('/api/workflows', { projectPath: project, name: 'review', prompt: 'Another' })
    const noSchedule = await post(`/api/workflows/${firstId}/enabled`, { enabled: true })

    expect({ duplicate: duplicate.status, noSchedule: noSchedule.status }).toEqual({ duplicate: 409, noSchedule: 409 })
    expect(logged).not.toHaveBeenCalled()
    expect(((await duplicate.json()) as { error: string }).error).toBe('A workflow with that name already exists in this project')
  })

  it('still saves and schedules a good workflow', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-lens-contract-2b-'))
    const project = join(root, 'project')
    mkdirSync(project)
    const launcher: Launcher = (_request, emit: EventSink) => {
      let alive = true
      return { agent: 'codex', alive: () => alive, send: () => undefined, respondApproval: () => undefined, interrupt: () => undefined,
        close: async () => { alive = false; emit({ kind: 'exit', code: 0 }) } }
    }
    const server: RunningServer = await startServer({ port: 0, webDist: root, stateRoot: root, launchers: { claude: launcher, codex: launcher } })
    closers.push(() => server.close())
    const post = (path: string, body: unknown) => fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const saved = await post('/api/workflows', { projectPath: project, name: 'daily', prompt: 'Review', intervalMinutes: 60 })
    expect(saved.status).toBe(201)
    const id = ((await saved.json()) as { data: { id: string } }).data.id
    const scope = (await (await fetch(`${server.url}/api/workflows/${id}/schedule-scope`)).json()) as { data: { revision: string } }
    const enabled = await post(`/api/workflows/${id}/enabled`, { enabled: true, revision: scope.data.revision })
    expect(enabled.status).toBe(200)
    expect(((await enabled.json()) as { data: { enabled: boolean } }).data.enabled).toBe(true)
  })
})
