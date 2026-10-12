import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSession, EventSink, NormalizedEvent } from '../../server/agents/types.ts'
import { runsOf } from '../../server/threads/identity.ts'
import { createThreadManager, type Launcher } from '../../server/threads/manager.ts'
import { createThreadStore } from '../../server/threads/store.ts'
import { threadSettingsSchema } from '../../server/threads/types.ts'

// u17-1: a message queued mid-turn is stored BEFORE the running turn's result. When the turn ends
// (result{runId: A}) the agent takes the queued message (user_taken) and starts on it. If Cockpit
// then dies without recording a result for that second turn, unfinishedRun() must still report the
// queued run as unfinished so recoverInterrupted() closes it. It does not: the extra "any later
// result/exit/error" check counts run A's own result as proof that run B ended.
// CORRECT behaviour: the queued run B is reported unfinished and is closed as interrupted.

interface Fake { emit: EventSink; sent: string[] }

function fakes(): { launcher: Launcher; sessions: Fake[] } {
  const sessions: Fake[] = []
  const launcher: Launcher = (_request, emit) => {
    const fake: Fake = { emit, sent: [] }
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
function setup(root = mkdtempSync(join(tmpdir(), 'cockpit-u17-1-'))) {
  const store = createThreadStore(root)
  const { launcher, sessions } = fakes()
  const manager = createThreadManager(store, { launchers: { claude: launcher, codex: launcher }, workspaceFor: () => 'ws-primary' })
  return { root, store, manager, sessions }
}
const kinds = (events: ReadonlyArray<{ event: NormalizedEvent }>) => events.map((e) => e.event)

describe('u17-1 recovery of a crashed queued-message turn', () => {
  it('control: a crash in a plain first turn is recovered (existing behaviour)', () => {
    const before = setup()
    const meta = before.manager.create({ projectPath: '/tmp', settings, text: 'first' })
    before.sessions[0]!.emit({ kind: 'assistant_text', messageId: 'm1', text: 'working on it' })
    // Cockpit dies here: a new process reads the same directory.
    const after = setup(before.root)
    expect(after.manager.recoverInterrupted()).toEqual([meta.id])
  })

  it('a queued message taken after turn A ended and then cut off by a crash is closed as interrupted', () => {
    const before = setup()
    const meta = before.manager.create({ projectPath: '/tmp', settings, text: 'first' })
    const agent = before.sessions[0]!
    agent.emit({ kind: 'session', sessionId: meta.sessionId })
    // The user queues a second message while turn A is still running.
    const queued = before.manager.send(meta.id, 'second, queued while working')
    const queuedId = kinds(before.store.events(meta.id)).find((e) => e.kind === 'user_text' && e.queuedId)
    expect(queuedId).toBeDefined()
    // Turn A ends normally, then the agent takes the queued message and starts on it.
    agent.emit({ kind: 'assistant_text', messageId: 'a1', text: 'first answered' })
    agent.emit({ kind: 'result', ok: true })
    agent.emit({ kind: 'user_taken', text: 'second, queued while working', id: (queuedId as { queuedId: string }).queuedId })
    agent.emit({ kind: 'assistant_text', messageId: 'b1', text: 'starting on the second' })
    // Cockpit is force-quit here: no result, exit or error was recorded for the second turn.

    const events = kinds(before.store.events(meta.id))
    expect(events.filter((e) => e.kind === 'result')).toHaveLength(1)
    expect(events.some((e) => e.kind === 'exit' || e.kind === 'error')).toBe(false)

    const after = setup(before.root)
    // Sanity: the log itself says run B (the queued run) is still open.
    const runs = runsOf(meta.id, after.store.events(meta.id))
    expect(runs.map((r) => r.ended)).toEqual([true, false])
    expect(runs[1]!.runId).toBe(queued.runId)

    // CORRECT: recovery finds the open queued run and records it as interrupted.
    expect(after.manager.recoverInterrupted()).toEqual([meta.id])
    const last = kinds(after.store.events(meta.id)).at(-1)
    expect(last).toEqual({ kind: 'result', ok: false, interrupted: true, runId: queued.runId })
  })
})
