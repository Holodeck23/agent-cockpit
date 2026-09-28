import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSession, EventSink } from '../server/agents/types.ts'
import { createThreadManager, type LaunchRequest, type Launcher } from '../server/threads/manager.ts'
import { createThreadStore } from '../server/threads/store.ts'
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
      send: (text) => onEvent({ kind: 'user_text', text }),
      respondApproval: ({ requestId, input }, behavior) => {
        agent.approvals.push({ requestId, behavior, input })
        onEvent({ kind: 'approval_resolved', requestId, behavior })
      },
      interrupt: () => undefined,
      close: () => {
        alive = false
        onEvent({ kind: 'exit', code: 0 })
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
  const manager = createThreadManager(store, { claude: launcher, codex: launcher })
  const settings = threadSettingsSchema.parse({})
  return { store, manager, agent, settings }
}

describe('thread manager', () => {
  it('starts a new session with --session-id, then resumes after the process exits', () => {
    const { manager, agent, settings } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'hello' })
    expect(agent.requests[0]).toMatchObject({ sessionId: meta.sessionId })
    agent.emit({ kind: 'result', ok: true })
    agent.emit({ kind: 'exit', code: 0 })
    manager.send(meta.id, 'again')
    expect(agent.requests[1]).toMatchObject({ resume: meta.sessionId })
  })

  it('walks the statuses working → needs_input → working → done', () => {
    const { manager, agent, settings } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'write a file' })
    expect(manager.status(meta.id)).toBe('working')
    const input = { file_path: '/tmp/a.txt', content: 'hi' }
    agent.emit({ kind: 'approval_request', requestId: 'r1', toolName: 'Write', input, suggestions: [] })
    expect(manager.status(meta.id)).toBe('needs_input')
    manager.approve(meta.id, 'r1', 'allow')
    // The original tool input must be echoed back, never replaced.
    expect(agent.approvals).toEqual([{ requestId: 'r1', behavior: 'allow', input }])
    expect(manager.status(meta.id)).toBe('working')
    agent.emit({ kind: 'result', ok: true })
    expect(manager.status(meta.id)).toBe('done')
  })

  it('persists deltas only as the final text, and survives a new manager (restart)', () => {
    const { store, manager, agent, settings } = setup()
    const meta = manager.create({ projectPath: '/tmp', settings, text: 'hi' })
    agent.emit({ kind: 'text_delta', text: 'he' })
    agent.emit({ kind: 'assistant_text', messageId: 'm1', text: 'hello' })
    agent.emit({ kind: 'result', ok: true })
    const restarted = createThreadManager(store, { claude: fakeLauncher().launcher, codex: fakeLauncher().launcher })
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
})
