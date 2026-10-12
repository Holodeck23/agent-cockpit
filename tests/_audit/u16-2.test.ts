import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSession, EventSink } from '../../server/agents/types.ts'
import { createThreadManager, type Launcher } from '../../server/threads/manager.ts'
import { createThreadStore } from '../../server/threads/store.ts'
import { threadSettingsSchema } from '../../server/threads/types.ts'

// u16-2: Stop (or "Stop all") on a conversation whose turn already ended set stopRequested on the
// idle live session, and nothing clears it (no result follows an interrupt of an idle session).
// The next turn then ran with stopRequested stuck on: cockpit tools refused it ("no longer
// working") and a genuine failure was stored as a stop.
// CORRECT behaviour: stopping an idle session leaves the next turn unaffected.

function setup() {
  const store = createThreadStore(mkdtempSync(join(tmpdir(), 'cockpit-u16-2-')))
  let emit: EventSink = () => undefined
  let interrupted = 0
  const launcher: Launcher = (_request, onEvent) => {
    emit = onEvent
    let alive = true
    const session: AgentSession = {
      agent: 'claude', send: () => undefined, respondApproval: () => undefined,
      interrupt: () => { interrupted += 1 },
      close: () => { alive = false; onEvent({ kind: 'exit', code: 0 }); return Promise.resolve() },
      alive: () => alive,
    }
    return session
  }
  const manager = createThreadManager(store, { launchers: { claude: launcher, codex: launcher } })
  const meta = manager.create({ projectPath: '/tmp', settings: threadSettingsSchema.parse({}), text: 'first' })
  return { store, manager, meta, emit: (e: Parameters<EventSink>[0]) => emit(e), interrupted: () => interrupted }
}

describe('u16-2 Stop on an idle session', () => {
  it('does not poison the next turn: cockpit tools still work and a failure is an error, not a stop', async () => {
    const { store, manager, meta, emit, interrupted } = setup()
    emit({ kind: 'session', sessionId: meta.sessionId })
    emit({ kind: 'result', ok: true })
    expect(manager.canControl(meta.id)).toBe(false)

    manager.interrupt(meta.id)          // Stop pressed just as (or after) the turn ended
    manager.interrupt(meta.id, undefined) // and again, as "Stop all" would
    expect(interrupted()).toBeGreaterThan(0) // the agent is still asked to stop

    manager.send(meta.id, 'second')
    expect(manager.canControl(meta.id)).toBe(true)
    const controller = new AbortController()
    const asked = manager.requestHostAction(meta.id, 'mcp__cockpit__noop', {}, controller.signal).then(() => 'allowed', (error: Error) => error.message)
    controller.abort()
    expect(await asked).not.toMatch(/no longer working/)

    emit({ kind: 'result', ok: false })
    const last = store.events(meta.id).filter((e) => e.event.kind === 'result').at(-1)?.event
    expect(last).toMatchObject({ kind: 'result', ok: false })
    expect(last).not.toHaveProperty('stopped', true)
  })

  it('still marks a running turn as stopped', () => {
    const { store, manager, meta, emit } = setup()
    emit({ kind: 'session', sessionId: meta.sessionId })
    manager.interrupt(meta.id)
    expect(manager.canControl(meta.id)).toBe(false)
    emit({ kind: 'result', ok: false })
    expect(store.events(meta.id).filter((e) => e.event.kind === 'result').at(-1)?.event).toMatchObject({ ok: false, stopped: true })
  })
})
