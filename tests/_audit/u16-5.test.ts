import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSession, EventSink } from '../../server/agents/types.ts'
import type { Workspace } from '../../server/projects/workspaces.ts'
import { ChooseWorkspaceError, createThreadManager, type LaunchRequest, type Launcher } from '../../server/threads/manager.ts'
import { createThreadStore } from '../../server/threads/store.ts'
import { threadSettingsSchema } from '../../server/threads/types.ts'

// u16-5: resumeRecovered switched the agent (or reset the settings and closed the session) and only
// then called send(), which refuses a conversation that has run in several workspaces unless a
// workspace is named. Recovery names none, so the resume was half applied and then failed (409),
// and a retry is "already attempted".
// CORRECT behaviour: a conversation with workspace bindings resumes in the workspace it is in now;
// and if send() would refuse, nothing has been changed first.

interface Launch { readonly request: LaunchRequest; readonly emit: EventSink; readonly sent: string[]; alive: boolean }

const PROJECT = randomUUID()
const workspace = (kind: Workspace['kind'], cwd: string, extra: Partial<Workspace> = {}): Workspace => ({
  id: randomUUID(), projectId: PROJECT, kind, cwd, canonicalCwd: cwd, gitCommonDir: '/proj/.git', managed: kind === 'worktree',
  lifecycle: 'active', revision: 1, createdAt: new Date().toISOString(), ...extra,
})

function setup(withWorkspaces = true) {
  const store = createThreadStore(join(mkdtempSync(join(tmpdir(), 'cockpit-u16-5-')), 'threads'))
  const primary = workspace('primary', '/proj')
  const spike = workspace('worktree', '/proj-worktree-abc123', { name: 'Spike', branch: 'codex/spike' })
  const registry = new Map([primary, spike].map((w) => [w.id, w]))
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
    ...(withWorkspaces ? { workspace: (id: string) => registry.get(id), workspaceFor: (path: string) => (path === '/proj' ? primary.id : undefined) } : {}),
  })
  return { store, manager, launches, settings: threadSettingsSchema.parse({}), primary, spike }
}
async function finishTurn(launch: Launch, sessionId: string): Promise<void> {
  await Promise.resolve()
  launch.emit({ kind: 'session', sessionId })
  launch.emit({ kind: 'result', ok: true })
}

describe('u16-5 resuming recovered work in a conversation that moved between workspaces', () => {
  async function moved() {
    const s = setup()
    const meta = s.manager.create({ projectPath: '/proj', settings: s.settings, text: 'first' })
    await finishTurn(s.launches[0]!, 'native-primary')
    s.manager.send(meta.id, 'there', undefined, undefined, undefined, undefined, undefined, s.spike.id)
    await finishTurn(s.launches[1]!, 'native-spike')
    return { ...s, meta }
  }

  it('same agent: resumes where the conversation is now', async () => {
    const { manager, launches, meta, spike } = await moved()
    expect(() => manager.resumeRecovered(meta.id, 'claude', 'resume', 'resume please')).not.toThrow()
    const last = launches.at(-1)!
    expect(last.request.cwd).toBe(spike.cwd)
    expect(last.sent).toEqual(['resume please'])
  })

  it('another agent: the switch and the message both happen, in the current workspace', async () => {
    const { store, manager, launches, meta, spike } = await moved()
    expect(() => manager.resumeRecovered(meta.id, 'codex', 'resume', 'resume please')).not.toThrow()
    expect(store.get(meta.id)?.settings.agent).toBe('codex')
    const last = launches.at(-1)!
    expect(last.request.settings.agent).toBe('codex')
    expect(last.request.cwd).toBe(spike.cwd)
    expect(store.events(meta.id).filter((e) => e.event.kind === 'agent_switch')).toHaveLength(1)
  })

  it('when no workspace can be named, it is refused before anything is changed', () => {
    const { store, manager, settings } = setup(false)
    const meta = store.create({ id: randomUUID(), title: 't', projectPath: '/proj', settings, sessionId: randomUUID(), bindingId: randomUUID(), sessionStarted: true, completed: false,
      bindings: { other: { agent: 'claude', bindingId: randomUUID(), sessionId: randomUUID(), sessionStarted: true, cursor: 0 } },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    expect(() => manager.resumeRecovered(meta.id, 'codex', 'resume', 'resume please')).toThrow(ChooseWorkspaceError)
    expect(store.get(meta.id)?.settings.agent).toBe('claude')
    expect(store.events(meta.id).filter((e) => e.event.kind === 'agent_switch')).toHaveLength(0)
  })
})
