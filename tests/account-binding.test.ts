import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolved } from '../server/agents/accounts/env.ts'
import { createAccountStore, type AccountStore } from '../server/agents/accounts/store.ts'
import { defaultAccountId, type IdentityObservation } from '../server/agents/accounts/types.ts'
import { createAgentStatus, fixedCapabilities, latestUsageByAccount } from '../server/agents/status.ts'
import type { AgentSession, EventSink } from '../server/agents/types.ts'
import { createThreadManager, ThreadBusyError, type AccountBinding, type LaunchRequest, type Launcher } from '../server/threads/manager.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'

// Order 16 launch isolation in the thread manager (W12-01–W12-03): every launch runs under the
// project's account, a running conversation keeps the account it started with, and a conversation
// continued on another account starts fresh with a labelled handoff, never resuming the old session.

interface Launch { readonly request: LaunchRequest; readonly emit: EventSink; alive: boolean }

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-account-binding-'))
  const store = createThreadStore(join(root, 'threads'))
  const accounts = createAccountStore(root)
  const launches: Launch[] = []
  const launcher: Launcher = (request, onEvent) => {
    const launch: Launch = { request, emit: onEvent, alive: true }
    launches.push(launch)
    const session: AgentSession = {
      agent: 'claude', send: () => undefined, respondApproval: () => undefined, interrupt: () => undefined,
      queues: () => true, cancelQueued: () => Promise.resolve(true),
      close: () => { if (launch.alive) { launch.alive = false; onEvent({ kind: 'exit', code: 0 }) } return Promise.resolve() },
      alive: () => launch.alive,
    }
    return session
  }
  const binding = bindingFor(accounts, root)
  const manager = createThreadManager(store, { launchers: { claude: launcher, codex: launcher }, accounts: binding })
  const settings = threadSettingsSchema.parse({})
  return { root, store, accounts, manager, launches, settings }
}

function bindingFor(accounts: AccountStore, root: string): AccountBinding {
  return {
    resolve(projectPath, agent) {
      const account = accounts.selected(projectPath, agent)
      return resolved(account, account.mode === 'managed' ? join(root, 'account-profiles', account.id) : undefined)
    },
    describe(id) {
      const account = accounts.get(id)
      return account ? { id, label: account.label, ...(account.identity?.hint ? { hint: account.identity.hint } : {}) } : undefined
    },
  }
}

const known = (key: string, hint: string): IdentityObservation => ({ state: 'known', key, hint, observedAt: new Date().toISOString(), source: 'claude auth status' })

/** One finished turn on the latest launch: provider evidence makes the session resumable. */
function finishTurn(launch: Launch, sessionId: string): void {
  launch.emit({ kind: 'session', sessionId })
  launch.emit({ kind: 'assistant_text', messageId: 'm', text: 'done' })
  launch.emit({ kind: 'result', ok: true })
}

describe('launch under the project account (W12-01)', () => {
  it('a profile adds its context variable and is recorded on the binding; the default adds nothing', () => {
    const { manager, accounts, launches, settings, store, root } = setup()
    const b = accounts.createManaged('claude', 'Account B', known('kb', 'b…@example.com · pro'))
    accounts.select('/b', 'claude', b.id)
    const onA = manager.create({ projectPath: '/a', settings, text: 'on the default' })
    const onB = manager.create({ projectPath: '/b', settings, text: 'on B' })
    expect(launches[0]!.request.accountEnv).toBeUndefined()
    expect(launches[1]!.request.accountEnv).toEqual({ CLAUDE_CONFIG_DIR: join(root, 'account-profiles', b.id) })
    expect(launches[1]!.request.accountEnv).not.toHaveProperty('HOME')
    expect(store.get(onA.id)).toMatchObject({ accountId: defaultAccountId('claude'), accountGeneration: 1 })
    expect(store.get(onB.id)).toMatchObject({ accountId: b.id, accountGeneration: 1 })
    const boundary = store.events(onB.id).find((e) => e.event.kind === 'session_boundary')?.event
    expect(boundary).toMatchObject({ account: { id: b.id, generation: 1 } })
    // Both run at once, each in its own context.
    expect(manager.accountSessions(b.id)).toBe(1)
    expect(manager.accountSessions(defaultAccountId('claude'))).toBe(1)
  })
})

describe('sessions on an account, for removal (W12-04)', () => {
  it('only working conversations count as in use; idle ones are closed before its context is signed out', async () => {
    const { manager, accounts, launches, settings } = setup()
    const b = accounts.createManaged('claude', 'B', known('kb', 'b…'))
    accounts.select('/p', 'claude', b.id)
    const meta = manager.create({ projectPath: '/p', settings, text: 'work' })
    expect(manager.accountSessions(b.id)).toBe(1)
    finishTurn(launches[0]!, meta.sessionId)
    expect(manager.accountSessions(b.id)).toBe(0)
    expect(launches[0]!.alive).toBe(true)
    await manager.closeAccountSessions(b.id)
    expect(launches[0]!.alive).toBe(false)
  })
})

describe('changing one project while another works (W12-02)', () => {
  it('the idle project changes; the working one keeps its account and refuses a change until it is idle', async () => {
    const { manager, accounts, launches, settings, store } = setup()
    const b = accounts.createManaged('claude', 'Account B', known('kb', 'b…'))
    const working = manager.create({ projectPath: '/busy', settings, text: 'long task' })
    const idle = manager.create({ projectPath: '/idle', settings, text: 'short task' })
    finishTurn(launches[1]!, idle.sessionId)
    expect(manager.accountActivity('/busy', 'claude')).toEqual({ busy: 1, queued: 0 })
    expect(manager.accountActivity('/idle', 'claude')).toEqual({ busy: 0, queued: 0 })

    accounts.select('/idle', 'claude', b.id)
    await manager.rebindProject('/idle', 'claude', bindingFor(accounts, '/r').resolve('/idle', 'claude'))
    expect(launches[0]!.alive).toBe(true)
    expect(launches[1]!.alive).toBe(false)
    expect(store.get(working.id)?.accountId).toBe(defaultAccountId('claude'))

    // The working project cannot change under its running turn.
    await expect(manager.rebindProject('/busy', 'claude', bindingFor(accounts, '/r').resolve('/idle', 'claude'))).rejects.toBeInstanceOf(ThreadBusyError)
    expect(launches[0]!.alive).toBe(true)
  })

  it('a queued message blocks the change until it is sent or taken back', async () => {
    const { manager, accounts, launches, settings } = setup()
    const meta = manager.create({ projectPath: '/q', settings, text: 'first' })
    manager.send(meta.id, 'queued while working')
    expect(manager.accountActivity('/q', 'claude').queued).toBe(1)
    finishTurn(launches[0]!, meta.sessionId)
    // The result came while a message still waited: still blocked.
    expect(manager.accountActivity('/q', 'claude')).toMatchObject({ queued: 1 })
    const b = accounts.createManaged('claude', 'B', known('kb', 'b…'))
    await expect(manager.rebindProject('/q', 'claude', { accountId: b.id, generation: 1, label: 'B', env: {} })).rejects.toBeInstanceOf(ThreadBusyError)
  })
})

describe('continuing after an account switch (W12-03)', () => {
  it('records the change, then starts a fresh session on the new account with the conversation as a handoff', async () => {
    const { manager, accounts, launches, settings, store, root } = setup()
    accounts.observe(defaultAccountId('claude'), known('ka', 'a…@example.com · pro'))
    const meta = manager.create({ projectPath: '/p', settings, text: 'TASK: port the parser' })
    finishTurn(launches[0]!, meta.sessionId)
    const b = accounts.createManaged('claude', 'Account B', known('kb', 'b…@example.com · pro'))
    accounts.select('/p', 'claude', b.id)
    await manager.rebindProject('/p', 'claude', bindingFor(accounts, root).resolve('/p', 'claude'))

    const change = store.events(meta.id).find((e) => e.event.kind === 'account_changed')?.event
    expect(change).toEqual({ kind: 'account_changed', agent: 'claude', reason: 'selected', handoff: true,
      from: { id: defaultAccountId('claude'), label: 'CLI default', hint: 'a…@example.com · pro' },
      to: { id: b.id, label: 'Account B', hint: 'b…@example.com · pro' } })

    manager.send(meta.id, 'carry on')
    const next = launches[1]!.request
    expect(next.resume).toBeUndefined()
    expect(next.sessionId).not.toBe(meta.sessionId)
    expect(next.seed).toContain('USER: TASK: port the parser')
    expect(next.accountEnv).toEqual({ CLAUDE_CONFIG_DIR: join(root, 'account-profiles', b.id) })
    // The change shows before the message it applies to.
    const kinds = store.events(meta.id).map((e) => e.event.kind)
    expect(kinds.indexOf('account_changed')).toBeLessThan(kinds.lastIndexOf('user_text'))
  })

  it('never resumes under another account even if nothing rebound it first', () => {
    const { manager, accounts, launches, settings, store } = setup()
    const meta = manager.create({ projectPath: '/p', settings, text: 'TASK: one' })
    finishTurn(launches[0]!, meta.sessionId)
    launches[0]!.emit({ kind: 'exit', code: 0 })
    const b = accounts.createManaged('claude', 'B', known('kb', 'b…'))
    accounts.select('/p', 'claude', b.id)
    manager.send(meta.id, 'two')
    expect(launches[1]!.request.resume).toBeUndefined()
    expect(launches[1]!.request.seed).toContain('USER: TASK: one')
    expect(store.events(meta.id).some((e) => e.event.kind === 'account_changed')).toBe(true)
  })

  it('a conversation that never started has nothing to hand over and records nothing', async () => {
    const { manager, accounts, launches, settings, store, root } = setup()
    const meta = manager.create({ projectPath: '/p', settings, text: 'hello' })
    launches[0]!.emit({ kind: 'result', ok: false })
    const b = accounts.createManaged('claude', 'B', known('kb', 'b…'))
    accounts.select('/p', 'claude', b.id)
    await manager.rebindProject('/p', 'claude', bindingFor(accounts, root).resolve('/p', 'claude'))
    expect(store.events(meta.id).some((e) => e.event.kind === 'account_changed')).toBe(false)
    manager.send(meta.id, 'again')
    expect(launches[1]!.request.accountEnv).toBeDefined()
  })
})

describe('the default identity changed outside Cockpit (W12-04)', () => {
  it('idle conversations are told and continue fresh; the working one is not interrupted', async () => {
    const { manager, accounts, launches, settings, store, root } = setup()
    const id = defaultAccountId('claude')
    accounts.observe(id, known('ka', 'a…'))
    const idle = manager.create({ projectPath: '/p', settings, text: 'TASK: idle one' })
    finishTurn(launches[0]!, idle.sessionId)
    const working = manager.create({ projectPath: '/p', settings, text: 'TASK: working one' })
    const { account } = accounts.observe(id, known('kz', 'z…'))
    expect(account.generation).toBe(2)
    await manager.identityChanged(id, bindingFor(accounts, root).resolve('/p', 'claude'))
    expect(store.events(idle.id).find((e) => e.event.kind === 'account_changed')?.event).toMatchObject({ reason: 'identity_changed', to: { hint: 'z…' } })
    expect(store.events(working.id).some((e) => e.event.kind === 'account_changed')).toBe(false)
    expect(launches[1]!.alive).toBe(true)
    manager.send(idle.id, 'next')
    expect(launches[2]!.request.resume).toBeUndefined()
    expect(store.get(idle.id)).toMatchObject({ accountGeneration: 2 })
  })
})

describe('usage per account generation (W12-02)', () => {
  it('one account’s report is never shown as another’s, nor an older identity’s as the current one’s', async () => {
    const { manager, accounts, launches, settings, store, root } = setup()
    const meta = manager.create({ projectPath: '/p', settings, text: 'on default' })
    launches[0]!.emit({ kind: 'usage', limitType: 'five_hour', status: 'allowed', usedPercent: 12 })
    finishTurn(launches[0]!, meta.sessionId)
    const b = accounts.createManaged('claude', 'B', known('kb', 'b…'))
    accounts.select('/p', 'claude', b.id)
    await manager.rebindProject('/p', 'claude', bindingFor(accounts, root).resolve('/p', 'claude'))
    manager.send(meta.id, 'on B')
    launches[1]!.emit({ kind: 'usage', limitType: 'five_hour', status: 'allowed', usedPercent: 67 })
    const { byAccount } = latestUsageByAccount(store)
    expect(byAccount.claude?.[`${defaultAccountId('claude')}#1`]?.usedPercent).toBe(12)
    expect(byAccount.claude?.[`${b.id}#1`]?.usedPercent).toBe(67)

    const status = createAgentStatus(store, fixedCapabilities(async () => ({ installed: true, version: '1' })), undefined, (agent) => `${defaultAccountId(agent)}#2`)
    const claude = (await status()).find((s) => s.id === 'claude')!
    // The default is on a new identity now: its old 12% is not its allowance.
    expect(claude.usage).toBeUndefined()
    expect(claude.usageByAccount?.[`${b.id}#1`]?.usedPercent).toBe(67)
  })
})
