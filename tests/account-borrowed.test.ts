import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { proofAccountContext } from '../electron/proof-account-context.ts'
import { AccountInUseError, createAccountService, type AccountSessions, type BorrowedAccountContext } from '../server/agents/accounts/service.ts'
import { createAccountStore } from '../server/agents/accounts/store.ts'
import { defaultAccountId } from '../server/agents/accounts/types.ts'

// W13 U1: the account service running on a borrowed proof login. The real login is established the
// way a user's is (a fixture sign-in into ~/.agent-cockpit); the proof's own metadata is a disposable
// copy of that one record. Only the borrowed account resolves; Cockpit never writes to the real
// registry or profile. The CLI may write its own session data there, which is not Cockpit's doing.

const FIXTURE = resolve('scripts/fixtures/accounts-agent')
const TIMEOUT = 30_000

const sessions: AccountSessions = {
  activity: () => ({ busy: 0, queued: 0 }),
  inUse: () => 0,
  closeIdle: async () => {},
  rebindProject: async () => {},
  identityChanged: async () => {},
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

/** Every entry under a folder, with file hashes and link targets, so any write shows as a difference. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (at: string, rel: string): void => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name), key = join(rel, name), entry = lstatSync(path)
      if (entry.isSymbolicLink()) out[key] = `link:${readlinkSync(path)}`
      else if (entry.isDirectory()) { out[key] = 'dir'; walk(path, key) }
      else out[key] = `file:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
    }
  }
  walk(dir, '')
  return out
}

function service(stateRoot: string, home: string, borrowedContext?: BorrowedAccountContext) {
  return createAccountService({
    stateRoot,
    ...(borrowedContext ? { borrowedContext } : {}),
    executable: async (agent) => join(FIXTURE, agent),
    env: () => ({ PATH: process.env.PATH ?? '', HOME: home }),
    homeDir: home,
    sessions,
    timeoutMs: { signin: 15_000, logout: 5_000 },
  })
}

/** A user's real Cockpit with two signed-in Claude profiles, then a disposable proof state borrowing one. */
async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-account-borrowed-')))
  const home = join(root, 'home')
  for (const dir of [join(home, '.claude'), join(home, '.codex')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(home, '.claude', '.fixture-identity'), 'default@example.com 10\n')
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'shared Claude rules\n')
  const sourceRoot = join(home, '.agent-cockpit')
  const real = service(sourceRoot, home)
  const signIn = async (label: string, email: string): Promise<string> => {
    const started = await real.startSignin('claude', label)
    await until(() => real.signin(started.id), (v) => v.url !== undefined)
    real.signinInput(started.id, `ok:${email}`)
    const done = await until(() => real.signin(started.id), (v) => Boolean(v.endedAt))
    expect(done.state).toBe('verified')
    return done.account!.id
  }
  const workId = await signIn('Work', 'work@example.com')
  const otherId = await signIn('Other', 'other@example.com')
  await real.shutdown()

  const source = createAccountStore(sourceRoot)
  const state = join(root, 'state')
  const project = join(root, 'project'), otherProject = join(root, 'other-project')
  // What the proof script seeds: copies of the real records, no profile folders, no links.
  mkdirSync(state, { recursive: true, mode: 0o700 })
  writeFileSync(join(state, 'accounts.json'), JSON.stringify({ version: 1, revision: 1,
    accounts: [source.get(workId), source.get(otherId)],
    selections: { [project]: { claude: workId }, [otherProject]: { claude: otherId } } }), { mode: 0o600 })
  const profile = source.profileDir(workId)
  const registry = (): string => readFileSync(join(sourceRoot, 'accounts.json'), 'utf8')
  return { root, home, sourceRoot, source, state, project, otherProject, workId, otherId, profile, registry }
}

describe('a borrowed proof account (W13 U1)', () => {
  it('resolves to the literal real profile, checks its identity there, and changes nothing Cockpit owns', async () => {
    const s = await setup()
    const registryBefore = s.registry(), profileBefore = snapshot(s.profile)
    const context = proofAccountContext(s.state, false, { COCKPIT_PROOF_ACCOUNT_ID: s.workId }, s.home)!
    const proof = service(s.state, s.home, context)

    const resolved = proof.resolve(s.project, 'claude')
    expect(resolved).toMatchObject({ accountId: s.workId, generation: 1, env: { CLAUDE_CONFIG_DIR: join(s.home, '.agent-cockpit', 'account-profiles', s.workId) } })
    // The CLI in the borrowed profile still reports the same login, so the generation holds.
    await expect(proof.refresh(s.workId)).resolves.toMatchObject({ changed: false, account: { id: s.workId, generation: 1 } })
    await proof.refreshDefaults()
    await expect(proof.select(s.project, 'claude', s.workId)).resolves.toMatchObject({ claude: s.workId })

    expect(s.registry()).toBe(registryBefore)
    // No instruction links, no new files: the fixture CLI's status check writes nothing of its own.
    expect(snapshot(s.profile)).toEqual(profileBefore)
    expect(existsSync(join(s.profile, 'CLAUDE.md'))).toBe(false)
    expect(existsSync(join(s.state, 'account-profiles'))).toBe(false)
    expect(readFileSync(join(s.home, '.claude', '.fixture-identity'), 'utf8')).toBe('default@example.com 10\n')
  }, TIMEOUT)

  it('control: the same resolve without borrowing does link instructions, so the check above can see a write', async () => {
    const s = await setup()
    s.source.select(s.project, 'claude', s.workId)
    const before = snapshot(s.profile)
    expect(service(s.sourceRoot, s.home).resolve(s.project, 'claude').accountId).toBe(s.workId)
    expect(snapshot(s.profile)).not.toEqual(before)
    expect(lstatSync(join(s.profile, 'CLAUDE.md')).isSymbolicLink()).toBe(true)
  }, TIMEOUT)

  it('blocks every other account with an error that names it, and refuses sign-in and removal', async () => {
    const s = await setup()
    const registryBefore = s.registry()
    const proof = service(s.state, s.home, proofAccountContext(s.state, false, { COCKPIT_PROOF_ACCOUNT_ID: s.workId }, s.home))
    expect(() => proof.resolve(s.otherProject, 'claude')).toThrow('Proof mode: only the borrowed account can run here, so “Other” (Claude Code) is blocked')
    expect(() => proof.resolve(s.project, 'codex')).toThrow(/only the borrowed account can run here, so “CLI default” \(Codex\) is blocked/)
    await expect(proof.select(s.project, 'claude', s.otherId)).rejects.toThrow('This proof can only use its borrowed account')
    await expect(proof.select(s.project, 'claude', defaultAccountId('claude'))).rejects.toThrow('This proof can only use its borrowed account')
    await expect(proof.refresh(s.otherId)).rejects.toThrow(/“Other” \(Claude Code\) is blocked/)
    await expect(proof.startSignin('claude', 'New')).rejects.toThrow('Sign-in is disabled while borrowing a proof account')
    await expect(proof.remove(s.workId)).rejects.toBeInstanceOf(AccountInUseError)
    expect(s.registry()).toBe(registryBefore)
    expect(existsSync(s.profile)).toBe(true)
  }, TIMEOUT)

  it('stops when the disposable copy or the real login no longer matches what was borrowed', async () => {
    const s = await setup()
    const context = proofAccountContext(s.state, false, { COCKPIT_PROOF_ACCOUNT_ID: s.workId }, s.home)!
    // The disposable copy moves to another generation (as a refresh seeing someone else would do).
    createAccountStore(s.state).observe(s.workId, { state: 'known', key: 'someone-else', observedAt: new Date().toISOString(), source: 'claude auth status' })
    const proof = service(s.state, s.home, context)
    expect(() => proof.resolve(s.project, 'claude')).toThrow(/no longer matches the login it borrowed/)

    const t = await setup()
    const borrowed = service(t.state, t.home, proofAccountContext(t.state, false, { COCKPIT_PROOF_ACCOUNT_ID: t.workId }, t.home))
    expect(borrowed.resolve(t.project, 'claude').accountId).toBe(t.workId)
    // The real login is signed in as someone else after the proof started.
    t.source.observe(t.workId, { state: 'known', key: 'someone-else', observedAt: new Date().toISOString(), source: 'claude auth status' })
    expect(() => borrowed.resolve(t.project, 'claude')).toThrow(/changed in .* since the proof started/)
  }, TIMEOUT)
})
