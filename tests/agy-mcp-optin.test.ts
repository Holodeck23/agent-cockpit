import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PLUGIN_DIR } from '../server/agents/antigravity/mcp-plugin.ts'
import type { AgentCapabilities } from '../server/agents/capabilities/types.ts'
import type { NormalizedEvent } from '../server/agents/types.ts'
import { createAgyMcp } from '../server/projects/agy-mcp.ts'
import { createProjectStore } from '../server/projects/store.ts'
import { startServer, type RunningServer } from '../server/start.ts'
import { antigravityLauncher } from '../server/threads/manager.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'

const COMMAND = { command: '/Applications/Cockpit.app/Contents/MacOS/Cockpit', args: ['mcp.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } }
const SECRET = { COCKPIT_MCP_URL: 'http://127.0.0.1:4111', COCKPIT_MCP_TOKEN: 'secret-marker-7f3a' }

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-agy-optin-'))
  const folder = mkdtempSync(join(tmpdir(), 'cockpit-agy-project-'))
  const projects = createProjectStore(root)
  projects.open(folder)
  return { projects, folder, agyMcp: createAgyMcp(projects, COMMAND) }
}

describe('Antigravity tools opt-in (P3, W10-04)', () => {
  it('connects and disconnects one project, recording only what Cockpit wrote', () => {
    const { projects, folder, agyMcp } = setup()
    expect(agyMcp.prepare(folder)).toEqual({ ready: false })
    const on = agyMcp.setConnected(folder, true)
    expect(on).toMatchObject({ ok: true, project: { antigravityMcp: { created: ['.agents', '.agents/plugins'] } } })
    expect(agyMcp.prepare(folder)).toEqual({ ready: true })
    expect(readFileSync(join(folder, PLUGIN_DIR, 'mcp_config.json'), 'utf8')).not.toContain(SECRET.COCKPIT_MCP_TOKEN)
    expect(agyMcp.setConnected(folder, false)).toMatchObject({ ok: true })
    expect(projects.list()[0]?.antigravityMcp).toBeUndefined()
    expect(existsSync(join(folder, '.agents'))).toBe(false)
  })

  it('is unavailable without the app’s tool server, and refuses an unknown folder', () => {
    const { projects, folder } = setup()
    expect(createAgyMcp(projects, undefined).setConnected(folder, true)).toMatchObject({ ok: false, code: 'unavailable' })
    expect(createAgyMcp(projects, COMMAND).setConnected('/not/a/project', true)).toMatchObject({ ok: false, code: 'unknown_project' })
  })
})

// The launcher hands agy the token and Cockpit's guidance only where the project opted in.
function fakeAgy(dir: string): string {
  const exe = join(dir, 'agy')
  writeFileSync(exe, `#!/bin/sh
echo "token=\${COCKPIT_MCP_TOKEN:-absent}" > "${join(dir, 'env')}"
while IFS= read -r line; do
  printf '%s\\n' "$line" >> "${join(dir, 'stdin')}"
  printf '{"event":"result","result":{"conversation_id":"c","status":"SUCCESS","response":"ok"}}\\n'
done
`)
  chmodSync(exe, 0o755)
  return exe
}
const found = (exe: string): AgentCapabilities => ({ agent: 'antigravity', context: 'default', settings: {}, auth: { state: 'signed_in' }, models: { state: 'not_checked' },
  executable: { state: 'found', identity: { command: 'agy', path: exe, realpath: exe, fingerprint: 'f', version: '1.3.0' } } })

async function launch(ready: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-agy-env-'))
  const exe = fakeAgy(dir)
  const events: NormalizedEvent[] = []
  const session = antigravityLauncher(async () => found(exe), () => ({ ready }))({
    cwd: dir, settings: threadSettingsSchema.parse({ agent: 'antigravity' }), sessionId: '055a398f-db14-4c5f-abbb-1bf03f8120a7',
    cockpit: { ...COMMAND, secretEnv: SECRET },
  }, (e) => events.push(e))
  session.send('hello')
  await expect.poll(() => events.some((e) => e.kind === 'result'), { timeout: 10_000 }).toBe(true)
  await session.close()
  return { env: readFileSync(join(dir, 'env'), 'utf8'), stdin: readFileSync(join(dir, 'stdin'), 'utf8') }
}

describe('Antigravity launch with and without the opt-in (P3)', () => {
  it('opted in: the token is in agy’s environment and the guidance names the tools', async () => {
    const { env, stdin } = await launch(true)
    expect(env.trim()).toBe(`token=${SECRET.COCKPIT_MCP_TOKEN}`)
    expect(stdin).toContain('start_process')
  })

  it('not opted in: no token and no guidance about tools agy does not have', async () => {
    const { env, stdin } = await launch(false)
    expect(env.trim()).toBe('token=absent')
    expect(stdin).not.toContain('start_process')
  })
})

describe('route (desktop only)', () => {
  let running: RunningServer | undefined
  afterEach(async () => { await running?.close(); running = undefined })

  it('connects through POST /api/projects/agy-mcp and maps a refusal to 409', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'cockpit-agy-route-'))
    running = await startServer({ port: 0, webDist: folder, stateRoot: mkdtempSync(join(tmpdir(), 'cockpit-state-')), mcp: COMMAND,
      agentProbe: async () => ({ installed: false, problem: 'fixture' }) })
    const post = (path: string, body: unknown) => fetch(`${running!.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect((await post('/api/projects', { path: folder })).status).toBe(200)
    const on = await post('/api/projects/agy-mcp', { path: folder, connected: true })
    expect(on.status).toBe(200)
    expect((await on.json()).data.project.antigravityMcp).toBeDefined()
    writeFileSync(join(folder, PLUGIN_DIR, 'mcp_config.json'), 'broken')
    expect((await post('/api/projects/agy-mcp', { path: folder, connected: true })).status).toBe(409)
    expect(readFileSync(join(folder, PLUGIN_DIR, 'mcp_config.json'), 'utf8')).toBe('broken')
  })
})
