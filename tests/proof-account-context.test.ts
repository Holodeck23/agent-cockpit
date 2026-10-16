import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { proofAccountContext } from '../electron/proof-account-context.ts'
import { createAccountStore } from '../server/agents/accounts/store.ts'
import { defaultAccountId, type IdentityObservation } from '../server/agents/accounts/types.ts'

// W13 U1: a proof borrows one established managed Claude login by its literal profile path, with
// all Cockpit metadata in disposable state. Release builds ignore the seam entirely.

const known = (key: string, source: IdentityObservation['source'] = 'claude auth status'): IdentityObservation =>
  ({ state: 'known', key, hint: 'a…@example.com · pro', observedAt: new Date().toISOString(), source })

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-proof-account-')))
  const home = join(root, 'home')
  const sourceRoot = join(home, '.agent-cockpit')
  const store = createAccountStore(sourceRoot)
  const work = store.createManaged('claude', 'Work', known('key-work'))
  const other = store.createManaged('claude', 'Other', known('key-other'))
  const codex = store.createManaged('codex', 'Codex', known('key-codex', 'codex account/read'))
  for (const account of [work, other, codex]) store.prepareProfileDir(account.id)
  const state = join(root, 'state')
  mkdirSync(state)
  const registry = (): string => readFileSync(join(sourceRoot, 'accounts.json'), 'utf8')
  return { root, home, sourceRoot, store, work, other, codex, state, registry }
}
const borrow = (id: string) => ({ COCKPIT_PROOF_ACCOUNT_ID: id })

describe('proof account context (W13 U1)', () => {
  it('is ignored without an ID and in release builds, even with an ID that would otherwise be refused', () => {
    const { home, sourceRoot, state, work } = setup()
    expect(proofAccountContext(state, false, {}, home)).toBeUndefined()
    expect(proofAccountContext(state, true, borrow(work.id), home)).toBeUndefined()
    expect(proofAccountContext(sourceRoot, true, borrow('not-an-id'), home)).toBeUndefined()
  })

  it('borrows exactly the named account of two, without touching the real registry', () => {
    const { home, state, work, other, registry } = setup()
    const before = registry()
    const context = proofAccountContext(state, false, borrow(other.id), home)!
    expect(context).toMatchObject({ accountId: other.id, generation: other.generation, identityKey: 'key-other' })
    expect(context.profileDir).toBe(join(home, '.agent-cockpit', 'account-profiles', other.id))
    expect(context.profileDir).not.toContain(work.id)
    context.validate()
    expect(registry()).toBe(before)
  })

  it('keeps the literal profile path when the home is reached through a link', () => {
    const { root, home, state, work } = setup()
    const linkedHome = join(root, 'linked-home')
    symlinkSync(home, linkedHome)
    const context = proofAccountContext(state, false, borrow(work.id), linkedHome)!
    // Not realpath-normalized: the CLI keys its credentials on the literal path.
    expect(context.profileDir).toBe(join(linkedHome, '.agent-cockpit', 'account-profiles', work.id))
  })

  it('refuses a missing or linked profile folder with an error that says to stop', () => {
    const { root, home, state, work, other, store } = setup()
    store.deleteProfileDir(work.id)
    expect(() => proofAccountContext(state, false, borrow(work.id), home)).toThrow(/^Proof account: the borrowed profile folder .* does not exist\. Stop this proof; do not sign in or switch accounts\.$/)
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    rmSync(store.profileDir(other.id), { recursive: true })
    symlinkSync(elsewhere, store.profileDir(other.id))
    expect(() => proofAccountContext(state, false, borrow(other.id), home)).toThrow(/is not a plain folder/)
  })

  it('refuses accounts that are not a settled managed Claude login', () => {
    const { home, state, codex, work, store } = setup()
    expect(() => proofAccountContext(state, false, borrow('not-an-id'), home)).toThrow(/is not an account ID/)
    expect(() => proofAccountContext(state, false, borrow('00000000-0000-4000-8000-000000000000'), home)).toThrow(/no account/)
    expect(() => proofAccountContext(state, false, borrow(codex.id), home)).toThrow(/not a managed Claude profile/)
    // The CLI default is never borrowable: it has no Cockpit-owned profile folder.
    expect(() => proofAccountContext(state, false, borrow(defaultAccountId('claude')), home)).toThrow(/is not an account ID/)
    store.observe(work.id, { state: 'unknown', observedAt: new Date().toISOString(), source: 'claude auth status', reason: 'signed out' })
    expect(() => proofAccountContext(state, false, borrow(work.id), home)).toThrow(/no settled known identity/)
  })

  it('refuses real or missing state folders with clear startup errors', () => {
    const { root, home, sourceRoot, work } = setup()
    expect(() => proofAccountContext(sourceRoot, false, borrow(work.id), home)).toThrow(/must be a disposable folder/)
    const linkedState = join(root, 'linked-state')
    symlinkSync(sourceRoot, linkedState)
    expect(() => proofAccountContext(linkedState, false, borrow(work.id), home)).toThrow(/must be a disposable folder/)
    expect(() => proofAccountContext(join(root, 'missing'), false, borrow(work.id), home)).toThrow(/disposable state folder .* does not exist/)
    expect(() => proofAccountContext(join(root, 'missing'), false, borrow(work.id), join(root, 'nobody'))).toThrow(/account folder .* does not exist/)
  })

  it('stops when the real account changes identity or loses its folder after the proof started', () => {
    const first = setup()
    const context = proofAccountContext(first.state, false, borrow(first.work.id), first.home)!
    first.store.observe(first.work.id, known('key-someone-else'))
    expect(() => context.validate()).toThrow(/changed in .* since the proof started/)

    const second = setup()
    const again = proofAccountContext(second.state, false, borrow(second.work.id), second.home)!
    second.store.deleteProfileDir(second.work.id)
    expect(() => again.validate()).toThrow(/does not exist/)
  })
})
