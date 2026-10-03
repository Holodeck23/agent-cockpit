import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSession, EventSink } from '../server/agents/types.ts'
import { createThreadManager, type LaunchRequest, type Launcher } from '../server/threads/manager.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { openApprovals } from '../server/threads/status.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'

interface FakeAgent {
  readonly requests: LaunchRequest[]
  emit: EventSink
  readonly approvals: Array<{ requestId: string; behavior: string; input: unknown }>
}

function fakeLauncher(): { launcher: Launcher; agent: FakeAgent } {
  const agent: FakeAgent = { requests: [], emit: () => undefined, approvals: [] }
  const launcher: Launcher = (request, onEvent) => {
    agent.requests.push(request)
    agent.emit = onEvent
    let alive = true
    const session: AgentSession = {
      agent: 'claude',
      send: () => {},
      respondApproval: ({ requestId, input }, behavior) => {
        agent.approvals.push({ requestId, behavior, input })
        onEvent({ kind: 'approval_resolved', requestId, behavior })
      },
      interrupt: () => undefined,
      close: () => {
        alive = false
        onEvent({ kind: 'exit', code: 0 })
        return Promise.resolve()
      },
      alive: () => alive,
    }
    return session
  }
  return { launcher, agent }
}

function setup() {
  const store = createThreadStore(mkdtempSync(join(tmpdir(), 'cockpit-test-')))
  const { launcher, agent } = fakeLauncher()
  const manager = createThreadManager(store, { launchers: { claude: launcher, codex: launcher } })
  const settings = threadSettingsSchema.parse({})
  return { store, manager, agent, settings }
}

describe('thread manager', () => {
  it('starts a new session with --session-id, then resumes after the process exits', () => {
    const { manager, agent, settings } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'hello' })
    expect(agent.requests[0]).toMatchObject({ sessionId: meta.sessionId })
    agent.emit({ kind: 'session', sessionId: meta.sessionId })
    agent.emit({ kind: 'result', ok: true })
    agent.emit({ kind: 'exit', code: 0 })
    manager.send(meta.id, 'again')
    expect(agent.requests[1]).toMatchObject({ resume: meta.sessionId })
  })

  it('walks the statuses working → needs_input → working → done', () => {
    const { store, manager, agent, settings } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'write a file' })
    expect(manager.status(meta.id)).toBe('working')
    const input = { file_path: '/tmp/a.txt', content: 'hi' }
    agent.emit({ kind: 'approval_request', requestId: 'r1', toolName: 'Write', input, suggestions: [] })
    expect(manager.status(meta.id)).toBe('needs_input')
    manager.approve(meta.id, openApprovals(store.events(meta.id))[0]!, 'allow')
    // The original tool input must be echoed back, never replaced.
    expect(agent.approvals).toEqual([{ requestId: 'r1', behavior: 'allow', input }])
    expect(manager.status(meta.id)).toBe('working')
    agent.emit({ kind: 'result', ok: true })
    expect(manager.status(meta.id)).toBe('done')
  })

  it('keeps the message being streamed for viewers who open the thread mid-turn', () => {
    const { manager, agent, settings } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'hi' })
    agent.emit({ kind: 'text_delta', text: 'Hel' })
    agent.emit({ kind: 'text_delta', text: 'lo, wor' })
    expect(manager.partialText(meta.id)).toBe('Hello, wor')
    agent.emit({ kind: 'assistant_text', messageId: 'm1', text: 'Hello, world' })
    expect(manager.partialText(meta.id)).toBe('')
    agent.emit({ kind: 'text_delta', text: 'More' })
    agent.emit({ kind: 'result', ok: true })
    expect(manager.partialText(meta.id)).toBe('')
  })

  it('persists deltas only as the final text, and survives a new manager (restart)', () => {
    const { store, manager, agent, settings } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'hi' })
    agent.emit({ kind: 'text_delta', text: 'he' })
    agent.emit({ kind: 'assistant_text', messageId: 'm1', text: 'hello' })
    agent.emit({ kind: 'result', ok: true })
    const restarted = createThreadManager(store, { launchers: { claude: fakeLauncher().launcher, codex: fakeLauncher().launcher } })
    const [summary] = restarted.summaries()
    expect(summary).toMatchObject({ status: 'done', preview: 'hello' })
    expect(store.events(meta.id).some((e) => e.event.kind === 'text_delta')).toBe(false)
  })

  it('treats a failed result after Stop as stopped, not an error', () => {
    const { manager, agent, settings } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'long job' })
    manager.interrupt(meta.id)
    agent.emit({ kind: 'result', ok: false })
    expect(manager.status(meta.id)).toBe('idle')
  })

  it('broadcasts every event with the current status', () => {
    const { manager, agent, settings } = setup()
    const seen: string[] = []
    manager.subscribe((u) => seen.push(`${u.event.kind}:${u.status}`))
    manager.create({ projectPath: '/tmp', settings, text: 'x' })
    agent.emit({ kind: 'result', ok: true })
    expect(seen).toContain('user_text:working')
    expect(seen).toContain('result:done')
  })
})

describe('deleting a conversation', () => {
  it('closes a working session, removes its files, ignores late events and tells listeners', async () => {
    const { store, manager, agent, settings } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'long job' })
    const dir = store.transcriptPath(meta.id).replace(/\/messages\.md$/, '')
    expect(existsSync(dir)).toBe(true)
    const seen: string[] = []
    manager.subscribe((u) => seen.push(`${u.threadId}:${u.event.kind}`))
    await manager.remove(meta.id)
    expect(existsSync(dir)).toBe(false)
    expect(store.get(meta.id)).toBeUndefined()
    expect(manager.summaries().map((s) => s.meta.id)).not.toContain(meta.id)
    // The fake session's close emitted an exit; it must not have recreated the folder.
    agent.emit({ kind: 'assistant_text', messageId: 'late', text: 'too late' })
    expect(existsSync(dir)).toBe(false)
    expect(seen).toEqual([`${meta.id}:thread_deleted`])
    expect(() => manager.send(meta.id, 'again')).toThrow('This conversation was deleted')
    await expect(manager.remove('0'.repeat(32))).rejects.toThrow()
  })
})

describe('switching agents', () => {
  it('starts a fresh codex session seeded with the transcript so far', () => {
    const { manager, agent, settings } = setup()
    const meta = manager.create({ projectPath: '/tmp/p', settings, text: 'make a.txt' })
    agent.emit({ kind: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/tmp/p/a.txt' } })
    agent.emit({ kind: 'assistant_text', messageId: 'm1', text: 'Created a.txt' })
    agent.emit({ kind: 'result', ok: true })
    const switched = manager.switchAgent(meta.id, { ...settings, agent: 'codex' })
    expect(switched.sessionId).not.toBe(meta.sessionId)
    manager.send(meta.id, 'what was done?')
    const request = agent.requests.at(-1)
    expect(request?.resume).toBeUndefined()
    expect(request?.seed).toContain('Created a.txt')
    expect(request?.seed).toContain('Write: /tmp/p/a.txt')
  })

  it('refuses to switch mid-turn', () => {
    const { manager, settings } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'busy' })
    expect(() => manager.switchAgent(meta.id, { ...settings, agent: 'codex' })).toThrow(/Stop the current turn/)
  })

  it('adopts the id the agent reports for its session', () => {
    const { store, manager, agent, settings } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'x' })
    agent.emit({ kind: 'session', sessionId: 'codex-thread-1' })
    expect(store.get(meta.id)?.sessionId).toBe('codex-thread-1')
  })

  it('attaches a cockpit MCP per session with guidance, and revokes it when the session exits', () => {
    const store = createThreadStore(mkdtempSync(join(tmpdir(), 'cockpit-test-')))
    const { launcher, agent } = fakeLauncher()
    const grants: Array<{ threadId: string; projectPath: string }> = []
    let released = 0
    const manager = createThreadManager(store, {
      launchers: { claude: launcher, codex: launcher },
      mcp: (grant) => {
        grants.push(grant)
        return {
          launch: { command: 'node', args: ['mcp.cjs'], secretEnv: { COCKPIT_MCP_TOKEN: `t${grants.length}` } },
          release: () => void released++,
        }
      },
    })
    const meta = manager.create({ projectPath: '/tmp', settings: threadSettingsSchema.parse({}), text: 'hi' })
    expect(grants).toEqual([{ threadId: meta.id, projectPath: '/tmp' }])
    expect(agent.requests[0]?.cockpit?.secretEnv).toEqual({ COCKPIT_MCP_TOKEN: 't1' })
    agent.emit({ kind: 'result', ok: true })
    agent.emit({ kind: 'exit', code: 0 })
    expect(released).toBe(1)
    manager.send(meta.id, 'again')
    expect(agent.requests[1]?.cockpit?.secretEnv).toEqual({ COCKPIT_MCP_TOKEN: 't2' })
  })
})


describe('session lifecycle regressions', () => {
  it('ignores late callbacks and waits for both closing and replacement sessions on shutdown', async () => {
    const store = createThreadStore(mkdtempSync(join(tmpdir(), 'cockpit-race-')))
    const sessions: Array<{ emit: EventSink; finish: () => void; closeCalls: number }> = []
    const launcher: Launcher = (_request, emit) => {
      let alive = true
      let finish!: () => void
      const closed = new Promise<void>((resolve) => { finish = () => { alive = false; emit({ kind: 'exit', code: 0 }); resolve() } })
      const control = { emit, finish, closeCalls: 0 }
      sessions.push(control)
      return {
        agent: 'claude', alive: () => alive, send: () => {},
        respondApproval: () => undefined, interrupt: () => undefined,
        close: () => { control.closeCalls++; return closed },
      }
    }
    const manager = createThreadManager(store, { launchers: { claude: launcher, codex: launcher } })
    const settings = threadSettingsSchema.parse({})
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'first' })
    const old = sessions[0]!
    old.emit({ kind: 'result', ok: true })
    manager.switchAgent(meta.id, { ...settings, agent: 'codex' })
    manager.send(meta.id, 'continue')
    const replacement = sessions[1]!
    replacement.emit({ kind: 'session', sessionId: 'replacement' })
    replacement.emit({ kind: 'text_delta', text: 'new text' })
    old.emit({ kind: 'session', sessionId: 'old' })
    old.emit({ kind: 'result', ok: false })
    old.emit({ kind: 'text_delta', text: 'old text' })
    expect(manager.status(meta.id)).toBe('working')
    expect(manager.partialText(meta.id)).toBe('new text')
    expect(store.get(meta.id)?.sessionId).toBe('replacement')
    let shutdownDone = false
    const shutdown = manager.shutdown().then(() => { shutdownDone = true })
    expect(replacement.closeCalls).toBe(1)
    replacement.finish()
    await Promise.resolve()
    expect(shutdownDone).toBe(false)
    old.finish()
    await shutdown
    expect(old.closeCalls).toBe(1)
  })

  it('keeps a replacement tracked after the old process exits', async () => {
    const { manager, agent, settings } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'first' })
    const oldEmit = agent.emit
    oldEmit({ kind: 'result', ok: true })
    manager.switchAgent(meta.id, { ...settings, agent: 'codex' })
    manager.send(meta.id, 'next')
    oldEmit({ kind: 'exit', code: 0 })
    expect(manager.status(meta.id)).toBe('working')
    await manager.shutdown()
    expect(manager.status(meta.id)).toBe('idle')
  })

  it('expires old approvals and translates reused wire ids to fresh public ids', async () => {
    const { store, manager, agent, settings } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'first' })
    const request = { kind: 'approval_request' as const, requestId: '1', toolName: 'Shell', input: { command: 'first' }, suggestions: [] }
    agent.emit(request)
    const oldId = openApprovals(store.events(meta.id))[0]!
    agent.emit({ kind: 'exit', code: 0 })
    manager.send(meta.id, 'next')
    expect(manager.status(meta.id)).toBe('working')
    expect(() => manager.approve(meta.id, oldId, 'allow')).toThrow(/expired/)
    agent.emit({ ...request, input: { command: 'second' } })
    const nextId = openApprovals(store.events(meta.id))[0]!
    expect(nextId).not.toBe(oldId)
    manager.approve(meta.id, nextId, 'allow')
    expect(agent.approvals).toEqual([{ requestId: '1', behavior: 'allow', input: { command: 'second' } }])
    expect(() => manager.approve(meta.id, nextId, 'allow')).toThrow(/expired/)
    agent.emit({ kind: 'exit', code: 0 })
    manager.send(meta.id, 'third')
    agent.emit(request)
    expect(openApprovals(store.events(meta.id))).toHaveLength(1)
    expect(manager.status(meta.id)).toBe('needs_input')
    agent.emit({ kind: 'result', ok: false, stopped: true })
    manager.send(meta.id, 'fourth')
    expect(openApprovals(store.events(meta.id))).toEqual([])
    expect(manager.status(meta.id)).toBe('working')
    await manager.shutdown()
  })

  it('clears pre-restart approvals even when no exit was recorded', async () => {
    const { store, manager, agent, settings } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'first' })
    agent.emit({ kind: 'approval_request', requestId: 'old', toolName: 'Write', input: {}, suggestions: [] })
    const launcher = fakeLauncher().launcher
    const restarted = createThreadManager(store, { launchers: { claude: launcher, codex: launcher } })
    restarted.send(meta.id, 'after restart')
    expect(restarted.status(meta.id)).toBe('working')
    expect(openApprovals(store.events(meta.id))).toEqual([])
    await restarted.shutdown()
    await manager.shutdown()
  })

  it('broadcasts completion, reopening, and automatic reopening on a new message', async () => {
    const { store, manager, settings } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'first' })
    const seen: boolean[] = []
    manager.subscribe(({ event }) => { if (event.kind === 'completion_changed') seen.push(event.completed) })
    manager.setCompleted(meta.id, true)
    expect(store.get(meta.id)?.completed).toBe(true)
    manager.setCompleted(meta.id, false)
    manager.setCompleted(meta.id, true)
    manager.send(meta.id, 'reopen')
    expect(seen).toEqual([true, false, true, false])
    expect(manager.summaries()[0]?.meta.completed).toBe(false)
    await manager.shutdown()
  })

  it("notes a branch change in the project's other conversations, without counting it as activity", async () => {
    const { store, manager, settings } = setup()
    const here = manager.create({ projectPath: '/tmp', settings, text: 'switch it' })
    const other = manager.create({ projectPath: '/tmp', settings, text: 'other work' })
    const elsewhere = manager.create({ projectPath: '/elsewhere', settings, text: 'unrelated' })
    const before = manager.summaries().find((s) => s.meta.id === other.id)!.lastActivityAt
    manager.noteBranchChange('/tmp', 'main', 'feature', here.id)
    const kinds = (id: string) => store.events(id).map((e) => e.event.kind)
    expect(kinds(other.id)).toContain('branch_changed')
    expect(store.events(other.id).at(-1)?.event).toEqual({ kind: 'branch_changed', from: 'main', to: 'feature', byTitle: 'switch it' })
    expect(kinds(here.id)).not.toContain('branch_changed')
    expect(kinds(elsewhere.id)).not.toContain('branch_changed')
    expect(manager.summaries().find((s) => s.meta.id === other.id)!.lastActivityAt).toBe(before)
    await manager.shutdown()
  })

  it('changing settings for the same agent keeps its session and notes the change; another agent is refused', async () => {
    const { store, manager, agent, settings } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'first' })
    agent.emit({ kind: 'result', ok: true })
    const before = store.get(meta.id)!
    const next = manager.changeSettings(meta.id, { ...settings, effort: 'high', model: 'opus' })
    expect(next.settings).toMatchObject({ effort: 'high', model: 'opus' })
    expect(next.sessionId).toBe(before.sessionId)
    expect(next.sessionStarted).toBe(before.sessionStarted)
    expect(store.events(meta.id).map((e) => e.event.kind)).not.toContain('agent_switch')
    expect(store.events(meta.id).at(-1)?.event).toEqual({ kind: 'settings_changed', model: 'opus', effort: 'high', permissionMode: settings.permissionMode })
    expect(() => manager.changeSettings(meta.id, { ...settings, agent: 'codex' })).toThrow(/Switch agents/)
    await manager.shutdown()
  })

  it('dismisses an open question; dismissing with nothing open is refused', async () => {
    const { manager, agent, settings } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'deploy?' })
    expect(() => manager.dismissAwaiting(meta.id)).toThrow(/Nothing is waiting/)
    agent.emit({ kind: 'assistant_text', messageId: 'm1', text: 'Question: Staging or production?' })
    agent.emit({ kind: 'result', ok: true })
    expect(manager.summaries()[0]?.awaiting).toBe('question')
    manager.dismissAwaiting(meta.id)
    expect(manager.summaries()[0]?.awaiting).toBeUndefined()
    await manager.shutdown()
  })
})


describe('failed startup recovery', () => {
  it('clears transient state, preserves handoff, retries fresh, then resumes only the provider id', async () => {
    const { store, manager, agent, settings } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'first' })
    agent.emit({ kind: 'result', ok: true })
    manager.switchAgent(meta.id, { ...settings, agent: 'codex' })
    const handoff = store.get(meta.id)!.handoff
    manager.send(meta.id, 'start')
    agent.emit({ kind: 'text_delta', text: 'partial' })
    agent.emit({ kind: 'approval_request', requestId: 'r', toolName: 'Shell', input: {}, suggestions: [] })
    agent.emit({ kind: 'error', message: 'Could not start' })
    agent.emit({ kind: 'result', ok: false })
    agent.emit({ kind: 'exit', code: null })
    expect(manager.status(meta.id)).toBe('error')
    expect(manager.partialText(meta.id)).toBe('')
    expect(openApprovals(store.events(meta.id))).toEqual([])
    expect(store.get(meta.id)).toMatchObject({ sessionStarted: false, handoff })
    manager.send(meta.id, 'retry')
    expect(agent.requests.at(-1)).toMatchObject({ seed: handoff, sessionId: store.get(meta.id)!.sessionId })
    expect(agent.requests.at(-1)?.resume).toBeUndefined()
    agent.emit({ kind: 'session', sessionId: 'real-provider-id' })
    expect(store.get(meta.id)).toMatchObject({ sessionStarted: true, sessionId: 'real-provider-id' })
    expect(store.get(meta.id)?.handoff).toBeUndefined()
    agent.emit({ kind: 'result', ok: true })
    agent.emit({ kind: 'exit', code: 0 })
    manager.send(meta.id, 'resume')
    expect(agent.requests.at(-1)?.resume).toBe('real-provider-id')
    await manager.shutdown()
  })

  it('keeps protocol errors nonfatal but terminalizes a dead process without a result', async () => {
    const { store, manager, agent, settings } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'first' })
    agent.emit({ kind: 'session', sessionId: 'real' })
    agent.emit({ kind: 'error', message: 'Unparseable output' })
    expect(manager.status(meta.id)).toBe('working')
    agent.emit({ kind: 'exit', code: 1 })
    agent.emit({ kind: 'exit', code: 1 })
    expect(manager.status(meta.id)).toBe('error')
    expect(store.events(meta.id).filter((e) => e.event.kind === 'result')).toHaveLength(1)
    expect(store.get(meta.id)?.sessionStarted).toBe(true)
    await manager.shutdown()
  })

  it('handles startup failure emitted during launcher construction', async () => {
    const store = createThreadStore(mkdtempSync(join(tmpdir(), 'cockpit-sync-start-')))
    const launcher: Launcher = (_request, emit) => {
      emit({ kind: 'error', message: 'startup failed' })
      emit({ kind: 'result', ok: false })
      emit({ kind: 'exit', code: null })
      return { agent: 'claude', alive: () => false, send() {}, respondApproval() {}, interrupt() {}, close: async () => {} }
    }
    const manager = createThreadManager(store, { launchers: { claude: launcher } })
    const meta = manager.create({ projectPath: '/tmp', settings: threadSettingsSchema.parse({}), text: 'first' })
    await Promise.resolve()
    expect(manager.status(meta.id)).toBe('error')
    expect(store.get(meta.id)?.sessionStarted).toBe(false)
    await manager.shutdown()
  })
})
