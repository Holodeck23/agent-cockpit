import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { clearCodexRpcFixtures, registerCodexRpcFixture } from './fixtures/codex-rpc-child.ts'
import { createHash } from 'node:crypto'
import reviewed from './fixtures/codex-reviewed-config.json' with { type: 'json' }
import { codexReviewedThreadConfig } from '../server/agents/codex/startup-review.ts'
import { launchCodex } from '../server/agents/codex/launch.ts'
import type { AgentSession, NormalizedEvent } from '../server/agents/types.ts'
import { createThreadManager } from '../server/threads/manager.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'
import { createImageStore } from '../server/threads/images.ts'

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { spawnCodexRpcFixture } = await import('./fixtures/codex-rpc-child.ts')
  return { ...actual, spawn: (command: string, ...args: any[]) => spawnCodexRpcFixture(command, args[1]?.env) ?? actual.spawn(command, ...args as [any, any]) }
})

const roots: string[] = [], sessions: AgentSession[] = []
vi.mock('../server/agents/codex/startup-preflight.ts', () => ({ codexStartupPreflight: async () => {} }))
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()))
  clearCodexRpcFixtures()
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

function fixture(first: unknown, subsequent: unknown[] = [], holdRead = 0, rejectRead = 0, notifyTurns = false) {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-startup-review-')); roots.push(root)
  const executable = join(root, 'codex'), log = join(root, 'requests.jsonl'), marker = join(root, 'unreviewed-started')
  const responses = [first, ...subsequent].map((value: any) => ({ ...value, layers: value.layers.map((layer: any) => ({
    ...layer, version: layer.version ?? `sha256:${createHash('sha256').update(JSON.stringify(layer.config)).digest('hex')}`,
  })) }))
  let reads = 0, response: any = responses[0], release: (() => void) | undefined
  registerCodexRpcFixture(executable, (r, reply, env) => {
    appendFileSync(log, JSON.stringify(r) + '\n')
    if (r.method === 'initialize') writeFileSync(join(root, 'account.txt'), env?.CODEX_HOME ?? '')
    if (r.method === 'config/read') {
      reads++; response = responses[Math.min(reads - 1, responses.length - 1)]
      if (reads === rejectRead) { reply.fail(r.id, 'private-native-parser-payload'); return }
      if (reads === holdRead) release = () => reply(r.id, response)
      else reply(r.id, response)
      return
    }
    if (r.method === 'thread/start' || r.method === 'thread/resume') {
      for (const name of Object.keys(response.config.mcp_servers || {})) {
        if (name !== 'cockpit' && r.params.config?.mcp_servers?.[name]?.enabled !== false) writeFileSync(marker, name)
      }
      reply.notify('thread/started', { thread: { id: 'reviewed-thread' } })
      reply(r.id, { thread: { id: 'reviewed-thread' } }); return
    }
    if (r.method === 'turn/start' && notifyTurns) reply.notify('turn/started', { threadId: 'reviewed-thread', turn: { id: 'running-turn' } })
    reply(r.id, {})
  })
  return { root, executable, marker, release: () => release?.(), requests: (): any[] => {
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
  await expect.poll(() => ({ started: f.requests().some(r => r.method === 'turn/start'), methods: f.requests().map(r => r.method), events })).toMatchObject({ started: true })
  const requests = f.requests(), threadMethod = resume ? 'thread/resume' : 'thread/start'
  expect(requests.findIndex(r => r.method === 'config/read')).toBeLessThan(requests.findIndex(r => r.method === threadMethod))
  expect(requests.find(r => r.method === threadMethod).params.config).toEqual({ mcp_servers: { unreviewed: { enabled: false }, cockpit: { command: 'bridge' } } })
  expect(existsSync(f.marker)).toBe(false)
  expect(readFileSync(join(f.root, 'account.txt'), 'utf8')).toBe(home)
  expect(requests.filter(r => r.method === 'turn/start')).toHaveLength(1)
  expect(requests.find(r => r.method === 'turn/start').params.input[0].text).toBe('exact first message')
})

it.each([false, true])('refuses a new inherited MCP source discovered on the pre-thread recheck (%s)', async resume => {
  const initial = base(), changed = base()
  changed.config.mcp_servers = { late: { command: 'side-effect' } }
  changed.layers.push({ name: { type: 'project', dotCodexFolder: '/fictional/late/.codex' }, config: { mcp_servers: changed.config.mcp_servers } })
  const f = fixture(initial, [changed]), events: NormalizedEvent[] = []
  const session = launchCodex({ cwd: f.root, ...(resume ? { resume: 'existing' } : {}) }, e => events.push(e), { executable: f.executable })
  sessions.push(session); session.send('recover exact text', 'queued', [{ path: '/fictional/picture.png', mediaType: 'image/png', data: 'unused' }])
  await expect.poll(() => events.some(e => e.kind === 'exit')).toBe(true)
  expect(f.requests().filter(r => r.method === 'config/read')).toHaveLength(2)
  expect(f.requests().some(r => ['thread/start', 'thread/resume', 'turn/start'].includes(r.method))).toBe(false)
  expect(events.some(e => e.kind === 'user_taken')).toBe(false)
  expect(existsSync(f.marker)).toBe(false)
})

it('refuses an inherited command version change while bridge readiness is pending', async () => {
  const initial = base(), changed = base()
  initial.layers.push({ name: { type: 'user', file: '/fictional/config.toml' }, config: { mcp_servers: { inherited: { command: 'old' } } } })
  initial.config.mcp_servers = { inherited: { command: 'old' } }
  Object.assign(changed, structuredClone(initial))
  changed.layers[1].config.mcp_servers.inherited.command = 'new-private-command'
  const f = fixture(initial, [initial, changed]), events: NormalizedEvent[] = []
  let release!: () => void
  const bridge = new Promise<void>(resolve => { release = resolve })
  const session = launchCodex({ cwd: f.root }, e => events.push(e), { executable: f.executable, hostReady: () => bridge })
  sessions.push(session); session.send('held at bridge', 'queued')
  await expect.poll(() => f.requests().some(r => r.method === 'thread/start')).toBe(true)
  release()
  await expect.poll(() => events.some(e => e.kind === 'exit')).toBe(true)
  expect(f.requests().filter(r => r.method === 'config/read')).toHaveLength(3)
  expect(f.requests().some(r => r.method === 'turn/start')).toBe(false)
  expect(events.some(e => e.kind === 'session')).toBe(false)
  expect(JSON.stringify(events)).not.toContain('new-private-command')
})

it('keeps text and images recoverable through a native source refusal in the manager', async () => {
  const initial = base(), changed = base()
  changed.layers[0].version = `sha256:${'1'.repeat(64)}`
  const f = fixture(initial, [changed]), state = join(f.root, 'state'), store = createThreadStore(state)
  const manager = createThreadManager(store, { launchers: { codex: (request, onEvent) => {
    const session = launchCodex({ cwd: request.cwd }, onEvent, { executable: f.executable }); sessions.push(session); return session
  } } })
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3foAAAAASUVORK5CYII=', 'base64')
    const thread = manager.create({ projectPath: f.root, text: 'restore original', images: [{ bytes: png, name: 'draft.png' }], settings: threadSettingsSchema.parse({ agent: 'codex' }) })
    await expect.poll(() => store.events(thread.id).some(({ event }) => event.kind === 'user_undelivered')).toBe(true)
    const persisted = createThreadStore(state).events(thread.id)
    expect(persisted.some(({ event }) => event.kind === 'user_text' && event.text === 'restore original')).toBe(true)
    const attachment = persisted.find(({ event }) => event.kind === 'image')?.event
    expect(attachment?.kind).toBe('image')
    if (attachment?.kind === 'image') expect(createImageStore(state).read(thread.id, attachment.file)?.bytes).toEqual(png)
    expect(f.requests().some(r => r.method === 'turn/start')).toBe(false)
  } finally { await manager.shutdown() }
})

it.each(['withdraw', 'stop', 'close', 'timeout'])('holds input during a native recheck and supports %s', async action => {
  const response = base(), f = fixture(response, [], 2), events: NormalizedEvent[] = []
  const session = launchCodex({ cwd: f.root }, e => events.push(e), {
    executable: f.executable, ...(action === 'timeout' ? { capabilityTimeoutMs: 300 } : {}),
  })
  sessions.push(session); session.send('waiting text', 'queued')
  await expect.poll(() => f.requests().filter(r => r.method === 'config/read').length).toBe(2)
  if (action === 'withdraw') { expect(await session.cancelQueued?.('queued')).toBe(true); f.release() }
  else if (action === 'stop') { session.interrupt(); f.release() }
  else if (action === 'close') { await session.close(); f.release() }
  else await expect.poll(() => events.some(e => e.kind === 'exit')).toBe(true)
  if (action === 'withdraw' || action === 'stop') await expect.poll(() => events.some(e => e.kind === 'session')).toBe(true)
  expect(f.requests().some(r => r.method === 'turn/start')).toBe(false)
  expect(events.some(e => e.kind === 'user_taken')).toBe(false)
  if (action === 'close' || action === 'timeout') expect(f.requests().some(r => r.method === 'thread/start')).toBe(false)
})

it.each(['before-thread', 'later-input'])('refuses a known config-file change at %s without taking pending input', async phase => {
  const source = mkdtempSync(join(tmpdir(), 'cockpit-native-source-')); roots.push(source)
  const file = join(source, 'config.toml'); writeFileSync(file, 'original')
  const response = base()
  response.layers.push({ name: { type: 'user', file }, config: {} })
  const f = fixture(response), events: NormalizedEvent[] = []
  let checks = 0
  const session = launchCodex({ cwd: f.root }, e => events.push(e), { executable: f.executable,
    validateSources: () => { if (++checks === 3 && phase === 'before-thread') writeFileSync(file, 'changed') },
  })
  sessions.push(session)
  if (phase === 'later-input') {
    await expect.poll(() => events.some(e => e.kind === 'session')).toBe(true)
    session.send('initial task', 'initial')
    await expect.poll(() => f.requests().filter(r => r.method === 'turn/start').length).toBe(1)
    writeFileSync(file, 'changed')
  }
  session.send('recover this pending input', 'pending', [{ path: '/fictional/image.png', mediaType: 'image/png', data: 'unused' }])
  await expect.poll(() => events.some(e => e.kind === 'exit')).toBe(true)
  expect(events.some(e => e.kind === 'user_taken' && e.id === 'pending')).toBe(false)
  expect(f.requests().filter(r => r.method === 'turn/start')).toHaveLength(phase === 'later-input' ? 1 : 0)
  if (phase === 'before-thread') expect(f.requests().some(r => r.method === 'thread/start')).toBe(false)
})

it('refuses a failed native recheck without exposing parser payloads', async () => {
  const f = fixture(base(), [], 0, 2), events: NormalizedEvent[] = []
  const session = launchCodex({ cwd: f.root }, e => events.push(e), { executable: f.executable })
  sessions.push(session); session.send('keep my draft', 'queued')
  await expect.poll(() => events.some(e => e.kind === 'exit')).toBe(true)
  expect(JSON.stringify(events)).not.toContain('private-native-parser-payload')
  expect(events.some(e => e.kind === 'error' && e.message.includes('could not be rechecked'))).toBe(true)
  expect(f.requests().some(r => r.method === 'thread/start')).toBe(false)
})

it.each(['idle', 'later', 'steer'])('refuses a newly discovered native source before %s input', async phase => {
  const initial = base(), changed = base()
  changed.layers.push({ name: { type: 'project', dotCodexFolder: '/fictional/new/.codex' }, config: { mcp_servers: { late: { command: 'private-new-command' } } } })
  changed.config.mcp_servers = { late: { command: 'private-new-command' } }
  const history = phase === 'idle' ? [initial, initial, changed] : [initial, initial, initial, changed]
  const f = fixture(initial, history, 0, 0, phase === 'steer'), events: NormalizedEvent[] = []
  const session = launchCodex({ cwd: f.root }, e => events.push(e), { executable: f.executable })
  sessions.push(session)
  await expect.poll(() => events.some(e => e.kind === 'session')).toBe(true)
  if (phase !== 'idle') {
    session.send('first delivered input', 'first')
    await expect.poll(() => f.requests().filter(r => r.method === 'turn/start').length).toBe(1)
  }
  session.send('held after source discovery', 'later')
  await expect.poll(() => events.some(e => e.kind === 'exit')).toBe(true)
  expect(f.requests().filter(r => r.method === 'turn/start')).toHaveLength(phase === 'idle' ? 0 : 1)
  expect(f.requests().some(r => r.method === 'turn/steer')).toBe(false)
  expect(events.some(e => e.kind === 'user_taken' && e.id === 'later')).toBe(false)
  expect(JSON.stringify(events)).not.toContain('private-new-command')
})

it.each(['withdraw', 'stop', 'close', 'timeout', 'revoke'])('keeps idle input pending during revalidation and supports %s', async action => {
  const initial = base(), f = fixture(initial, [], 4), events: NormalizedEvent[] = []
  let revoked = false
  const session = launchCodex({ cwd: f.root }, e => events.push(e), { executable: f.executable,
    capabilityTimeoutMs: action === 'timeout' ? 50 : 5000,
    validateSources: () => { if (revoked) throw new Error('private-revocation') },
  })
  sessions.push(session)
  await expect.poll(() => events.some(e => e.kind === 'session')).toBe(true)
  session.send('exact waiting text', 'waiting', [{ path: '/fictional/image.png', mediaType: 'image/png', data: 'original' }])
  await expect.poll(() => f.requests().filter(r => r.method === 'config/read').length).toBe(4)
  expect(events.some(e => e.kind === 'user_taken')).toBe(false)
  if (action === 'withdraw') { expect(await session.cancelQueued?.('waiting')).toBe(true); f.release() }
  if (action === 'stop') { session.interrupt(); f.release(); expect(events).toContainEqual({ kind: 'user_undelivered', id: 'waiting' }) }
  if (action === 'close') { await session.close(); f.release() }
  if (action === 'timeout') await expect.poll(() => events.some(e => e.kind === 'exit')).toBe(true)
  if (action === 'revoke') { revoked = true; f.release(); await expect.poll(() => events.some(e => e.kind === 'exit')).toBe(true) }
  if (action === 'withdraw' || action === 'stop') {
    session.send('new deliberate input', 'replacement')
    await expect.poll(() => f.requests().filter(r => r.method === 'turn/start').length).toBe(1)
    expect(f.requests().find(r => r.method === 'turn/start').params.input[0].text).toBe('new deliberate input')
  } else expect(f.requests().some(r => r.method === 'turn/start' || r.method === 'turn/steer')).toBe(false)
  expect(events.some(e => e.kind === 'user_taken' && e.id === 'waiting')).toBe(false)
  expect(JSON.stringify(events)).not.toContain('private-revocation')
})

it('gives later input its bounded review budget after the startup deadline has elapsed', async () => {
  const f = fixture(base()), events: NormalizedEvent[] = []
  const session = launchCodex({ cwd: f.root }, e => events.push(e), { executable: f.executable, startupTimeoutMs: 1000 })
  sessions.push(session)
  await expect.poll(() => events.some(e => e.kind === 'session')).toBe(true)
  const clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 61_000)
  try {
    session.send('later idle input', 'later')
    await expect.poll(() => f.requests().some(r => r.method === 'turn/start')).toBe(true)
    expect(events.some(e => e.kind === 'error')).toBe(false)
  } finally { clock.mockRestore() }
})

it('keeps the total startup deadline for the first input review', async () => {
  const f = fixture(base(), [], 4), events: NormalizedEvent[] = []
  let clock: ReturnType<typeof vi.spyOn> | undefined
  const session = launchCodex({ cwd: f.root }, e => {
    events.push(e)
    if (e.kind === 'session') clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 61_000)
  }, { executable: f.executable, startupTimeoutMs: 1000 })
  sessions.push(session)
  try {
    session.send('initial input', 'initial')
    await expect.poll(() => events.some(e => e.kind === 'exit')).toBe(true)
    expect(f.requests().some(r => r.method === 'turn/start')).toBe(false)
  } finally { clock?.mockRestore() }
})

it('persists a later refused idle message with exact images for restart recovery', async () => {
  const initial = base(), changed = base()
  changed.layers.push({ name: { type: 'project', dotCodexFolder: '/fictional/new/.codex' }, config: {} })
  const f = fixture(initial, [initial, initial, initial, changed]), state = join(f.root, 'state'), store = createThreadStore(state)
  let emit!: (event: NormalizedEvent) => void
  const manager = createThreadManager(store, { launchers: { codex: (request, onEvent) => {
    emit = onEvent
    const session = launchCodex({ cwd: request.cwd }, onEvent, { executable: f.executable }); sessions.push(session); return session
  } } })
  try {
    const thread = manager.create({ projectPath: f.root, text: 'initial input', settings: threadSettingsSchema.parse({ agent: 'codex' }) })
    await expect.poll(() => f.requests().filter(r => r.method === 'turn/start').length).toBe(1)
    const firstRun = store.events(thread.id).find(({ event }) => event.kind === 'user_text')!.event
    if (firstRun.kind !== 'user_text') throw new Error('Missing original input')
    emit({ kind: 'result', ok: true })
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3foAAAAASUVORK5CYII=', 'base64')
    manager.send(thread.id, 'later exact input', undefined, undefined, undefined, [{ bytes: png, name: 'later.png' }])
    await expect.poll(() => store.events(thread.id).some(({ event }) => event.kind === 'user_undelivered')).toBe(true)
    const persisted = createThreadStore(state).events(thread.id)
    const message = persisted.find(({ event }) => event.kind === 'user_text' && event.text === 'later exact input')?.event
    expect(message).toMatchObject({ kind: 'user_text', queuedId: expect.any(String) })
    expect(persisted.filter(({ event }) => event.kind === 'result' && event.runId === firstRun.runId).map(({ event }) => event))
      .toEqual([expect.objectContaining({ kind: 'result', ok: true })])
    const attachment = persisted.find(({ event }) => event.kind === 'image')?.event
    expect(attachment?.kind).toBe('image')
    if (attachment?.kind === 'image') expect(createImageStore(state).read(thread.id, attachment.file)?.bytes).toEqual(png)
    expect(f.requests().filter(r => r.method === 'turn/start')).toHaveLength(1)
  } finally { await manager.shutdown() }
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
