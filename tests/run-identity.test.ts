import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSession, EventSink, NormalizedEvent } from '../server/agents/types.ts'
import { legacyBindingId, runsOf } from '../server/threads/identity.ts'
import { createThreadManager, OperationConflictError, type LaunchRequest, type Launcher } from '../server/threads/manager.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'

interface Fake { emit: EventSink; requests: LaunchRequest[]; sent: string[] }

function fakes(): { launcher: Launcher; sessions: Fake[] } {
  const sessions: Fake[] = []
  const launcher: Launcher = (request, emit) => {
    const fake: Fake = { emit, requests: [request], sent: [] }
    sessions.push(fake)
    let alive = true
    const session: AgentSession = {
      agent: 'claude',
      send: (text) => { fake.sent.push(text) },
      queues: () => true,
      cancelQueued: () => Promise.resolve(true),
      respondApproval: () => undefined,
      interrupt: () => undefined,
      close: () => { alive = false; emit({ kind: 'exit', code: 0 }); return Promise.resolve() },
      alive: () => alive,
    }
    return session
  }
  return { launcher, sessions }
}

const settings = threadSettingsSchema.parse({})
function setup(root = mkdtempSync(join(tmpdir(), 'cockpit-runs-'))) {
  const store = createThreadStore(root)
  const { launcher, sessions } = fakes()
  const manager = createThreadManager(store, { launchers: { claude: launcher, codex: launcher }, workspaceFor: () => 'ws-primary' })
  return { root, store, manager, sessions }
}
const kinds = (events: ReadonlyArray<{ event: NormalizedEvent }>) => events.map((e) => e.event)

describe('binding and run identity', () => {
  it('a new conversation records its workspace, binding and generation; each send opens a run its result closes', () => {
    const { store, manager, sessions } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'first' })
    const stored = store.get(meta.id)!
    expect(stored).toMatchObject({ workspaceId: 'ws-primary', sessionGeneration: 1 })
    expect(stored.bindingId).toMatch(/^[0-9a-f-]{36}$/)
    const boundary = kinds(store.events(meta.id)).find((e) => e.kind === 'session_boundary')
    expect(boundary).toEqual({ kind: 'session_boundary', generation: 1, bindingId: stored.bindingId, workspaceId: 'ws-primary' })
    sessions[0]!.emit({ kind: 'result', ok: true })
    const [run] = runsOf(meta.id, store.events(meta.id))
    expect(run).toMatchObject({ ended: true, outcome: 'ok' })
    expect(kinds(store.events(meta.id)).find((e) => e.kind === 'result')).toEqual({ kind: 'result', ok: true, runId: run!.runId })
  })

  it('switching agents mints a new binding; legacy threads get a stable derived one', () => {
    const { store, manager, sessions } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'first' })
    sessions[0]!.emit({ kind: 'result', ok: true })
    const before = store.get(meta.id)!.bindingId
    const switched = manager.switchAgent(meta.id, { ...settings, agent: 'codex' })
    expect(switched.bindingId).not.toBe(before)
    const legacy = { ...switched, bindingId: undefined }
    expect(legacyBindingId(legacy)).toBe(legacyBindingId(legacy))
    expect(legacyBindingId(legacy)).not.toBe(legacyBindingId({ ...legacy, sessionId: 'other' }))
  })
})

describe('ID-03 queue snapshots', () => {
  it('a queued message keeps the binding it was queued under; binding changes refuse while it waits', async () => {
    const { store, manager } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'first' })
    manager.send(meta.id, 'queued while working')
    const queued = kinds(store.events(meta.id)).find((e) => e.kind === 'user_text' && e.queuedId)
    const bindingId = store.get(meta.id)!.bindingId
    expect(queued).toMatchObject({ binding: { bindingId, workspaceId: 'ws-primary', agent: 'claude', generation: 1 } })
    expect(() => manager.switchAgent(meta.id, { ...settings, agent: 'codex' })).toThrow(/Stop the current turn/)
    expect(() => manager.changeSettings(meta.id, { ...settings, permissionMode: 'plan' })).toThrow(/Stop the current turn/)
    const back = await manager.unqueue(meta.id, (queued as { queuedId: string }).queuedId)
    expect(back.text).toBe('queued while working')
    expect(store.get(meta.id)!.bindingId).toBe(bindingId)
  })
})

describe('ID-04 late events from a replaced process', () => {
  it('cannot touch the replacement, and are recorded once as labelled stale events', () => {
    const { store, manager, sessions } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'first' })
    const old = sessions[0]!
    old.emit({ kind: 'result', ok: true })
    manager.switchAgent(meta.id, { ...settings, agent: 'codex' })
    manager.send(meta.id, 'continue')
    sessions[1]!.emit({ kind: 'session', sessionId: 'replacement' })
    old.emit({ kind: 'session', sessionId: 'late-old' })
    old.emit({ kind: 'result', ok: false })
    old.emit({ kind: 'text_delta', text: 'ignored entirely' })
    old.emit({ kind: 'approval_request', requestId: 'r1', toolName: 'Shell', input: {}, suggestions: [] })
    expect(store.get(meta.id)!.sessionId).toBe('replacement')
    expect(store.get(meta.id)!.sessionGeneration).toBe(2)
    expect(manager.status(meta.id)).toBe('working')
    const stale = kinds(store.events(meta.id)).filter((e) => e.kind === 'stale_event')
    expect(stale).toEqual([
      { kind: 'stale_event', generation: 1, eventKind: 'session' },
      { kind: 'stale_event', generation: 1, eventKind: 'result' },
      { kind: 'stale_event', generation: 1, eventKind: 'approval_request' },
    ])
  })
})

describe('ID-05 operation IDs', () => {
  it('a repeated operation has one effect; the same ID with different input is refused', () => {
    const { store, manager, sessions } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'first' })
    sessions[0]!.emit({ kind: 'result', ok: true })
    const op = '7b0f6c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f'
    const first = manager.send(meta.id, 'do it once', undefined, undefined, undefined, [], op)
    const again = manager.send(meta.id, 'do it once', undefined, undefined, undefined, [], op)
    expect(again).toEqual({ runId: first.runId, replayed: true })
    expect(sessions[0]!.sent.filter((t) => t === 'do it once')).toHaveLength(1)
    expect(() => manager.send(meta.id, 'something else', undefined, undefined, undefined, [], op)).toThrow(OperationConflictError)
    expect(kinds(store.events(meta.id)).filter((e) => e.kind === 'user_text')).toHaveLength(2)
  })

  it('remembers operations across a restart', () => {
    const { root, manager, sessions } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'first' })
    sessions[0]!.emit({ kind: 'result', ok: true })
    const op = '8c1f6c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f'
    const first = manager.send(meta.id, 'once', undefined, undefined, undefined, [], op)
    const restarted = setup(root)
    expect(restarted.manager.send(meta.id, 'once', undefined, undefined, undefined, [], op)).toEqual({ runId: first.runId, replayed: true })
    expect(restarted.sessions).toHaveLength(0)
  })
})

describe('ID-07 recovery after a crash', () => {
  it('marks a run left unfinished as interrupted, once, without relaunching anything', () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-crash-'))
    const id = '11111111-2222-4333-8444-555555555555'
    mkdirSync(join(root, 'threads', id), { recursive: true })
    writeFileSync(join(root, 'threads', id, 'meta.json'), JSON.stringify({ id, title: 'Crashed', projectPath: '/tmp', settings, sessionId: 's1',
      sessionStarted: true, completed: false, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }))
    writeFileSync(join(root, 'threads', id, 'events.jsonl'), [
      { ts: '2026-09-01T00:00:01.000Z', event: { kind: 'session_boundary' } },
      { ts: '2026-09-01T00:00:02.000Z', event: { kind: 'user_text', text: 'write the file' } },
      { ts: '2026-09-01T00:00:03.000Z', event: { kind: 'tool_use', id: 't1', name: 'Write', input: {} } },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n')
    const { store, manager, sessions } = setup(root)
    expect(manager.recoverInterrupted()).toEqual([id])
    expect(manager.recoverInterrupted()).toEqual([])
    const [run] = runsOf(id, store.events(id))
    expect(run).toMatchObject({ ended: true, outcome: 'interrupted' })
    expect(kinds(store.events(id)).at(-1)).toEqual({ kind: 'result', ok: false, interrupted: true, runId: run!.runId })
    expect(manager.status(id)).toBe('idle')
    expect(sessions).toHaveLength(0)
  })
})
