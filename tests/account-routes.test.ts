import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSession } from '../server/agents/types.ts'
import { isRemoteRoute } from '../server/remote/guard.ts'
import { startServer, type RunningServer } from '../server/start.ts'
import type { LaunchRequest, Launcher } from '../server/threads/manager.ts'

// Order 16 routes end to end (INTERFACES /api/accounts): add a profile through the CLI's own
// sign-in, choose it for one project, and the conversation there launches in that context while
// another project stays on the CLI default. Desktop only; nothing returned names a folder.

const FIXTURE = resolve('scripts/fixtures/accounts-agent')

describe('account routes', () => {
  let running: RunningServer | undefined
  afterEach(async () => { await running?.close(); running = undefined })

  const start = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-account-routes-'))
    const launches: LaunchRequest[] = []
    const launcher: Launcher = (request, onEvent) => {
      launches.push(request)
      let alive = true
      const session: AgentSession = { agent: 'claude', send: () => onEvent({ kind: 'result', ok: true }), respondApproval: () => undefined, interrupt: () => undefined,
        close: () => { alive = false; onEvent({ kind: 'exit', code: 0 }); return Promise.resolve() }, alive: () => alive }
      return session
    }
    running = await startServer({ port: 0, webDist: dir, stateRoot: join(dir, 'state'), launchers: { claude: launcher }, capabilities: { get: async (agent) => ({
      agent, context: 'default', models: { state: 'not_checked' }, settings: {}, auth: { state: 'not_checked' },
      executable: { state: 'found', identity: { command: agent, path: join(FIXTURE, agent), realpath: join(FIXTURE, agent), fingerprint: 'fixture' } },
    }) } })
    const call = async (path: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const res = await fetch(`${running!.url}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, body: await res.json() }
    }
    const project = async (path: string): Promise<string> => {
      mkdirSync(path, { recursive: true })
      await call('/api/projects', { path, pinned: true })
      const listed = await call('/api/projects')
      return listed.body.data.find((p: { path: string }) => p.path === path).projectId
    }
    return { call, project, launches, dir }
  }

  it('adds a profile, chooses it for one project, and only that project launches in its context', async () => {
    const { call, project, launches, dir } = await start()
    const work = await project(join(dir, 'work'))
    const home = await project(join(dir, 'home'))
    const list = await call('/api/accounts')
    expect(list.body.data.support).toMatchObject({ claude: { profiles: true, takesCode: true }, codex: { profiles: true }, antigravity: { profiles: false } })
    expect(list.body.data.accounts.map((a: { id: string }) => a.id)).toContain('default-claude')

    const started = await call('/api/accounts', { agent: 'claude', label: 'Work' })
    expect(started.status).toBe(202)
    const id = started.body.data.id as string
    let view = started.body.data
    for (let i = 0; i < 100 && !view.url; i++) { await new Promise((r) => setTimeout(r, 50)); view = (await call(`/api/accounts/signins/${id}`)).body.data }
    expect(view.url).toMatch(/^https:\/\/claude\.com\//)
    expect((await call(`/api/accounts/signins/${id}/input`, { text: 'ok:work@example.com' })).status).toBe(200)
    for (let i = 0; i < 100 && !view.endedAt; i++) { await new Promise((r) => setTimeout(r, 50)); view = (await call(`/api/accounts/signins/${id}`)).body.data }
    expect(view).toMatchObject({ state: 'verified', account: { label: 'Work', identity: { hint: 'w…@example.com · pro' } } })
    const accountId = view.account.id as string
    expect(JSON.stringify((await call('/api/accounts')).body)).not.toContain('account-profiles')

    const chosen = await call(`/api/projects/${work}/accounts/claude`, { accountId })
    expect(chosen.body.data.selection.claude).toBe(accountId)
    expect((await call(`/api/projects/${home}/accounts`)).body.data.selection.claude).toBe('default-claude')

    await call('/api/threads', { projectPath: join(dir, 'work'), text: 'on work' })
    await call('/api/threads', { projectPath: join(dir, 'home'), text: 'on home' })
    expect(launches[0]!.accountEnv?.CLAUDE_CONFIG_DIR).toMatch(new RegExp(`account-profiles/${accountId}$`))
    expect(launches[1]!.accountEnv).toBeUndefined()

    // Its turn has finished (the session idles on): removal is refused only because the project still chooses it.
    const refused = await call(`/api/accounts/${accountId}/remove`, {})
    expect(refused.status).toBe(409)
    expect(refused.body.projects).toEqual([join(dir, 'work')])
  }, 30_000)

  it('rejects bad input and unknown targets', async () => {
    const { call, project, dir } = await start()
    const work = await project(join(dir, 'work'))
    expect((await call('/api/accounts', { agent: 'claude', label: '' })).status).toBe(400)
    expect((await call('/api/accounts', { agent: 'antigravity', label: 'B' })).status).toBe(422)
    expect((await call(`/api/projects/${work}/accounts/claude`, { accountId: 'nope' })).status).toBe(422)
    expect((await call(`/api/projects/${work}/accounts/martian`, { accountId: 'x' })).status).toBe(404)
    expect((await call('/api/projects/00000000-0000-4000-8000-000000000000/accounts')).status).toBe(404)
    expect((await call('/api/accounts/signins/none')).status).toBe(404)
  })

  it('keeps every account route off the phone', () => {
    for (const [method, path] of [['GET', '/api/accounts'], ['POST', '/api/accounts'], ['GET', '/api/accounts/signins/x'], ['POST', '/api/accounts/signins/x/input'],
      ['POST', '/api/accounts/x/remove'], ['POST', '/api/accounts/x/refresh'], ['GET', '/api/projects/x/accounts'], ['POST', '/api/projects/x/accounts/claude']] as const) {
      expect(isRemoteRoute(method, path)).toBe(false)
    }
  })
})
