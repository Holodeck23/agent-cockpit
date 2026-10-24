import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { codexStartupPreflight } from '../server/agents/codex/startup-preflight.ts'
import { launchCodex } from '../server/agents/codex/launch.ts'
import { createAppServerQueryScope, queryAppServer } from '../server/agents/codex/app-server-query.ts'
import { createThreadManager } from '../server/threads/manager.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'
import { createImageStore } from '../server/threads/images.ts'
import type { NormalizedEvent } from '../server/agents/types.ts'
import reviewedConfig from './fixtures/codex-reviewed-config.json' with { type: 'json' }

const state = vi.hoisted(() => ({ file: '', code: '', preferences: 'false', status: 0, error: false, hold: false, holdClose: false,
  releases: [] as Array<() => void>, closes: [] as Array<() => void> }))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, lstatSync: vi.fn((path, ...args) => {
    if (['/etc/codex/managed_config.toml', '/etc/codex/requirements.toml'].includes(String(path))) {
      if (state.code) throw Object.assign(new Error('private-policy-payload'), { code: state.code })
      if (state.file === path) return {} // Refusal depends on presence, never contents/type.
      throw Object.assign(new Error('absent'), { code: 'ENOENT' })
    }
    return (actual.lstatSync as any)(path, ...args)
  }) }
})
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn), execFile: vi.fn((_path, _args, options, callback) => {
    const child = new EventEmitter()
    let done = false
    const finish = (aborted = false) => {
      if (done) return
      done = true
      callback(aborted || state.error || state.status !== 0 ? new Error('private-policy-payload') : null, state.preferences, '')
      const close = () => child.emit('close')
      if (state.holdClose) state.closes.push(close)
      else queueMicrotask(close)
    }
    options.signal?.addEventListener('abort', () => finish(true), { once: true })
    if (state.hold) state.releases.push(() => finish())
    else queueMicrotask(() => finish())
    return child
  }) }
})
beforeEach(() => {
  Object.assign(state, { file: '', code: '', preferences: 'false', status: 0, error: false, hold: false, holdClose: false, releases: [], closes: [] })
  vi.clearAllMocks()
})

it('accepts absent local policy without changing the selected account environment', async () => {
  const env = Object.freeze({ CODEX_HOME: '/selected/account', HOME: '/real/home' })
  await expect(codexStartupPreflight(env)).resolves.toBeUndefined()
  expect(env).toEqual({ CODEX_HOME: '/selected/account', HOME: '/real/home' })
})

it.each(['/etc/codex/managed_config.toml', '/etc/codex/requirements.toml'])('refuses local managed file presence, including links/directories, without reading it: %s', async path => {
  state.file = path
  await expect(codexStartupPreflight({})).rejects.toThrow('managed Codex setup')
})

it.each(['EACCES', 'EPERM', 'EIO', 'ELOOP', 'ENOTDIR'])('does not treat filesystem failure as absence: %s', async code => {
  state.code = code
  await expect(codexStartupPreflight({})).rejects.toThrow('startup sources could not be checked')
  try { await codexStartupPreflight({}) } catch (error) { expect(String(error)).not.toContain('private-policy-payload') }
})

it.skipIf(process.platform !== 'darwin')('refuses forced preferences through the CoreFoundation probe', async () => {
  state.preferences = 'true'
  await expect(codexStartupPreflight({})).rejects.toThrow('managed Codex setup')
})

it.skipIf(process.platform !== 'darwin').each(['', 'false\nprivate-policy-payload', 'null', '0'])('refuses unknown managed-preference probe output (%#)', async output => {
  state.preferences = output
  await expect(codexStartupPreflight({})).rejects.toThrow('startup sources could not be checked')
})

it.skipIf(process.platform !== 'darwin').each(['exit', 'timeout'])('refuses failed preference checks: %s', async mode => {
  state.status = mode === 'exit' ? 1 : 0; state.error = mode === 'timeout'
  await expect(codexStartupPreflight({})).rejects.toThrow('startup sources could not be checked')
})

it.each(['CODEX_APP_SERVER_MANAGED_CONFIG_PATH', 'CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG', 'CODEX_APP_SERVER_TEST_USER_CONFIG_FILE'])('refuses unsupported runtime-loader switches even when empty: %s', async name => {
  await expect(codexStartupPreflight({ [name]: '' })).rejects.toThrow('startup sources could not be checked')
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-preflight-')), executable = join(root, 'codex'), marker = join(root, 'spawned')
  writeFileSync(executable, `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unreviewed-startup-effect')
setInterval(() => {}, 1000)
`)
  chmodSync(executable, 0o755)
  return { root, executable, marker }
}

it.each([false, true])('refuses before new/resumed app-server startup and reports a recoverable failure (%s)', async resume => {
  state.file = '/etc/codex/managed_config.toml'
  const f = fixture(), events: NormalizedEvent[] = []
  const session = launchCodex({ cwd: f.root, ...(resume ? { resume: 'saved' } : {}) }, event => events.push(event), { executable: f.executable })
  session.send('preserve exact input', 'queued')
  expect(session.preparing?.()).toBe(true)
  await expect.poll(() => events.some(event => event.kind === 'exit')).toBe(true)
    expect(events.map(event => event.kind)).toEqual(['error', 'result', 'exit'])
    expect(session.alive()).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
    expect(existsSync(f.marker)).toBe(false)
    await session.close()
})

it.each(['account/read', 'model/list'])('refuses before helper startup: %s', async method => {
  state.file = '/etc/codex/requirements.toml'
  const f = fixture()
  expect(await queryAppServer(f.executable, method, {}, { timeoutMs: 5000 })).toEqual({ error: expect.stringContaining('managed Codex setup') })
  expect(spawn).not.toHaveBeenCalled()
  expect(existsSync(f.marker)).toBe(false)
})

it('rechecks selected sources before any provider process starts', async () => {
  const f = fixture(), events: NormalizedEvent[] = []
  const session = launchCodex({ cwd: f.root }, event => events.push(event), { executable: f.executable,
    validateSources: () => { throw new Error('Reviewed setup changed') } })
  await expect.poll(() => events.some(event => event.kind === 'exit')).toBe(true)
  expect(events).toContainEqual({ kind: 'error', message: 'Codex setup changed before startup; review Project Settings. Your message was not delivered.' })
  expect(spawn).not.toHaveBeenCalled()
  await session.close()
})

it.skipIf(process.platform !== 'darwin').each(['Stop', 'Quit'])('cancels a pending local check and fences late native startup on %s', async action => {
  state.hold = true
  const f = fixture(), events: NormalizedEvent[] = []
  const session = launchCodex({ cwd: f.root }, event => events.push(event), { executable: f.executable })
  session.send('queued original', 'first')
  session.send('withdrawn original', 'withdrawn')
  expect(await session.cancelQueued?.('withdrawn')).toBe(true)
  await expect.poll(() => state.releases.length).toBe(1)
  if (action === 'Stop') {
    session.interrupt()
    expect(events).toContainEqual({ kind: 'user_undelivered', id: 'first' })
    expect(events).not.toContainEqual({ kind: 'user_undelivered', id: 'withdrawn' })
    expect(events).toContainEqual({ kind: 'result', ok: false, stopped: true })
  }
  await session.close()
  state.releases[0]!()
  expect(spawn).not.toHaveBeenCalled()
  expect(session.alive()).toBe(false)
  expect(existsSync(f.marker)).toBe(false)
})

it.skipIf(process.platform !== 'darwin')('Quit owns a pending helper check and prevents a late helper spawn', async () => {
  state.hold = true; state.holdClose = true
  const f = fixture(), scope = createAppServerQueryScope()
  const pending = scope.query(f.executable, 'account/read', {}, { timeoutMs: 5000 })
  await expect.poll(() => state.releases.length).toBe(1)
  let closed = false
  const closing = scope.close().then(() => { closed = true })
  await Promise.resolve()
  expect(closed).toBe(false)
  expect(state.closes).toHaveLength(1)
  state.closes[0]!()
  await closing
  expect(await pending).toEqual({ error: 'Cockpit is shutting down' })
  state.releases[0]!()
  expect(spawn).not.toHaveBeenCalled()
  expect(existsSync(f.marker)).toBe(false)
})

it.skipIf(process.platform !== 'darwin')('keeps queued text/images and withdrawal exact across successful preflight', async () => {
  state.hold = true
  const f = fixture(), log = join(f.root, 'input.json'), events: NormalizedEvent[] = []
  writeFileSync(f.executable, `#!/usr/bin/env node
const fs = require('node:fs')
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
 const r = JSON.parse(line); if (r.id === undefined) return
 if (r.method === 'turn/start') fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(r.params.input))
 const result = r.method === 'config/read' ? ${JSON.stringify(reviewedConfig)} : r.method === 'thread/start' ? { thread: { id: 'preflight-thread' } } : {}
 process.stdout.write(JSON.stringify({ id: r.id, result }) + '\\n')
})
`)
  const session = launchCodex({ cwd: f.root }, e => events.push(e), { executable: f.executable })
  try {
    const image = { path: join(f.root, 'exact.png'), mediaType: 'image/png', data: 'unused' }
    session.send('exact task', 'kept', [image]); session.send('withdraw task', 'withdrawn')
    await expect.poll(() => state.releases.length).toBe(1)
    expect(await session.cancelQueued?.('withdrawn')).toBe(true)
    expect(spawn).not.toHaveBeenCalled()
    state.releases[0]!()
    await expect.poll(() => existsSync(log)).toBe(true)
    expect(JSON.parse(readFileSync(log, 'utf8'))).toEqual([{ type: 'localImage', path: image.path }, { type: 'text', text: 'exact task', text_elements: [] }])
    expect(events.filter(e => e.kind === 'user_taken')).toEqual([{ kind: 'user_taken', id: 'kept', text: 'exact task' }])
  } finally { await session.close() }
})

it.skipIf(process.platform !== 'darwin')('refuses a selected source changed while the local check was pending', async () => {
  state.hold = true
  const f = fixture(), events: NormalizedEvent[] = []
  let changed = false
  const session = launchCodex({ cwd: f.root }, e => events.push(e), { executable: f.executable,
    validateSources: () => { if (changed) throw new Error('private-source-canary') } })
  try {
    await expect.poll(() => state.releases.length).toBe(1)
    changed = true; state.releases[0]!()
    await expect.poll(() => session.alive()).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
    expect(events.some(e => e.kind === 'error' && e.message.includes('setup changed'))).toBe(true)
    expect(JSON.stringify(events)).not.toContain('private-source-canary')
  } finally { await session.close() }
})

it.skipIf(process.platform !== 'darwin')('detects a local policy added while the preference query was pending', async () => {
  state.hold = true
  const f = fixture(), events: NormalizedEvent[] = []
  const session = launchCodex({ cwd: f.root }, e => events.push(e), { executable: f.executable })
  try {
    await expect.poll(() => state.releases.length).toBe(1)
    state.file = '/etc/codex/managed_config.toml'
    state.releases[0]!()
    await expect.poll(() => session.alive()).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
    expect(events.some(e => e.kind === 'error' && e.message.includes('managed Codex setup'))).toBe(true)
  } finally { await session.close() }
})

it.skipIf(process.platform !== 'darwin')('counts the pending source check against the helper timeout', async () => {
  state.hold = true
  const f = fixture()
  const time = vi.spyOn(performance, 'now').mockReturnValue(0)
  try {
    const pending = queryAppServer(f.executable, 'model/list', {}, { timeoutMs: 1 })
    expect(state.releases).toHaveLength(1)
    time.mockReturnValue(2)
    state.releases[0]!()
    expect(await pending).toEqual({ error: 'Codex startup sources could not be checked in time' })
    expect(spawn).not.toHaveBeenCalled()
  } finally { time.mockRestore() }
})

it('persists refused first text and image for draft recovery without starting native code', async () => {
  state.file = '/etc/codex/requirements.toml'
  const f = fixture(), store = createThreadStore(join(f.root, 'state'))
  const manager = createThreadManager(store, { launchers: { codex: (request, onEvent) =>
    launchCodex({ cwd: request.cwd }, onEvent, { executable: f.executable }) } })
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3foAAAAASUVORK5CYII=', 'base64')
    const thread = manager.create({ projectPath: f.root, text: 'recover exact task', images: [{ bytes: png, name: 'draft.png' }], settings: threadSettingsSchema.parse({ agent: 'codex' }) })
    await expect.poll(() => store.events(thread.id).some(({ event }) => event.kind === 'user_undelivered')).toBe(true)
    expect(store.events(thread.id).some(({ event }) => event.kind === 'user_text' && event.text === 'recover exact task')).toBe(true)
    const attachment = store.events(thread.id).find(({ event }) => event.kind === 'image')?.event
    expect(attachment?.kind).toBe('image')
    if (attachment?.kind === 'image') expect(createImageStore(join(f.root, 'state')).read(thread.id, attachment.file)?.bytes).toEqual(png)
    expect(spawn).not.toHaveBeenCalled()
    expect(existsSync(f.marker)).toBe(false)
    expect(JSON.stringify(store.events(thread.id))).not.toContain('private-policy-payload')
  } finally { await manager.shutdown() }
})
