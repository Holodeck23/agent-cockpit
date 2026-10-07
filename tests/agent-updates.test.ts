import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCapabilityService } from '../server/agents/capabilities/service.ts'
import { checkLatest, parseVersion } from '../server/agents/lifecycle/latest.ts'
import { createLifecycle, type OperationView } from '../server/agents/lifecycle/service.ts'
import { claudeLaunchEnv } from '../server/threads/manager.ts'
import type { AgentId, EventSink } from '../server/agents/types.ts'
import { createThreadManager, type Launcher } from '../server/threads/manager.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'

// W10-07, W10-08, CROSS-06: an update replaces the executable only once nothing uses it, new
// sessions cannot start in between, other agents carry on, and a pending update never resumes
// by itself after a restart.
const SLOW = { timeout: 30_000 }

function agyInstalled() {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-updates-'))
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
  const busy: Partial<Record<AgentId, number>> = {}
  const closed: AgentId[] = []
  const pathEnv = (): string => bin
  const make = () => createLifecycle({
    stateRoot: join(root, 'state'), home, pathEnv, capabilities: createCapabilityService({ pathEnv, home, timeoutMs: 8000 }),
    sessions: { activity: (agent) => ({ busy: busy[agent] ?? 0 }), closeIdle: async (agent) => { closed.push(agent) } },
  })
  return { root, busy, closed, make, updates: () => existsSync(join(root, 'updates')) ? readFileSync(join(root, 'updates'), 'utf8').trim().split('\n').length : 0 }
}

const ended = async (get: () => OperationView | undefined): Promise<OperationView> => {
  await expect.poll(() => get()?.endedAt !== undefined, { timeout: 20_000, interval: 50 }).toBe(true)
  return get()!
}

describe('update while agents work (W10-07, CROSS-06)', () => {
  it('waits for every conversation using the executable, holds new starts, and leaves other agents alone', SLOW, async () => {
    const ctx = agyInstalled()
    const lifecycle = ctx.make()
    ctx.busy.antigravity = 2
    const op = await lifecycle.start('antigravity', 'update')
    expect(op.state).toBe('waiting_for_idle')
    expect(lifecycle.get(op.id)?.message).toMatch(/2 conversations/)
    expect(lifecycle.launchBlock('antigravity')).toMatch(/waiting to update/)
    expect(lifecycle.launchBlock('claude')).toBeUndefined()
    ctx.busy.antigravity = 1
    lifecycle.activityChanged()
    expect(lifecycle.get(op.id)?.state).toBe('waiting_for_idle')
    expect(ctx.updates()).toBe(0)
    ctx.busy.antigravity = 0
    lifecycle.activityChanged()
    const done = await ended(() => lifecycle.get(op.id))
    expect(done).toMatchObject({ state: 'updated', result: { previousVersion: '1.3.0', version: '1.3.1' } })
    // Idle sessions were closed before the file was replaced, and the hold is released after.
    expect(ctx.closed).toEqual(['antigravity'])
    expect(ctx.updates()).toBe(1)
    expect(lifecycle.launchBlock('antigravity')).toBeUndefined()
  })

  it('Cancel while waiting runs nothing and releases the hold', SLOW, async () => {
    const ctx = agyInstalled()
    const lifecycle = ctx.make()
    ctx.busy.antigravity = 1
    const op = await lifecycle.start('antigravity', 'update')
    expect(lifecycle.cancel(op.id)).toBe(true)
    expect(lifecycle.get(op.id)?.state).toBe('cancelled')
    ctx.busy.antigravity = 0
    lifecycle.activityChanged()
    expect(ctx.updates()).toBe(0)
    expect(lifecycle.launchBlock('antigravity')).toBeUndefined()
  })
})

describe('pending update across a restart (W10-08)', () => {
  it('comes back as needing confirmation, never runs by itself, and resumes only when asked', SLOW, async () => {
    const ctx = agyInstalled()
    ctx.busy.antigravity = 1
    await ctx.make().start('antigravity', 'update')
    // Cockpit restarts with the update still waiting.
    ctx.busy.antigravity = 0
    const after = ctx.make()
    const [pending] = after.list().filter((o) => o.agent === 'antigravity')
    expect(pending?.state).toBe('pending_confirmation')
    after.activityChanged()
    await new Promise((r) => setTimeout(r, 300))
    expect(ctx.updates()).toBe(0)
    expect(after.launchBlock('antigravity')).toBeUndefined()
    after.resume(pending!.id)
    expect((await ended(() => after.get(pending!.id))).state).toBe('updated')
    expect(ctx.updates()).toBe(1)
    // Dealt with: a further restart shows nothing pending.
    expect(ctx.make().list().filter((o) => o.state === 'pending_confirmation')).toEqual([])
  })
})

describe('latest version and skip (W10-08)', () => {
  const caps = (agent: AgentId, version: string) => ({ agent, context: 'default', settings: {}, auth: { state: 'not_checked' as const }, models: { state: 'not_checked' as const },
    manager: { kind: 'native' as const, label: 'native' }, executable: { state: 'found' as const, identity: { command: 'claude', path: '/x', realpath: '/x', fingerprint: 'f', version } } })
  const at = () => Date.parse('2026-10-06T12:00:00Z')

  it('reads versions the way each CLI prints them', () => {
    expect(parseVersion('2.1.291 (Claude Code)')).toBe('2.1.291')
    expect(parseVersion('codex-cli 0.160.1')).toBe('0.160.1')
    expect(parseVersion('1.3.0')).toBe('1.3.0')
    expect(parseVersion('weird')).toBeUndefined()
  })

  it('available, up to date, and a skipped exact version that does not hide a newer one', async () => {
    const feed = (version: string) => async () => ({ version })
    expect(await checkLatest(caps('claude', '2.1.291 (Claude Code)'), { fetchJson: feed('2.1.300'), now: at })).toMatchObject({ state: 'available', installed: '2.1.291', latest: '2.1.300', source: 'npm registry', checkedAt: '2026-10-06T12:00:00.000Z' })
    expect(await checkLatest(caps('claude', '2.1.300 (Claude Code)'), { fetchJson: feed('2.1.300'), now: at })).toMatchObject({ state: 'up_to_date' })
    expect(await checkLatest(caps('claude', '2.1.291 (Claude Code)'), { fetchJson: feed('2.1.300'), now: at, skipped: '2.1.300' })).toMatchObject({ state: 'skipped', latest: '2.1.300' })
    expect(await checkLatest(caps('claude', '2.1.291 (Claude Code)'), { fetchJson: feed('2.1.301'), now: at, skipped: '2.1.300' })).toMatchObject({ state: 'available', latest: '2.1.301' })
  })

  it('offline, rate limited, malformed or unknown is unavailable, never up to date', async () => {
    const check = (fetchJson: () => Promise<unknown>, agent: AgentId = 'claude') => checkLatest(caps(agent, '2.1.291 (Claude Code)'), { fetchJson, now: at })
    expect(await check(async () => { throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org') })).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/ENOTFOUND/) })
    expect(await check(async () => { throw Object.assign(new Error('HTTP 429'), { status: 429 }) })).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/429/) })
    expect(await check(async () => ({ version: 7 }))).toMatchObject({ state: 'unavailable' })
    expect(await check(async () => ({ version: '9.9.9' }), 'antigravity')).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/no version feed/) })
  })

  it('remembers a skipped version across restarts, per agent', SLOW, async () => {
    const ctx = agyInstalled()
    ctx.make().skip('claude', '2.1.300')
    expect(ctx.make().skipped('claude')).toBe('2.1.300')
    expect(ctx.make().skipped('codex')).toBeUndefined()
  })
})

describe('Claude Code launched by Cockpit', () => {
  it('does not update itself mid-session: Cockpit owns when it updates', () => {
    expect(claudeLaunchEnv(undefined)).toEqual({ DISABLE_AUTOUPDATER: '1' })
    expect(claudeLaunchEnv({ COCKPIT_MCP_TOKEN: 't' })).toEqual({ COCKPIT_MCP_TOKEN: 't', DISABLE_AUTOUPDATER: '1' })
  })
})

describe('the thread manager under a pending update (W10-07, CROSS-06)', () => {
  function fleet(gate?: (agent: AgentId) => string | undefined) {
    const store = createThreadStore(mkdtempSync(join(tmpdir(), 'cockpit-updates-threads-')))
    const emits = new Map<string, EventSink>()
    const closed: string[] = []
    let launches = 0
    const launcher = (agent: AgentId): Launcher => (request, onEvent) => {
      launches++
      emits.set(request.cwd, onEvent)
      let alive = true
      return { agent, send: () => undefined, respondApproval: () => undefined, interrupt: () => undefined, alive: () => alive,
        close: () => { alive = false; closed.push(request.cwd); onEvent({ kind: 'exit', code: 0 }); return Promise.resolve() } }
    }
    const manager = createThreadManager(store, { launchers: { antigravity: launcher('antigravity'), claude: launcher('claude') }, ...(gate ? { launchGate: gate } : {}) })
    const start = (projectPath: string, agent: AgentId) => manager.create({ projectPath, settings: threadSettingsSchema.parse({ agent }), text: 'go' })
    return { manager, store, emits, closed, start, launches: () => launches }
  }

  it('counts working and idle sessions of one CLI across projects, and closes only the idle ones', async () => {
    const f = fleet()
    f.start('/projects/one', 'antigravity')
    f.start('/projects/two', 'antigravity')
    f.start('/projects/three', 'claude')
    expect(f.manager.agentActivity('antigravity')).toEqual({ busy: 2, idle: 0 })
    f.emits.get('/projects/one')!({ kind: 'result', ok: true })
    expect(f.manager.agentActivity('antigravity')).toEqual({ busy: 1, idle: 1 })
    expect(f.manager.agentActivity('claude')).toEqual({ busy: 1, idle: 0 })
    await f.manager.closeIdleSessions('antigravity')
    expect(f.closed).toEqual(['/projects/one'])
    expect(f.manager.agentActivity('antigravity')).toEqual({ busy: 1, idle: 0 })
  })

  it('refuses a new session on a held CLI with the reason, without starting it, and lets other agents start', async () => {
    const f = fleet((agent) => (agent === 'antigravity' ? 'Antigravity is waiting to update' : undefined))
    const held = f.start('/projects/one', 'antigravity')
    expect(f.launches()).toBe(0)
    // Launch events are delivered after the launch call returns.
    await new Promise((r) => setTimeout(r, 0))
    const events = f.store.events(held.id).map((e) => e.event)
    expect(events).toContainEqual({ kind: 'error', message: 'Antigravity is waiting to update' })
    expect(events).toContainEqual(expect.objectContaining({ kind: 'result', ok: false, runId: expect.any(String) }))
    f.start('/projects/two', 'claude')
    expect(f.launches()).toBe(1)
  })
})
