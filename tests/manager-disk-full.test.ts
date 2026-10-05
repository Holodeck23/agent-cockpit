import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventSink } from '../server/agents/types.ts'
import { createThreadManager, type Launcher } from '../server/threads/manager.ts'
import { createThreadStore, type ThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'

// A write that fails (a full disk) loses that event from the log, but must not stop the turn from
// ending: the result or exit that could not be saved still ends it, and the session is released.

describe('the disk fills while an agent works', () => {
  let errors: ReturnType<typeof vi.spyOn>
  beforeEach(() => { errors = vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => { errors.mockRestore() })

  it('still ends the turn and releases the session when the result and exit cannot be saved', () => {
    const real = createThreadStore(mkdtempSync(join(tmpdir(), 'cockpit-disk-full-')))
    let full = false
    const store: ThreadStore = {
      ...real,
      append: (id, event, ts) => {
        if (full) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
        return real.append(id, event, ts)
      },
    }
    let emit: EventSink = () => {}
    let alive = true
    const launcher: Launcher = (_request, onEvent) => {
      emit = onEvent
      return { agent: 'claude', send() {}, interrupt() {}, respondApproval() {}, alive: () => alive,
        close: async () => { alive = false; onEvent({ kind: 'exit', code: 0 }) } }
    }
    const manager = createThreadManager(store, { launchers: { claude: launcher, codex: launcher } })
    const meta = manager.create({ projectPath: '/tmp', settings: threadSettingsSchema.parse({}), text: 'hello' })
    emit({ kind: 'session', sessionId: meta.sessionId })
    expect(manager.status(meta.id)).toBe('working')

    full = true
    emit({ kind: 'result', ok: true })
    expect(manager.status(meta.id)).not.toBe('working')
    expect(manager.canControl(meta.id)).toBe(false)

    alive = false
    emit({ kind: 'exit', code: 0 })
    expect(manager.status(meta.id)).not.toBe('working')
    expect(manager.summaries().find((s) => s.meta.id === meta.id)?.status).not.toBe('working')
    expect(errors).toHaveBeenCalled()
  })
})
