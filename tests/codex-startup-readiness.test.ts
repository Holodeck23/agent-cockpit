import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { launchCodex } from '../server/agents/codex/launch.ts'
import type { AgentSession, NormalizedEvent } from '../server/agents/types.ts'
import { createThreadManager, defaultLaunchers } from '../server/threads/manager.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'
import { isBusy } from '../server/threads/status.ts'
import { buildTranscript } from '../web/src/transcript.ts'

const roots: string[] = [], sessions: AgentSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

function deferred() {
  let resolve!: () => void, reject!: (error?: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(answerInitialize = true) {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-codex-readiness-'))
  roots.push(root)
  const executable = join(root, 'codex'), log = join(root, 'requests.jsonl')
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
const { createInterface } = require('node:readline')
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  fs.appendFileSync(${JSON.stringify(log)}, line + '\\n')
  if (request.method === 'initialize' && !${answerInitialize}) return
  if (request.method === 'config/read') { process.stdout.write(JSON.stringify({ id: request.id, result: {"config":{"features":{"hooks":false,"plugins":false,"apps":false,"enable_mcp_apps":false,"skill_mcp_dependency_install":false},"notify":[],"mcp_servers":{}},"layers":[{"name":{"type":"sessionFlags"},"config":{}}]} }) + '\\n'); return }
  if (request.id !== undefined) process.stdout.write(JSON.stringify({ id: request.id, result:
    request.method === 'thread/start' || request.method === 'thread/resume' ? { thread: { id: 'native-thread' } } : {} }) + '\\n')
})
`)
  chmodSync(executable, 0o755)
  const requests = (): Array<{ method: string; params?: any }> => {
    try { return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) }
    catch { return [] }
  }
  const events: NormalizedEvent[] = []
  return { root, executable, requests, events,
    starts: () => requests().filter((request) => request.method === 'turn/start') }
}

it('holds first text/images for the intended bridge and takes the waiting input exactly once', async () => {
  const f = fixture(), bridge = deferred()
  const session = launchCodex({ cwd: f.root }, (event) => f.events.push(event), {
    executable: f.executable, hostReady: () => bridge.promise,
  })
  sessions.push(session)
  session.send('first task', 'waiting', [{ path: join(f.root, 'picture.png'), mediaType: 'image/png', data: 'unused' }])
  await expect.poll(() => f.requests().some((request) => request.method === 'thread/start')).toBe(true)
  expect(f.starts()).toHaveLength(0)
  expect(session.preparing?.()).toBe(true)
  expect(f.events.some((event) => event.kind === 'session')).toBe(false)
  bridge.resolve()
  await expect.poll(() => f.starts().length).toBe(1)
  expect(f.starts()[0]!.params.input).toEqual([{ type: 'localImage', path: join(f.root, 'picture.png') },
    { type: 'text', text: 'first task', text_elements: [] }])
  expect(session.preparing?.()).toBe(false)
  expect(f.events.filter((event) => event.kind === 'user_taken')).toEqual([{ kind: 'user_taken', text: 'first task', id: 'waiting' }])
})

it.each([new Error('private-profile-canary'), undefined, null, false])('refuses a failed bridge without sending input or exposing the raw failure: %s', async (failure) => {
  const f = fixture(), bridge = deferred()
  const session = launchCodex({ cwd: f.root }, (event) => f.events.push(event), { executable: f.executable, hostReady: () => bridge.promise })
  sessions.push(session)
  session.send('must remain unsent', 'waiting')
  await expect.poll(() => f.requests().some((request) => request.method === 'thread/start')).toBe(true)
  bridge.reject(failure)
  await expect.poll(() => f.events.some((event) => event.kind === 'result' && !event.ok)).toBe(true)
  expect(session.alive()).toBe(false)
  expect(f.starts()).toHaveLength(0)
  expect(JSON.stringify(f.events)).toContain('not delivered')
  expect(JSON.stringify(f.events)).not.toContain('private-profile-canary')
  expect(f.events.some((event) => event.kind === 'user_taken')).toBe(false)
})

it('keeps a bridge-failed first message recoverable in the actual thread store', async () => {
  const f = fixture(), bridge = deferred()
  let released = 0
  const store = createThreadStore(join(f.root, 'state'))
  const manager = createThreadManager(store, {
    mcp: () => ({ launch: { command: '/fictional-host-bridge', args: [], secretEnv: {}, ready: () => bridge.promise }, release: () => { released++ } }),
    launchers: { codex: (request, onEvent) => {
    const session = launchCodex({ cwd: request.cwd }, onEvent, { executable: f.executable, hostReady: request.cockpit?.ready })
    sessions.push(session)
    return session
  } } })
  const thread = manager.create({ projectPath: f.root, text: 'recover the exact first message', settings: threadSettingsSchema.parse({ agent: 'codex' }) })
  try {
    await expect.poll(() => f.requests().some((request) => request.method === 'thread/start')).toBe(true)
    bridge.reject(new Error('bridge refused'))
    await expect.poll(() => store.events(thread.id).some(({ event }) => event.kind === 'user_undelivered')).toBe(true)
    const user = store.events(thread.id).find(({ event }) => event.kind === 'user_text')!.event
    expect(user).toMatchObject({ text: 'recover the exact first message', queuedId: expect.any(String) })
    expect(store.events(thread.id).filter(({ event }) => event.kind === 'user_undelivered')).toHaveLength(1)
    expect(manager.canControl(thread.id)).toBe(false)
    expect(f.starts()).toHaveLength(0)
    expect(released).toBe(1)
    expect(store.events(thread.id).filter(({ event }) => event.kind === 'exit')).toHaveLength(1)
    expect(buildTranscript(store.events(thread.id), 'codex').find((item) => item.type === 'message'))
      .toMatchObject({ undelivered: true, restoreText: 'recover the exact first message' })
  } finally { await manager.shutdown() }
})

it('withdraws one waiting message and Stop prevents late authentication from replaying the rest', async () => {
  const f = fixture(), bridge = deferred()
  const session = launchCodex({ cwd: f.root }, (event) => f.events.push(event), { executable: f.executable, hostReady: () => bridge.promise })
  sessions.push(session)
  session.send('withdraw', 'one'); session.send('stop this', 'two')
  await expect.poll(() => f.requests().some((request) => request.method === 'thread/start')).toBe(true)
  expect(await session.cancelQueued?.('one')).toBe(true)
  session.interrupt()
  bridge.resolve()
  await expect.poll(() => session.preparing?.()).toBe(false)
  expect(f.starts()).toHaveLength(0)
  expect(f.events).toContainEqual({ kind: 'user_undelivered', id: 'two' })
  session.send('new deliberate task')
  await expect.poll(() => f.starts().length).toBe(1)
  expect(f.starts()[0]!.params.input).toEqual([{ type: 'text', text: 'new deliberate task', text_elements: [] }])
})

it('closes while authentication is pending and ignores a late success', async () => {
  const f = fixture(), bridge = deferred()
  const session = launchCodex({ cwd: f.root }, (event) => f.events.push(event), { executable: f.executable, hostReady: () => bridge.promise })
  sessions.push(session)
  session.send('never delivered', 'waiting')
  await expect.poll(() => f.requests().some((request) => request.method === 'thread/start')).toBe(true)
  await session.close()
  bridge.resolve()
  expect(session.alive()).toBe(false)
  expect(f.starts()).toHaveLength(0)
  expect(f.events.some((event) => event.kind === 'user_taken')).toBe(false)
})

it('bounds protocol and bridge readiness separately without sending input on timeout', async () => {
  const protocol = fixture(false)
  const first = launchCodex({ cwd: protocol.root }, (event) => protocol.events.push(event), {
    executable: protocol.executable, initializeTimeoutMs: 50,
  })
  sessions.push(first); first.send('no protocol')
  await expect.poll(() => protocol.events.some((event) => event.kind === 'result')).toBe(true)
  expect(first.alive()).toBe(false)
  expect(protocol.starts()).toHaveLength(0)
  await first.close()
  const f = fixture(), bridge = deferred()
  const second = launchCodex({ cwd: f.root }, (event) => f.events.push(event), {
    executable: f.executable, hostReady: () => bridge.promise, capabilityTimeoutMs: 200,
  })
  sessions.push(second); second.send('no bridge')
  await expect.poll(() => f.events.some((event) => event.kind === 'result'), { timeout: 5000 }).toBe(true)
  bridge.resolve()
  expect(second.alive()).toBe(false)
  expect(f.starts()).toHaveLength(0)
})

it('revalidates sources after the bridge wait and refuses changed sources before input', async () => {
  const f = fixture(), bridge = deferred()
  let changed = false
  const session = launchCodex({ cwd: f.root }, (event) => f.events.push(event), {
    executable: f.executable, hostReady: () => bridge.promise,
    validateSources: () => { if (changed) throw new Error('private-source-path') },
  })
  sessions.push(session); session.send('keep source revision', 'waiting')
  await expect.poll(() => f.requests().some((request) => request.method === 'thread/start')).toBe(true)
  changed = true; bridge.resolve()
  await expect.poll(() => f.events.some((event) => event.kind === 'result')).toBe(true)
  expect(f.starts()).toHaveLength(0)
  expect(session.alive()).toBe(false)
  expect(JSON.stringify(f.events)).not.toContain('private-source-path')
})

it('wires authenticated readiness through the production default Codex launcher', async () => {
  const f = fixture(), bridge = deferred()
  vi.stubEnv('PATH', `${f.root}:${process.env.PATH}`)
  const session = defaultLaunchers.codex({ cwd: f.root, settings: threadSettingsSchema.parse({ agent: 'codex' }),
    cockpit: { command: '/fictional-reviewed-bridge', args: [], secretEnv: {}, ready: () => bridge.promise } },
  (event) => f.events.push(event))
  sessions.push(session); session.send('default production path', 'waiting')
  await expect.poll(() => f.requests().some((request) => request.method === 'thread/start')).toBe(true)
  expect(f.starts()).toHaveLength(0)
  bridge.resolve()
  await expect.poll(() => f.starts().length).toBe(1)
  expect(f.starts()[0]!.params.input[0].text).toBe('default production path')
})

it('settles the manager waiting set when Stop withdraws input before bridge authentication', async () => {
  const f = fixture(), bridge = deferred()
  const store = createThreadStore(join(f.root, 'state'))
  const manager = createThreadManager(store, { launchers: { codex: (request, onEvent) => {
    const session = launchCodex({ cwd: request.cwd }, onEvent, { executable: f.executable, hostReady: () => bridge.promise })
    sessions.push(session)
    return session
  } } })
  const thread = manager.create({ projectPath: f.root, text: 'stopped before delivery', settings: threadSettingsSchema.parse({ agent: 'codex' }) })
  try {
    await expect.poll(() => f.requests().some((request) => request.method === 'thread/start')).toBe(true)
    manager.interrupt(thread.id)
    bridge.resolve()
    await expect.poll(() => sessions.at(-1)!.preparing?.()).toBe(false)
    expect(store.events(thread.id).filter(({ event }) => event.kind === 'user_undelivered')).toHaveLength(1)
    expect(manager.canControl(thread.id)).toBe(false)
    expect(f.starts()).toHaveLength(0)
    expect(buildTranscript(store.events(thread.id), 'codex').find((item) => item.type === 'message'))
      .toMatchObject({ undelivered: true, restoreText: 'stopped before delivery' })
  } finally { await manager.shutdown() }
})

it('caps a pending bridge by the total launch budget even when its capability budget is longer', async () => {
  const f = fixture(), bridge = deferred()
  let waitingForBridge = false
  const session = launchCodex({ cwd: f.root }, (event) => f.events.push(event), {
    executable: f.executable, startupTimeoutMs: 3000,
    hostReady: () => { waitingForBridge = true; return bridge.promise },
  })
  sessions.push(session); session.send('total launch budget')
  await expect.poll(() => waitingForBridge).toBe(true)
  await expect.poll(() => f.events.some((event) => event.kind === 'result'), { timeout: 5000 }).toBe(true)
  bridge.resolve()
  expect(session.alive()).toBe(false)
  expect(f.starts()).toHaveLength(0)
})

it('returns the only waiting message to its draft and clears the displayed working state', async () => {
  const f = fixture(), bridge = deferred()
  const store = createThreadStore(join(f.root, 'state'))
  const manager = createThreadManager(store, { launchers: { codex: (request, onEvent) => {
    const session = launchCodex({ cwd: request.cwd }, onEvent, { executable: f.executable, hostReady: () => bridge.promise })
    sessions.push(session)
    return session
  } } })
  const thread = manager.create({ projectPath: f.root, text: 'withdraw this exact draft', settings: threadSettingsSchema.parse({ agent: 'codex' }) })
  try {
    await expect.poll(() => f.requests().some((request) => request.method === 'thread/start')).toBe(true)
    const user = store.events(thread.id).find(({ event }) => event.kind === 'user_text')!.event
    assertQueued(user)
    expect(await manager.unqueue(thread.id, user.queuedId)).toEqual({ text: 'withdraw this exact draft', images: [] })
    expect(manager.canControl(thread.id)).toBe(false)
    expect(isBusy(manager.status(thread.id))).toBe(false)
    bridge.resolve()
    await expect.poll(() => sessions.at(-1)!.preparing?.()).toBe(false)
    expect(f.starts()).toHaveLength(0)
  } finally { await manager.shutdown() }
})

function assertQueued(event: NormalizedEvent): asserts event is Extract<NormalizedEvent, { kind: 'user_text' }> & { queuedId: string } {
  expect(event).toMatchObject({ kind: 'user_text', queuedId: expect.any(String) })
}
