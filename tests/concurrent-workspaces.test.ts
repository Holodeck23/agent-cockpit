import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSession, ApprovalBehavior, EventSink, NormalizedEvent } from '../server/agents/types.ts'
import type { Workspace } from '../server/projects/workspaces.ts'
import { createThreadManager, ThreadBusyError, type LaunchRequest, type Launcher } from '../server/threads/manager.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'

// Order 18b (W12-15): one conversation, two agents at work at once, each in its own worktree.
// Their sessions, queues, approvals and questions stay their own; Stop stops one, Stop all both;
// Complete waits for every one of them; and neither is silently fed the other's output.

interface Launch {
  readonly request: LaunchRequest; readonly emit: EventSink; readonly sent: string[]
  alive: boolean; interrupted: number; readonly answered: Array<{ requestId: string; behavior: ApprovalBehavior }>
}

const PROJECT = randomUUID()
const workspace = (kind: Workspace['kind'], cwd: string, extra: Partial<Workspace> = {}): Workspace => ({
  id: randomUUID(), projectId: PROJECT, kind, cwd, canonicalCwd: cwd, gitCommonDir: '/proj/.git', managed: kind === 'worktree',
  lifecycle: 'active', revision: 1, createdAt: new Date().toISOString(), ...extra,
})

function setup() {
  const store = createThreadStore(join(mkdtempSync(join(tmpdir(), 'cockpit-concurrent-')), 'threads'))
  const primary = workspace('primary', '/proj')
  const rose = workspace('worktree', '/proj-worktree-aaaaaa', { name: 'Rose bed', branch: 'codex/rose-bed' })
  const pond = workspace('worktree', '/proj-worktree-bbbbbb', { name: 'Pond', branch: 'codex/pond' })
  const registry = new Map([primary, rose, pond].map((w) => [w.id, w]))
  const launches: Launch[] = []
  const launcher: Launcher = (request, onEvent) => {
    const launch: Launch = { request, emit: onEvent, sent: [], alive: true, interrupted: 0, answered: [] }
    launches.push(launch)
    const session: AgentSession = {
      agent: request.settings.agent, send: (text) => { launch.sent.push(text) },
      respondApproval: (req, behavior) => { launch.answered.push({ requestId: req.requestId, behavior }) },
      interrupt: () => { launch.interrupted += 1 },
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
  return { store, manager, launches, settings: threadSettingsSchema.parse({}), primary, rose, pond }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const send = (manager: ReturnType<typeof setup>['manager'], id: string, text: string, workspaceId: string) =>
  manager.send(id, text, undefined, undefined, undefined, undefined, undefined, workspaceId)
const of = (events: readonly { event: NormalizedEvent }[], kind: NormalizedEvent['kind']) => events.filter((e) => e.event.kind === kind)

describe('two agents at once in one conversation (W12-15)', () => {
  it('a second workspace starts its own agent while the first is still working; both are labelled and both run', async () => {
    const { store, manager, launches, settings, rose, pond } = setup()
    const meta = manager.create({ projectPath: '/proj', settings, text: 'start', workspaceId: rose.id })
    await flush()
    launches[0]!.emit({ kind: 'session', sessionId: 'rose-session' })
    // Rose bed is still working: Pond starts anyway, in its own folder.
    send(manager, meta.id, 'meanwhile, the pond', pond.id)
    await flush()
    expect(launches).toHaveLength(2)
    expect(launches[0]!.request.cwd).toBe(rose.cwd)
    expect(launches[1]!.request.cwd).toBe(pond.cwd)
    expect(launches[0]!.alive).toBe(true)
    expect(manager.status(meta.id)).toBe('working')
    expect(manager.runs(meta.id).map((r) => [r.workspaceId, r.working]).sort()).toEqual([[pond.id, true], [rose.id, true]].sort())
    // Every event is stored with the workspace it belongs to.
    const users = of(store.events(meta.id), 'user_text')
    expect(users.map((e) => (e as { workspaceId?: string }).workspaceId)).toEqual([rose.id, pond.id])
    // Rose bed's session id, reported after the conversation moved on, lands on Rose bed's binding.
    launches[0]!.emit({ kind: 'session', sessionId: 'rose-session-2' })
    launches[1]!.emit({ kind: 'session', sessionId: 'pond-session' })
    const saved = store.get(meta.id)!
    expect(saved.sessionId).toBe('pond-session')
    expect(saved.bindings?.[rose.id]?.sessionId).toBe('rose-session-2')
  })

  it('one workspace\'s result never closes the other\'s approval; answering reaches the session that asked', async () => {
    const { store, manager, launches, settings, rose, pond } = setup()
    const meta = manager.create({ projectPath: '/proj', settings, text: 'start', workspaceId: rose.id })
    await flush()
    send(manager, meta.id, 'pond too', pond.id)
    await flush()
    launches[0]!.emit({ kind: 'approval_request', requestId: 'native-rose', toolName: 'Bash', input: { command: 'ls' }, suggestions: [] })
    launches[1]!.emit({ kind: 'result', ok: true })
    expect(manager.status(meta.id)).toBe('needs_input')
    const card = of(store.events(meta.id), 'approval_request').at(-1)!.event as { requestId: string }
    manager.approve(meta.id, card.requestId, 'allow')
    expect(launches[0]!.answered).toEqual([{ requestId: 'native-rose', behavior: 'allow' }])
    expect(launches[1]!.answered).toEqual([])
  })

  it('Stop stops one workspace, Stop all stops both, and Complete waits for every agent', async () => {
    const { manager, launches, settings, rose, pond } = setup()
    const meta = manager.create({ projectPath: '/proj', settings, text: 'start', workspaceId: rose.id })
    await flush()
    send(manager, meta.id, 'pond too', pond.id)
    await flush()
    manager.interrupt(meta.id, pond.id)
    expect([launches[0]!.interrupted, launches[1]!.interrupted]).toEqual([0, 1])
    launches[1]!.emit({ kind: 'result', ok: false })
    expect(manager.canControl(meta.id, rose.id)).toBe(true)
    expect(manager.canControl(meta.id, pond.id)).toBe(false)
    expect(() => manager.setCompleted(meta.id, true)).toThrow(ThreadBusyError)
    manager.interrupt(meta.id)
    expect(launches[0]!.interrupted).toBe(1)
    launches[0]!.emit({ kind: 'result', ok: false })
    expect(manager.setCompleted(meta.id, true).completed).toBe(true)
  })

  it('a message to a workspace whose agent is mid-turn waits in that agent\'s own queue', async () => {
    const { manager, launches, settings, rose, pond } = setup()
    const meta = manager.create({ projectPath: '/proj', settings, text: 'start', workspaceId: rose.id })
    await flush()
    send(manager, meta.id, 'pond too', pond.id)
    await flush()
    send(manager, meta.id, 'and another for the rose bed', rose.id)
    expect(launches).toHaveLength(2)
    expect(launches[0]!.sent.at(-1)).toContain('and another for the rose bed')
    expect(launches[1]!.sent).toHaveLength(1)
  })

  it('returning to a workspace that kept working hears only what happened elsewhere, never its own output', async () => {
    const { manager, launches, settings, rose, pond } = setup()
    const meta = manager.create({ projectPath: '/proj', settings, text: 'ROSE-ASK', workspaceId: rose.id })
    await flush()
    launches[0]!.emit({ kind: 'session', sessionId: 'rose-session' })
    send(manager, meta.id, 'POND-ASK', pond.id)
    await flush()
    // Rose bed keeps working and finishes while the conversation looks at the pond.
    launches[0]!.emit({ kind: 'assistant_text', messageId: 'r1', text: 'ROSE-OWN-REPLY' })
    launches[0]!.emit({ kind: 'result', ok: true })
    launches[1]!.emit({ kind: 'session', sessionId: 'pond-session' })
    launches[1]!.emit({ kind: 'assistant_text', messageId: 'p1', text: 'POND-REPLY' })
    launches[1]!.emit({ kind: 'result', ok: true })
    send(manager, meta.id, 'back to the roses', rose.id)
    const delivered = launches[0]!.alive ? launches[0]!.sent.at(-1)! : launches.at(-1)!.sent.at(-1)!
    expect(delivered).toContain('POND-REPLY')
    expect(delivered).not.toContain('ROSE-OWN-REPLY')
    expect(delivered).toContain('back to the roses')
  })
})
