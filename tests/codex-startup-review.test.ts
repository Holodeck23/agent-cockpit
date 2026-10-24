import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import reviewed from './fixtures/codex-reviewed-config.json' with { type: 'json' }
import { codexReviewedThreadConfig } from '../server/agents/codex/startup-review.ts'
import { launchCodex } from '../server/agents/codex/launch.ts'
import type { AgentSession, NormalizedEvent } from '../server/agents/types.ts'
import { createThreadManager } from '../server/threads/manager.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'

const roots: string[] = [], sessions: AgentSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const base = (): any => structuredClone(reviewed)

it('disables every inherited name as a literal JSON key and preserves only the host bridge', () => {
  const response = base()
  response.config.mcp_servers = JSON.parse('{"cockpit":{"command":"bridge"},"server.with.dots":{"command":"unreviewed"},"__proto__":{"url":"https://example.invalid"}}')
  response.layers[0].config = { mcp_servers: { cockpit: { command: 'bridge' } } }
  response.layers.push({ name: { type: 'user', file: '/fixture/config.toml' }, config: { mcp_servers: { 'server.with.dots': {} } } })
  expect(codexReviewedThreadConfig(response, true)).toEqual({ mcp_servers: JSON.parse('{"cockpit":{"command":"bridge"},"server.with.dots":{"enabled":false},"__proto__":{"enabled":false}}') })
  expect({}).not.toHaveProperty('enabled')
  expect(response.config.mcp_servers['server.with.dots']).toEqual({ command: 'unreviewed' })
})

it('retains raw host flags without round-tripping normalized null defaults', () => {
  const response = base()
  response.config.mcp_servers = { cockpit: { command: 'bridge', tool_timeout_sec: null, url: null } }
  response.layers[0].config = { mcp_servers: { cockpit: { command: 'bridge', args: ['stdio'] } } }
  expect(codexReviewedThreadConfig(response, true)).toEqual({ mcp_servers: { cockpit: { command: 'bridge', args: ['stdio'] } } })
})

it.each(['mdm', 'enterpriseManaged', 'legacyManagedConfigTomlFromFile', 'legacyManagedConfigTomlFromMdm'])('refuses unsupported managed provenance without exposing its content: %s', type => {
  const response = base()
  response.layers.push({ name: { type, file: '/private-source-canary.toml' }, config: {} })
  expect(() => codexReviewedThreadConfig(response, false)).toThrow('managed Codex setup')
  try { codexReviewedThreadConfig(response, false) } catch (error) { expect(String(error)).not.toContain('private-source-canary') }
})

it.each(['hooks', 'plugins', 'apps', 'enable_mcp_apps', 'skill_mcp_dependency_install'])('refuses an executable control overridden back on: %s', name => {
  const response = base(); response.config.features[name] = true
  expect(() => codexReviewedThreadConfig(response, false)).toThrow('not delivered')
})

it.each([
  (r: any) => { delete r.layers },
  (r: any) => { r.layers = [] },
  (r: any) => { r.layers.push(r.layers[0]) },
  (r: any) => { r.layers.push({ name: { type: 'future-source' }, config: {} }) },
  (r: any) => { r.layers.push({ name: { type: 'user', file: 'relative.toml' }, config: {} }) },
  (r: any) => { r.config.notify = ['private-command-canary'] },
  (r: any) => { r.config.mcp_servers = [] },
  (r: any) => { r.config.mcpServers = {} },
  (r: any) => { r.config.mcp_servers = { unreviewed: null } },
  (r: any) => { r.config.mcp_servers = { cockpit: { command: 'inherited' } } },
])('refuses absent, ambiguous or unsupported native review data (%#)', mutate => {
  const response = base(); mutate(response)
  expect(() => codexReviewedThreadConfig(response, false)).toThrow('not delivered')
})

it('refuses an inherited contribution to the reserved bridge even when the host supplies a command', () => {
  const response = base()
  response.config.mcp_servers = { cockpit: { command: 'bridge', env: { UNREVIEWED: 'value' } } }
  response.layers.push({ name: { type: 'project', dotCodexFolder: '/fixture/.codex' }, config: { mcp_servers: { cockpit: { env: { UNREVIEWED: 'value' } } } } })
  expect(() => codexReviewedThreadConfig(response, true)).toThrow('not delivered')
})

function fixture(response: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-startup-review-')); roots.push(root)
  const executable = join(root, 'codex'), log = join(root, 'requests.jsonl'), marker = join(root, 'unreviewed-started')
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
const response = ${JSON.stringify(response)}
const send = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n')
fs.writeFileSync(${JSON.stringify(join(root, 'account.txt'))}, process.env.CODEX_HOME || '')
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
 const r = JSON.parse(line); fs.appendFileSync(${JSON.stringify(log)}, line + '\\n')
 if (r.method === 'config/read') { send(r.id, response); return }
 if (r.method === 'thread/start' || r.method === 'thread/resume') {
  for (const name of Object.keys(response.config.mcp_servers || {})) {
   if (name !== 'cockpit' && r.params.config?.mcp_servers?.[name]?.enabled !== false) fs.writeFileSync(${JSON.stringify(marker)}, name)
  }
  send(r.id, { thread: { id: 'reviewed-thread' } }); return
 }
 if (r.id !== undefined) send(r.id, {})
})
`)
  chmodSync(executable, 0o755)
  return { root, executable, marker, requests: (): any[] => {
    try { return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch { return [] }
  } }
}

it.each([false, true])('reviews before new/resumed thread creation and prevents inherited fixture effects (%s)', async resume => {
  const response = base(); response.config.mcp_servers = { unreviewed: { command: 'side-effect' }, cockpit: { command: 'bridge' } }
  response.layers[0].config = { mcp_servers: { cockpit: { command: 'bridge' } } }
  const f = fixture(response), events: NormalizedEvent[] = [], home = join(f.root, 'selected-profile')
  const session = launchCodex({ cwd: f.root, ...(resume ? { resume: 'existing-thread' } : {}) }, e => events.push(e), {
    executable: f.executable, env: { CODEX_HOME: home }, configArgs: ['-c', 'mcp_servers.cockpit.command="bridge"'],
  }); sessions.push(session); session.send('exact first message', 'queued')
  await expect.poll(() => f.requests().some(r => r.method === 'turn/start')).toBe(true)
  const requests = f.requests(), threadMethod = resume ? 'thread/resume' : 'thread/start'
  expect(requests.findIndex(r => r.method === 'config/read')).toBeLessThan(requests.findIndex(r => r.method === threadMethod))
  expect(requests.find(r => r.method === threadMethod).params.config).toEqual({ mcp_servers: { unreviewed: { enabled: false }, cockpit: { command: 'bridge' } } })
  expect(existsSync(f.marker)).toBe(false)
  expect(readFileSync(join(f.root, 'account.txt'), 'utf8')).toBe(home)
  expect(requests.filter(r => r.method === 'turn/start')).toHaveLength(1)
  expect(requests.find(r => r.method === 'turn/start').params.input[0].text).toBe('exact first message')
})

it('refuses unsupported setup before any native thread and keeps the first message recoverable in the store', async () => {
  const response = base(); response.layers.push({ name: { type: 'enterpriseManaged', id: 'private-id' }, config: {} })
  const f = fixture(response), store = createThreadStore(join(f.root, 'state'))
  const manager = createThreadManager(store, { launchers: { codex: (request, onEvent) => {
    const session = launchCodex({ cwd: request.cwd }, onEvent, { executable: f.executable })
    sessions.push(session); return session
  } } })
  try {
    const thread = manager.create({ projectPath: f.root, text: 'restore my original task', settings: threadSettingsSchema.parse({ agent: 'codex' }) })
    await expect.poll(() => store.events(thread.id).some(({ event }) => event.kind === 'user_undelivered')).toBe(true)
    expect(f.requests().some(r => ['thread/start', 'thread/resume', 'turn/start'].includes(r.method))).toBe(false)
    expect(JSON.stringify(store.events(thread.id))).not.toContain('private-id')
    expect(store.events(thread.id).some(({ event }) => event.kind === 'user_text' && event.text === 'restore my original task')).toBe(true)
  } finally { await manager.shutdown() }
})
