import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AccountBusyError, AccountInUseError, createAccountService, type AccountSessions } from '../server/agents/accounts/service.ts'
import { defaultAccountId } from '../server/agents/accounts/types.ts'
import type { AgentId } from '../server/agents/types.ts'
import type { ResolvedAccount } from '../server/agents/accounts/types.ts'

// Order 16 account service with stand-in CLIs (scripts/fixtures/accounts-agent): sign-in in a fresh
// private context, failure and cancel leaving everything as it was (W12-04), selection refused
// while a conversation works, removal refused while in use, and supported sign-out before deletion.

const FIXTURE = resolve('scripts/fixtures/accounts-agent')
const TIMEOUT = 30_000

function setup(over: Partial<AccountSessions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-account-service-'))
  const home = join(root, 'home')
  for (const dir of [join(home, '.claude'), join(home, '.codex')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(home, '.claude', '.fixture-identity'), 'a@example.com 10\n')
  writeFileSync(join(home, '.codex', '.fixture-identity'), 'a@example.com 10\n')
  const calls: Array<{ kind: string; args: unknown[] }> = []
  const sessions: AccountSessions = {
    activity: () => ({ busy: 0, queued: 0 }),
    inUse: () => 0,
    closeIdle: async (...args: [string]) => { calls.push({ kind: 'closeIdle', args }) },
    rebindProject: async (...args: [string, AgentId, ResolvedAccount]) => { calls.push({ kind: 'rebind', args }) },
    identityChanged: async (...args: [string, ResolvedAccount, unknown?]) => { calls.push({ kind: 'identity', args }) },
    ...over,
  }
  const service = createAccountService({
    stateRoot: join(root, 'state'),
    executable: async (agent) => join(FIXTURE, agent),
    env: () => ({ PATH: process.env.PATH ?? '', HOME: home }),
    sessions,
    timeoutMs: { signin: 15_000, logout: 5_000 },
  })
  return { root, home, service, calls, state: join(root, 'state') }
}

async function until<T>(read: () => T | undefined, test: (value: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = read()
    if (value !== undefined && test(value)) return value
    if (Date.now() > end) throw new Error(`timed out; last ${JSON.stringify(value)}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}
const profiles = (state: string): string[] => (existsSync(join(state, 'account-profiles')) ? readdirSync(join(state, 'account-profiles')) : [])

describe('adding a profile (W12-01)', () => {
  it('Claude: the link is shown, the browser is not opened, the pasted code signs in the new context only', async () => {
    const { service, home, state } = setup()
    const started = await service.startSignin('claude', 'Account B')
    expect(started).toMatchObject({ state: 'waiting_for_user', takesCode: true })
    const shown = await until(() => service.signin(started.id), (v) => v.url !== undefined)
    expect(shown.url).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/)
    expect(service.signinInput(started.id, 'ok:b@example.com')).toBe(true)
    const done = await until(() => service.signin(started.id), (v) => v.state === 'verified' || v.state === 'error')
    expect(done.state).toBe('verified')
    expect(done.account).toMatchObject({ agent: 'claude', label: 'Account B', mode: 'managed', isolation: 'CLAUDE_CONFIG_DIR', identity: { hint: 'b…@example.com · pro' } })
    const dir = join(state, 'account-profiles', done.account!.id)
    expect(readFileSync(join(dir, '.fixture-browser'), 'utf8').trim()).toBe('/usr/bin/true')
    // The default login is exactly as it was; nothing was copied into the profile from it.
    expect(readFileSync(join(home, '.claude', '.fixture-identity'), 'utf8')).toBe('a@example.com 10\n')
    expect(readFileSync(join(dir, '.fixture-identity'), 'utf8')).toBe('b@example.com 12\n')
    // The code is never written to the log.
    const logs = readdirSync(join(state, 'account-signins')).map((f) => readFileSync(join(state, 'account-signins', f), 'utf8')).join('\n')
    expect(logs).not.toContain('ok:b@example.com')
    expect(JSON.stringify(service.list())).not.toContain(dir)
  }, TIMEOUT)

  it('Codex: finishes through its localhost callback; no code box', async () => {
    const { service, state } = setup()
    const started = await service.startSignin('codex', 'Second')
    expect(started.takesCode).toBe(false)
    await until(() => service.signin(started.id), (v) => v.url !== undefined)
    const [dir] = profiles(state)
    // What the browser finishing the sign-in does: the CLI's callback receives it.
    writeFileSync(join(state, 'account-profiles', dir!, '.fixture-callback'), 'ok:c@example.com\n')
    const done = await until(() => service.signin(started.id), (v) => Boolean(v.endedAt))
    expect(done).toMatchObject({ state: 'verified', account: { isolation: 'CODEX_HOME', identity: { hint: 'c…@example.com · plus' } } })
    expect(service.signinInput(started.id, 'anything')).toBe(false)
  }, TIMEOUT)

  it('Antigravity and OpenCode refuse with the reason; nothing is created', async () => {
    const { service, state } = setup()
    await expect(service.startSignin('antigravity', 'B')).rejects.toThrow(/no supported way to keep a second account separate/)
    await expect(service.startSignin('opencode', 'B')).rejects.toThrow(/no supported way/)
    expect(service.support.antigravity).toMatchObject({ profiles: false })
    expect(profiles(state)).toEqual([])
  })
})

describe('a failed or cancelled sign-in changes nothing (W12-04)', () => {
  it('a rejected code leaves no profile, no account and the selection unchanged', async () => {
    const { service, state, calls } = setup()
    const before = service.forProject('/p')
    const started = await service.startSignin('claude', 'Broken')
    await until(() => service.signin(started.id), (v) => v.url !== undefined)
    service.signinInput(started.id, 'nope')
    const done = await until(() => service.signin(started.id), (v) => Boolean(v.endedAt))
    expect(done.state).toBe('error')
    expect(done.message).toMatch(/No account was added and no project’s account changed/)
    expect(profiles(state)).toEqual([])
    expect(service.list().filter((a) => a.mode === 'managed')).toEqual([])
    expect(service.forProject('/p')).toEqual(before)
    expect(calls).toEqual([])
  }, TIMEOUT)

  it('Cancel ends the sign-in and discards its folder', async () => {
    const { service, state } = setup()
    const started = await service.startSignin('codex', 'Later')
    await until(() => service.signin(started.id), (v) => v.url !== undefined)
    expect(service.cancelSignin(started.id)).toBe(true)
    const done = await until(() => service.signin(started.id), (v) => Boolean(v.endedAt))
    expect(done.state).toBe('cancelled')
    expect(profiles(state)).toEqual([])
  }, TIMEOUT)
})

async function addClaude(service: ReturnType<typeof setup>['service'], label: string, email: string) {
  const started = await service.startSignin('claude', label)
  await until(() => service.signin(started.id), (v) => v.url !== undefined)
  service.signinInput(started.id, `ok:${email}`)
  const done = await until(() => service.signin(started.id), (v) => Boolean(v.endedAt))
  if (!done.account) throw new Error(done.message)
  return done.account
}

describe('choosing an account for a project (W12-02)', () => {
  it('changes an idle project and rebinds it; refuses while a conversation works or has a queued message', async () => {
    let activity = { busy: 0, queued: 0 }
    const { service, calls } = setup({ activity: () => activity })
    const b = await addClaude(service, 'B', 'b@example.com')
    expect((await service.select('/idle', 'claude', b.id)).claude).toBe(b.id)
    expect(calls).toMatchObject([{ kind: 'rebind', args: ['/idle', 'claude', { accountId: b.id, label: 'B' }] }])
    expect(service.resolve('/idle', 'claude').env).toHaveProperty('CLAUDE_CONFIG_DIR')
    expect(service.resolve('/other', 'claude').env).toEqual({})

    activity = { busy: 1, queued: 0 }
    await expect(service.select('/busy', 'claude', b.id)).rejects.toThrow(/still working/)
    activity = { busy: 0, queued: 1 }
    await expect(service.select('/busy', 'claude', b.id)).rejects.toBeInstanceOf(AccountBusyError)
    expect(service.forProject('/busy').claude).toBe(defaultAccountId('claude'))
    // Choosing what is already chosen is no change, even while busy.
    expect((await service.select('/busy', 'claude', defaultAccountId('claude'))).claude).toBe(defaultAccountId('claude'))
    await expect(service.select('/p', 'codex', b.id)).rejects.toThrow(/not a Codex account/)
  }, TIMEOUT)
})

describe('removing a profile (W12-04)', () => {
  it('refuses while running or chosen; moves projects to the default on request; signs out, then deletes', async () => {
    let inUse = 1
    const { service, state } = setup({ inUse: () => inUse })
    const b = await addClaude(service, 'B', 'b@example.com')
    await service.select('/p', 'claude', b.id)
    await expect(service.remove(b.id)).rejects.toThrow(/1 conversation is running on “B”/)
    inUse = 0
    const refusal = await service.remove(b.id).catch((e: unknown) => e)
    expect(refusal).toBeInstanceOf(AccountInUseError)
    expect((refusal as AccountInUseError).projects).toEqual(['/p'])
    await expect(service.remove(defaultAccountId('claude'))).rejects.toThrow(/not something Cockpit removes/)

    const result = await service.remove(b.id, { moveProjectsToDefault: true })
    expect(result.message).toMatch(/signed out in its own context/)
    expect(service.forProject('/p').claude).toBe(defaultAccountId('claude'))
    expect(profiles(state)).toEqual([])
    expect(service.list().some((a) => a.id === b.id)).toBe(false)
  }, TIMEOUT)

  it('keeps the profile when the CLI cannot sign it out, and says what to run', async () => {
    const { service, state } = setup()
    const b = await addClaude(service, 'B', 'b@example.com')
    writeFileSync(join(state, 'account-profiles', b.id, '.fixture-logout-fails'), '')
    await expect(service.remove(b.id)).rejects.toThrow(/could not sign that profile out.*CLAUDE_CONFIG_DIR=".*" claude auth logout/)
    expect(profiles(state)).toEqual([b.id])
    expect(service.list().some((a) => a.id === b.id)).toBe(true)
  }, TIMEOUT)
})

describe('the default identity changes outside Cockpit (W12-04)', () => {
  it('a recheck starts a new generation and tells the manager; unknown is shown as unknown', async () => {
    const { service, home, calls } = setup()
    await service.refreshDefaults()
    const first = service.list().find((a) => a.id === defaultAccountId('claude'))!
    expect(first).toMatchObject({ generation: 1, identity: { state: 'known', hint: 'a…@example.com · pro' } })
    expect(calls).toEqual([])

    writeFileSync(join(home, '.claude', '.fixture-identity'), 'z@example.com 50\n')
    const changed = await service.refresh(defaultAccountId('claude'))
    expect(changed).toMatchObject({ changed: true, account: { generation: 2, identity: { hint: 'z…@example.com · pro' } } })
    expect(calls).toMatchObject([{ kind: 'identity', args: [defaultAccountId('claude'), { generation: 2 }, { hint: 'a…@example.com · pro' }] }])
    expect(service.defaultUsageKey('claude')).toBe(`${defaultAccountId('claude')}#2`)

    writeFileSync(join(home, '.claude', '.fixture-identity'), '')
    const gone = await service.refresh(defaultAccountId('claude'))
    expect(gone.account).toMatchObject({ generation: 3, identity: { state: 'unknown' } })
    expect(service.describe(defaultAccountId('claude'))).toEqual({ id: defaultAccountId('claude'), label: 'CLI default' })
  }, TIMEOUT)
})
