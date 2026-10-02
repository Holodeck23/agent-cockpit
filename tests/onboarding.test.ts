import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { automaticAgent, dismissDirector, prepareSample } from '../server/onboarding/director.ts'
import type { AgentStatus } from '../server/agents/status.ts'
import { startServer, type RunningServer } from '../server/start.ts'

const temp = () => mkdtempSync(join(tmpdir(), 'cockpit-director-'))
const statuses = (ids: AgentStatus['id'][]): AgentStatus[] => ids.map((id) => ({ id, installation: { installed: true, version: 'fixture' } }))
let server: RunningServer | undefined
afterEach(async () => { await server?.close(); server = undefined })
async function start(installed = 'codex', root = temp()) {
  server = await startServer({ port: 0, webDist: root, stateRoot: root,
    agentProbe: async (command) => command === installed ? { installed: true, version: 'fixture' } : { installed: false, problem: 'absent' },
    launchers: { codex: (_options, sink) => ({ agent: 'codex', alive: () => true,
      send: () => { sink({ kind: 'session', sessionId: 'fixture-session' }); sink({ kind: 'result', ok: true }) },
      respondApproval() {}, interrupt() {}, close: async () => {},
    }) },
  })
  return server
}
async function call(path = '', body?: unknown) {
  return fetch(`${server!.url}/api/onboarding${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}

describe('first-run director', () => {
  it('uses an installed provider, and requires a preview-capable provider for the sample', () => {
    expect(automaticAgent(statuses(['codex']))).toBe('codex')
    expect(automaticAgent(statuses(['opencode', 'claude']))).toBe('claude')
    expect(automaticAgent(statuses(['antigravity']))).toBe('antigravity')
    expect(automaticAgent(statuses(['antigravity']), [], true)).toBeUndefined()
    expect(automaticAgent([])).toBeUndefined()
  })
  it('shows only on a fresh home; skip survives a new server and origin', async () => {
    const s = await start()
    expect(await (await call()).json()).toEqual({ data: { show: true } })
    expect((await call('/dismiss', {})).status).toBe(200)
    await s.close(); server = undefined
    await start('codex', s.store.root)
    expect(await (await call()).json()).toEqual({ data: { show: false } })
  })
  it('does not interrupt an existing project, even when hidden', async () => {
    const s = await start()
    s.projects.open(temp()); s.projects.hide(s.projects.list()[0]!.path)
    expect(await (await call()).json()).toEqual({ data: { show: false } })
  })
  it('starts project orientation with safe defaults and no invented model', async () => {
    const s = await start()
    const projectPath = temp()
    const response = await call('/start', { kind: 'project', projectPath })
    expect(response.status).toBe(201)
    const { data } = await response.json()
    expect(data.settings).toEqual({ agent: 'codex', permissionMode: 'manual', useHooks: false })
    expect(s.store.events(data.id).find((e) => e.event.kind === 'user_text')?.event).toMatchObject({ text: expect.stringContaining('Leave the files unchanged') })
    expect(await (await call()).json()).toEqual({ data: { show: false } })
  })
  it('refuses unavailable agents, bad folders and malformed actions without creating threads or a sample', async () => {
    const s = await start('absent')
    expect((await call('/start', { kind: 'sample' })).status).toBe(409)
    expect(s.store.list()).toHaveLength(0)
    expect(existsSync(join(s.store.root, 'samples'))).toBe(false)
    expect((await call('/start', { kind: 'unknown' })).status).toBe(400)
    await s.close(); server = undefined
    await start()
    expect((await call('/start', { kind: 'project', projectPath: '/no-such-cockpit-project' })).status).toBe(400)
    expect(server!.store.list()).toHaveLength(0)
  })
  it('preserves edited sample bytes on retry and uses the bundled runtime', () => {
    const root = temp()
    const first = prepareSample(root)
    expect(first.text).toContain(process.execPath)
    expect(first.text).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(first.text).toContain('inspect_preview')
    const file = join(first.projectPath, 'server.cjs')
    writeFileSync(file, 'user changes')
    expect(prepareSample(root).projectPath).toBe(first.projectPath)
    expect(readFileSync(file, 'utf8')).toBe('user changes')
    dismissDirector(root); dismissDirector(root)
  })
})
