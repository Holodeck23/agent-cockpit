import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { accountEnv } from '../server/agents/accounts/env.ts'
import { claudeIdentityFrom, codexIdentityFrom, emailHint, observeIdentity } from '../server/agents/accounts/identity.ts'
import { createAccountStore, nextGeneration } from '../server/agents/accounts/store.ts'
import { defaultAccountId, viewOf, type IdentityObservation } from '../server/agents/accounts/types.ts'
import { StoreReadError } from '../server/state/read-error.ts'

// Order 16 storage and launch isolation (W12.1, G-ACCOUNTS): records, the one selection per
// project and agent, identity generations, and the environment that isolates a profile.

const FIXTURE = resolve('scripts/fixtures/accounts-agent')
const known = (key: string, hint = 'a…@example.com'): IdentityObservation => ({ state: 'known', key, hint, observedAt: new Date().toISOString(), source: 'claude auth status' })
const unknown: IdentityObservation = { state: 'unknown', observedAt: new Date().toISOString(), source: 'claude auth status', reason: 'offline' }
const FIRST_RUN = 20_000

describe('account store', () => {
  it('always has a CLI default per agent, and an unset selection is the default', () => {
    const store = createAccountStore(mkdtempSync(join(tmpdir(), 'cockpit-accounts-')))
    expect(store.list().filter((a) => a.mode === 'default').map((a) => a.agent).sort()).toEqual(['antigravity', 'claude', 'codex', 'opencode'])
    expect(store.selected('/p', 'claude').id).toBe(defaultAccountId('claude'))
  })

  it('remembers one choice per project and agent, shared by every reader', () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-accounts-'))
    const store = createAccountStore(root)
    const work = store.createManaged('claude', 'Work', known('k1'))
    store.select('/a', 'claude', work.id)
    // A second store over the same file (the picker and project settings) sees the same choice.
    const other = createAccountStore(root)
    expect(other.selected('/a', 'claude').id).toBe(work.id)
    expect(other.selected('/b', 'claude').id).toBe(defaultAccountId('claude'))
    expect(other.selected('/a', 'codex').id).toBe(defaultAccountId('codex'))
    store.select('/a', 'claude', defaultAccountId('claude'))
    expect(other.selections()).toEqual({})
  })

  it('keeps profile folders private and refuses to name a folder for anything but a profile ID', () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-accounts-'))
    const store = createAccountStore(root)
    const id = '11111111-2222-4333-8444-555555555555'
    const dir = store.prepareProfileDir(id)
    expect(dir).toBe(join(root, 'account-profiles', id))
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(root, 'account-profiles')).mode & 0o777).toBe(0o700)
    expect(() => store.profileDir('../../etc')).toThrow(/Not a managed profile/)
    expect(() => store.profileDir(defaultAccountId('claude'))).toThrow(/Not a managed profile/)
    store.deleteProfileDir(id)
    expect(existsSync(dir)).toBe(false)
  })

  it('never shows the identity key or a folder to a client', () => {
    const store = createAccountStore(mkdtempSync(join(tmpdir(), 'cockpit-accounts-')))
    const view = viewOf(store.createManaged('codex', 'Second', { ...known('secret-key'), source: 'codex account/read' }))
    expect(JSON.stringify(view)).not.toContain('secret-key')
    expect(view).toMatchObject({ agent: 'codex', label: 'Second', isolation: 'CODEX_HOME', usageKey: `${view.id}#1` })
  })

  it('leaves an unreadable or newer file untouched instead of starting empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-accounts-'))
    writeFileSync(join(root, 'accounts.json'), '{oops')
    expect(() => createAccountStore(root).list()).toThrow(StoreReadError)
    writeFileSync(join(root, 'accounts.json'), JSON.stringify({ version: 99, revision: 0, accounts: [], selections: {} }))
    expect(() => createAccountStore(root).select('/p', 'claude', 'x')).toThrow(/newer Cockpit/)
    expect(JSON.parse(readFileSync(join(root, 'accounts.json'), 'utf8')).version).toBe(99)
  })
})

describe('identity generations', () => {
  it('the first identity is generation 1; a different one or an unknown starts a new generation', () => {
    const store = createAccountStore(mkdtempSync(join(tmpdir(), 'cockpit-accounts-')))
    const id = defaultAccountId('claude')
    expect(store.observe(id, known('A')).account.generation).toBe(1)
    expect(store.observe(id, known('A'))).toMatchObject({ changed: false, account: { generation: 1 } })
    expect(store.observe(id, known('B'))).toMatchObject({ changed: true, account: { generation: 2 } })
    // Unknown is labelled unknown and never counted as the previous account.
    expect(store.observe(id, unknown)).toMatchObject({ changed: true, account: { generation: 3, identity: { state: 'unknown' } } })
    expect(store.observe(id, unknown)).toMatchObject({ changed: false, account: { generation: 3 } })
    // Back to the same account as before the unknown: nothing new to attribute.
    expect(store.observe(id, known('B'))).toMatchObject({ changed: false, account: { generation: 3 } })
    expect(store.observe(id, known('A'))).toMatchObject({ changed: true, account: { generation: 4 } })
  })

  it('a never-identified account seen unknown first stays generation 1', () => {
    const base = { id: 'default-codex', agent: 'codex', label: 'CLI default', mode: 'default', isolation: 'none', generation: 1, createdAt: '', revision: 1 } as const
    expect(nextGeneration(base, unknown)).toMatchObject({ generation: 1, changed: false })
  })
})

describe('identity reports', () => {
  it('Claude: hashes email and org, keeps only a hint', () => {
    const seen = claudeIdentityFrom(JSON.stringify({ loggedIn: true, email: 'Dana@Example.com', orgId: 'org-1', subscriptionType: 'pro' }))
    expect(seen).toMatchObject({ state: 'known', hint: 'd…@example.com · pro', source: 'claude auth status' })
    expect(seen.key).toMatch(/^[0-9a-f]{10}:[0-9a-f]{10}$/)
    expect(JSON.stringify(seen)).not.toContain('dana@')
    expect(claudeIdentityFrom('{"loggedIn":false}')).toMatchObject({ state: 'unknown' })
    expect(claudeIdentityFrom('not json')).toMatchObject({ state: 'unknown' })
  })

  it('Codex: reads account/read, unknown without an email', () => {
    expect(codexIdentityFrom({ account: { type: 'chatgpt', email: 'b@example.com', planType: 'plus' } })).toMatchObject({ state: 'known', hint: 'b…@example.com · plus' })
    expect(codexIdentityFrom({ account: null })).toMatchObject({ state: 'unknown' })
    expect(emailHint('nobody')).toBe('…')
  })

  it('reads each context separately through the real probes (stand-in CLIs)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-accounts-probe-'))
    const home = join(root, 'home'), profile = join(root, 'profile')
    for (const dir of [join(home, '.claude'), join(home, '.codex'), profile]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(home, '.claude', '.fixture-identity'), 'a@example.com 10\n')
    writeFileSync(join(home, '.codex', '.fixture-identity'), 'a@example.com 10\n')
    writeFileSync(join(profile, '.fixture-identity'), 'b@example.com 67\n')
    const env = { PATH: process.env.PATH ?? '', HOME: home }
    const claudeA = await observeIdentity('claude', { executable: join(FIXTURE, 'claude'), env })
    const claudeB = await observeIdentity('claude', { executable: join(FIXTURE, 'claude'), env: { ...env, CLAUDE_CONFIG_DIR: profile } })
    const codexA = await observeIdentity('codex', { executable: join(FIXTURE, 'codex'), env })
    const codexB = await observeIdentity('codex', { executable: join(FIXTURE, 'codex'), env: { ...env, CODEX_HOME: profile } })
    expect(claudeA.hint).toBe('a…@example.com · pro')
    expect(claudeB.hint).toBe('b…@example.com · pro')
    expect(claudeA.key).not.toBe(claudeB.key)
    expect(codexA.hint).toBe('a…@example.com · plus')
    expect(codexB.hint).toBe('b…@example.com · plus')
    const missing = await observeIdentity('codex', { executable: join(root, 'no-such-codex'), env })
    expect(missing).toMatchObject({ state: 'unknown' })
  }, FIRST_RUN)
})

describe('launch environment', () => {
  it('a profile adds only its context variable; the default adds nothing and HOME is never set', () => {
    const store = createAccountStore(mkdtempSync(join(tmpdir(), 'cockpit-accounts-')))
    const claude = store.createManaged('claude', 'B', known('k'))
    const codex = store.createManaged('codex', 'B', { ...known('k'), source: 'codex account/read' })
    expect(accountEnv(claude, '/x/claude-b')).toEqual({ CLAUDE_CONFIG_DIR: '/x/claude-b' })
    expect(accountEnv(codex, '/x/codex-b')).toEqual({ CODEX_HOME: '/x/codex-b' })
    expect(accountEnv(store.get(defaultAccountId('claude'))!, undefined)).toEqual({})
    expect(() => store.createManaged('antigravity', 'B', known('k'))).toThrow(/no supported account profiles/)
  })
})
