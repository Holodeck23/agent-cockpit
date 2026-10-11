import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCapabilityService } from '../../server/agents/capabilities/service.ts'
import { createLifecycle } from '../../server/agents/lifecycle/service.ts'
import type { AgentId, EventSink } from '../../server/agents/types.ts'
import { createThreadManager, type Launcher } from '../../server/threads/manager.ts'
import { createThreadStore } from '../../server/threads/store.ts'
import { threadSettingsSchema } from '../../server/threads/types.ts'

// u05-1: an update waiting for idle (W10-08: "never resumes by itself on quit") must not start its
// updater because quitting closed the busy session that it was waiting on. Wired the way
// server/start.ts wires it: manager.subscribe -> lifecycle.activityChanged, and close() calls
// manager.shutdown() and lifecycle.shutdown() together.
describe('u05-1: quit while an update is waiting_for_idle', () => {
  it('does not spawn the updater after shutdown, and keeps the update pending', { timeout: 30_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-u05-1-'))
    const home = join(root, 'home')
    const bin = join(home, '.local', 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'agy'), `#!/bin/sh
case "$1" in
--version) cat "${join(root, 'version')}" ;;
models) printf 'm\\tM\\n' ;;
update) echo updated >> "${join(root, 'updates')}"; echo "1.3.1" > "${join(root, 'version')}" ;;
esac
`)
    writeFileSync(join(root, 'version'), '1.3.0\n')
    chmodSync(join(bin, 'agy'), 0o755)
    const updates = (): number => (existsSync(join(root, 'updates')) ? readFileSync(join(root, 'updates'), 'utf8').trim().split('\n').length : 0)
    const pathEnv = (): string => bin

    // A fake agent session that is mid-turn; closing it ends the process, which reports its exit.
    const store = createThreadStore(mkdtempSync(join(tmpdir(), 'cockpit-u05-1-threads-')))
    const launcher = (agent: AgentId): Launcher => (_request, onEvent: EventSink) => {
      let alive = true
      return { agent, send: () => undefined, respondApproval: () => undefined, interrupt: () => undefined, alive: () => alive,
        close: () => { alive = false; onEvent({ kind: 'exit', code: 0 }); return Promise.resolve() } }
    }
    const manager = createThreadManager(store, { launchers: { antigravity: launcher('antigravity'), claude: launcher('claude') } })
    const lifecycle = createLifecycle({
      stateRoot: join(root, 'state'), home, pathEnv, capabilities: createCapabilityService({ pathEnv, home, timeoutMs: 8000 }),
      sessions: { activity: (agent) => manager.agentActivity(agent), closeIdle: (agent) => manager.closeIdleSessions(agent) },
    })
    manager.subscribe(() => lifecycle.activityChanged())

    manager.create({ projectPath: '/projects/one', settings: threadSettingsSchema.parse({ agent: 'antigravity' }), text: 'go' })
    expect(manager.agentActivity('antigravity')).toEqual({ busy: 1, idle: 0 })
    const op = await lifecycle.start('antigravity', 'update')
    expect(op.state).toBe('waiting_for_idle')

    // Quit, exactly as server/start.ts close() does.
    await Promise.all([manager.shutdown(), lifecycle.shutdown()])

    // Give a runaway updater every chance to start and finish.
    await expect.poll(() => lifecycle.get(op.id)?.endedAt !== undefined, { timeout: 6_000, interval: 50 }).toBe(true).catch(() => undefined)
    await new Promise((r) => setTimeout(r, 500))

    // Correct behaviour: quitting never runs the update; it stays a question for the next start.
    expect(updates()).toBe(0)
    expect(lifecycle.get(op.id)?.state).not.toBe('updated')
    expect(lifecycle.get(op.id)?.state).not.toBe('updating')
  })
})
