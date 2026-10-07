import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSession, EventSink, NormalizedEvent } from '../server/agents/types.ts'
import type { Workspace } from '../server/projects/workspaces.ts'
import { ChooseWorkspaceError, createThreadManager, WorkspaceUnavailableError, type LaunchRequest, type Launcher } from '../server/threads/manager.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'

// Order 17b (W12-07): one conversation, one transcript, and a native session per workspace. Moving
// keeps the old workspace's session; returning resumes it with only what happened elsewhere since.
// A workspace that is not the project's, or is gone, is refused and never replaced by the primary.

interface Launch { readonly request: LaunchRequest; readonly emit: EventSink; readonly sent: string[]; alive: boolean }

const PROJECT = randomUUID()
const workspace = (kind: Workspace['kind'], cwd: string, extra: Partial<Workspace> = {}): Workspace => ({
  id: randomUUID(), projectId: PROJECT, kind, cwd, canonicalCwd: cwd, gitCommonDir: '/proj/.git', managed: kind === 'worktree',
  lifecycle: 'active', revision: 1, createdAt: new Date().toISOString(), ...extra,
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-workspace-binding-'))
  const store = createThreadStore(join(root, 'threads'))
  const primary = workspace('primary', '/proj')
  const spike = workspace('worktree', '/proj-worktree-abc123', { name: 'Spike', branch: 'codex/spike' })
  const foreign = workspace('worktree', '/other-worktree', { projectId: randomUUID() })
  const registry = new Map([primary, spike, foreign].map((w) => [w.id, w]))
  const launches: Launch[] = []
  const launcher: Launcher = (request, onEvent) => {
    const launch: Launch = { request, emit: onEvent, sent: [], alive: true }
    launches.push(launch)
    const session: AgentSession = {
      agent: request.settings.agent, send: (text) => { launch.sent.push(text) }, respondApproval: () => undefined, interrupt: () => undefined,
      close: () => { if (launch.alive) { launch.alive = false; onEvent({ kind: 'exit', code: 0 }) } return Promise.resolve() },
      alive: () => launch.alive,
    }
    return session
  }
  const manager = createThreadManager(store, {
    launchers: { claude: launcher, codex: launcher },
    workspace: (id) => registry.get(id),
    workspaceFor: (path) => (path === '/proj' ? primary.id : undefined),
  })
  const settings = threadSettingsSchema.parse({})
  return { store, manager, launches, settings, primary, spike, foreign, registry }
}

/** One finished turn on the latest launch: provider evidence makes the session resumable. */
async function finishTurn(launch: Launch, sessionId: string, reply: string): Promise<void> {
  await Promise.resolve()
  launch.emit({ kind: 'session', sessionId })
  launch.emit({ kind: 'assistant_text', messageId: randomUUID(), text: reply })
  launch.emit({ kind: 'result', ok: true })
}

const kinds = (events: readonly { event: NormalizedEvent }[], kind: NormalizedEvent['kind']) => events.filter((e) => e.event.kind === kind).map((e) => e.event)

describe('a native session per workspace (W12-07)', () => {
  it('primary → worktree → primary → worktree: own sessions, one transcript, context sent once', async () => {
    const { store, manager, launches, settings, primary, spike } = setup()
    const meta = manager.create({ projectPath: '/proj', settings, text: 'Plan the watering reminder' })
    expect(launches[0]!.request.cwd).toBe('/proj')
    await finishTurn(launches[0]!, 'native-primary', 'Here is a plan for the reminder.')

    // Into the worktree: a new native session there, told the conversation so far and where it is.
    manager.send(meta.id, 'Try it in the spike', undefined, undefined, undefined, undefined, undefined, spike.id)
    const inSpike = launches[1]!
    expect(inSpike.request.cwd).toBe('/proj-worktree-abc123')
    expect(inSpike.request.resume).toBeUndefined()
    expect(inSpike.request.seed).toContain('Plan the watering reminder')
    expect(inSpike.request.seed).toContain('You work in /proj-worktree-abc123')
    expect(inSpike.sent).toEqual(['Try it in the spike'])
    await finishTurn(inSpike, 'native-spike', 'Built it on codex/spike.')

    // Back to the primary: its own session resumes and hears only what happened in the spike.
    manager.send(meta.id, 'Now in the main checkout', undefined, undefined, undefined, undefined, undefined, primary.id)
    const back = launches[2]!
    expect(back.request.cwd).toBe('/proj')
    expect(back.request.resume).toBe('native-primary')
    expect(back.request.seed).toBeUndefined()
    const told = back.sent[0]!
    expect(told).toContain('While you were idle, this conversation continued in another workspace')
    expect(told).toContain('Built it on codex/spike.')
    expect(told).not.toContain('Plan the watering reminder')
    expect(told.endsWith('Now in the main checkout')).toBe(true)
    await finishTurn(back, 'native-primary', 'Noted.')

    // A second message in the same workspace carries no context again.
    manager.send(meta.id, 'And one more', undefined, undefined, undefined, undefined, undefined, primary.id)
    expect(back.sent[1]).toBe('And one more')
    await finishTurn(back, 'native-primary', 'Done.')

    // And to the spike again: its own session, with what the primary said since.
    manager.send(meta.id, 'Back to the spike', undefined, undefined, undefined, undefined, undefined, spike.id)
    const again = launches[3]!
    expect(again.request).toMatchObject({ cwd: '/proj-worktree-abc123', resume: 'native-spike' })
    expect(again.sent[0]).toContain('And one more')
    expect(again.sent[0]).not.toContain('Built it on codex/spike.')

    const events = store.events(meta.id)
    expect(kinds(events, 'workspace_changed')).toEqual([
      expect.objectContaining({ from: primary.id, to: spike.id, fromLabel: 'the main checkout', toLabel: 'Spike (codex/spike)', context: 'handoff' }),
      expect.objectContaining({ from: spike.id, to: primary.id, context: 'resumed' }),
      expect.objectContaining({ from: primary.id, to: spike.id, context: 'resumed' }),
    ])
    expect(kinds(events, 'session_boundary').map((e) => e.kind === 'session_boundary' && e.workspaceId)).toEqual([primary.id, spike.id, primary.id, spike.id])
    expect(kinds(events, 'user_text')).toHaveLength(5)
    expect(store.get(meta.id)).toMatchObject({ workspaceId: spike.id, sessionId: 'native-spike', bindings: { [primary.id]: expect.objectContaining({ sessionId: 'native-primary', sessionStarted: true }) } })
  })

  it('once it has run in two workspaces, a request must say which; nothing is recorded otherwise', async () => {
    const { store, manager, launches, settings, spike } = setup()
    const meta = manager.create({ projectPath: '/proj', settings, text: 'first' })
    await finishTurn(launches[0]!, 'n1', 'ok')
    manager.send(meta.id, 'there', undefined, undefined, undefined, undefined, undefined, spike.id)
    await finishTurn(launches[1]!, 'n2', 'ok')
    const before = store.events(meta.id).length
    expect(() => manager.send(meta.id, 'where?')).toThrow(ChooseWorkspaceError)
    expect(store.events(meta.id)).toHaveLength(before)
  })

  // Moving while working is no longer refused: since order 18 (W12-15) it starts a second agent in
  // the other workspace; tests/concurrent-workspaces.test.ts covers that.
  it('refuses another project\'s workspace and a removed one', async () => {
    const { manager, launches, settings, spike, foreign, registry } = setup()
    const meta = manager.create({ projectPath: '/proj', settings, text: 'first' })
    await finishTurn(launches[0]!, 'n1', 'ok')
    expect(() => manager.send(meta.id, 'x', undefined, undefined, undefined, undefined, undefined, foreign.id)).toThrow(WorkspaceUnavailableError)
    registry.set(spike.id, { ...spike, lifecycle: 'removed' })
    expect(() => manager.send(meta.id, 'x', undefined, undefined, undefined, undefined, undefined, spike.id)).toThrow(WorkspaceUnavailableError)
    expect(() => manager.send(meta.id, 'x', undefined, undefined, undefined, undefined, undefined, randomUUID())).toThrow(WorkspaceUnavailableError)
    expect(launches).toHaveLength(1)
  })

  it('a workspace removed while the conversation works in it is refused, never run in the primary', async () => {
    const { store, manager, launches, settings, spike, registry } = setup()
    const meta = manager.create({ projectPath: '/proj', settings, text: 'first' })
    await finishTurn(launches[0]!, 'n1', 'ok')
    manager.send(meta.id, 'there', undefined, undefined, undefined, undefined, undefined, spike.id)
    await finishTurn(launches[1]!, 'n2', 'ok')
    await manager.shutdown() // Cockpit restarts; the worktree goes away meanwhile
    registry.set(spike.id, { ...spike, lifecycle: 'removed' })
    manager.send(meta.id, 'still there?', undefined, undefined, undefined, undefined, undefined, spike.id)
    expect(launches).toHaveLength(2)
    await Promise.resolve()
    expect(kinds(store.events(meta.id), 'error').at(-1)).toMatchObject({ message: expect.stringContaining('This workspace no longer exists') })
  })

  it('after an agent switch, returning to a workspace starts a new session there instead of resuming the other agent\'s', async () => {
    const { manager, launches, settings, primary, spike } = setup()
    const meta = manager.create({ projectPath: '/proj', settings, text: 'first' })
    await finishTurn(launches[0]!, 'claude-primary', 'ok')
    manager.send(meta.id, 'there', undefined, undefined, undefined, undefined, undefined, spike.id)
    await finishTurn(launches[1]!, 'claude-spike', 'ok')
    manager.switchAgent(meta.id, threadSettingsSchema.parse({ agent: 'codex' }))
    manager.send(meta.id, 'codex in the spike', undefined, undefined, undefined, undefined, undefined, spike.id)
    // The switch's handoff names the folder the conversation works in now, not the primary.
    expect(launches[2]!.request.seed).toContain('Project folder: /proj-worktree-abc123')
    await finishTurn(launches[2]!, 'codex-spike', 'ok')
    manager.send(meta.id, 'codex in the primary', undefined, undefined, undefined, undefined, undefined, primary.id)
    expect(launches[3]!.request).toMatchObject({ cwd: '/proj', settings: expect.objectContaining({ agent: 'codex' }) })
    expect(launches[3]!.request.resume).toBeUndefined()
    expect(launches[3]!.request.seed).toContain('codex in the spike')
  })
})
