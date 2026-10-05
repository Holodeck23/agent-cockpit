import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { EventSink } from '../server/agents/types.ts'
import { createThreadManager, type Launcher, type ThreadManager } from '../server/threads/manager.ts'
import { openApprovals } from '../server/threads/status.ts'
import { createThreadStore, type ThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'

// "Allow for this session" for processes lasts until that agent session ends. Switching agents,
// changing settings or recovering ends it before its exit is recorded (the exit is then dropped as
// stale), so the allowance must not carry into the next session.

function setup() {
  const store = createThreadStore(mkdtempSync(join(tmpdir(), 'cockpit-allowance-')))
  let sink: EventSink = () => {}
  const launcher: Launcher = (_request, emit) => {
    sink = emit
    let alive = true
    return { agent: 'claude', alive: () => alive, send() {}, interrupt() {}, respondApproval() {},
      close: async () => { alive = false; emit({ kind: 'exit', code: 0 }) } }
  }
  const manager = createThreadManager(store, { launchers: { claude: launcher, codex: launcher } })
  const thread = manager.create({ projectPath: store.root, text: 'start the dev server', settings: threadSettingsSchema.parse({}) })
  return { store, manager, thread, emit: (e: Parameters<EventSink>[0]) => sink(e) }
}

const startProcess = (manager: ThreadManager, id: string) =>
  manager.requestHostAction(id, 'mcp__cockpit__start_process', { command: 'npm run dev' }, undefined, { sessionKey: 'processes', label: 'Cockpit action' })

/** Whether the next start in this conversation shows a card (true) or runs at once (false). */
async function asks(store: ThreadStore, manager: ThreadManager, id: string): Promise<boolean> {
  const before = openApprovals(store.events(id)).length
  let settled = false
  const request = startProcess(manager, id).then(() => { settled = true }, () => { settled = true })
  await Promise.resolve()
  const asked = !settled && openApprovals(store.events(id)).length > before
  if (asked) { manager.approve(id, openApprovals(store.events(id)).at(-1)!, 'deny'); await request }
  return asked
}

async function allowForSession(h: ReturnType<typeof setup>): Promise<void> {
  const first = startProcess(h.manager, h.thread.id)
  h.manager.approve(h.thread.id, openApprovals(h.store.events(h.thread.id))[0]!, 'allow_session')
  await first
  expect(await asks(h.store, h.manager, h.thread.id)).toBe(false)
  h.emit({ kind: 'result', ok: true })
}

describe('Allow for this session', () => {
  it('does not carry into the session after switching agents', async () => {
    const h = setup()
    await allowForSession(h)
    h.manager.switchAgent(h.thread.id, threadSettingsSchema.parse({ agent: 'codex' }))
    h.manager.send(h.thread.id, 'carry on')
    expect(await asks(h.store, h.manager, h.thread.id)).toBe(true)
  })

  it('does not carry into the session after changing settings', async () => {
    const h = setup()
    await allowForSession(h)
    h.manager.changeSettings(h.thread.id, threadSettingsSchema.parse({ permissionMode: 'acceptEdits' }))
    h.manager.send(h.thread.id, 'carry on')
    expect(await asks(h.store, h.manager, h.thread.id)).toBe(true)
  })

  it('does not carry into a recovered session', async () => {
    const h = setup()
    await allowForSession(h)
    h.manager.resumeRecovered(h.thread.id, 'claude', 'resume', 'resume')
    expect(await asks(h.store, h.manager, h.thread.id)).toBe(true)
  })
})
