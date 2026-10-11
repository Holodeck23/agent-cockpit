import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSession } from '../../server/agents/types.ts'
import { createThreadManager, type Launcher } from '../../server/threads/manager.ts'
import { createThreadStore, type ThreadStore } from '../../server/threads/store.ts'
import { threadSettingsSchema } from '../../server/threads/types.ts'

// u16-6: create() launches the agent inside send(); if send() then throws (a store write fails),
// create() removed the conversation's files but left the launched session in `live`, idle with no
// timer and its MCP grant held, until the app quit.
// CORRECT behaviour: a failed create closes the session it started.

describe('u16-6 create() that fails after its session launched', () => {
  it('leaves no live session behind', async () => {
    const real = createThreadStore(mkdtempSync(join(tmpdir(), 'cockpit-u16-6-')))
    let updates = 0
    const store: ThreadStore = { ...real, update: (id, patch) => {
      updates += 1
      // The first update is before the launch; the second is right after the process started.
      if (updates === 2) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      return real.update(id, patch)
    } }
    let alive = true
    let launches = 0
    const launcher: Launcher = (_request, onEvent) => {
      launches += 1
      const session: AgentSession = {
        agent: 'claude', send: () => undefined, respondApproval: () => undefined, interrupt: () => undefined,
        close: () => { alive = false; onEvent({ kind: 'exit', code: 0 }); return Promise.resolve() }, alive: () => alive,
      }
      return session
    }
    const released = vi.fn()
    const manager = createThreadManager(store, { launchers: { claude: launcher, codex: launcher },
      mcp: () => ({ launch: { command: 'x', args: [], env: {}, secretEnv: {} }, release: released }) })

    expect(() => manager.create({ projectPath: '/tmp', settings: threadSettingsSchema.parse({}), text: 'hello' })).toThrow(/ENOSPC/)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(real.list()).toHaveLength(0)
    expect(launches).toBe(1)
    expect(manager.agentActivity('claude')).toEqual({ busy: 0, idle: 0 })
    expect(alive).toBe(false)
    expect(released).toHaveBeenCalled()
    expect(real.list()).toHaveLength(0)
  })
})
