// A proof may borrow one existing login while all Cockpit metadata stays disposable.
// This host-only seam is ignored in release builds and never accepts an HTTP profile path.
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createAccountStore } from '../server/agents/accounts/store.ts'
import type { BorrowedAccountContext } from '../server/agents/accounts/service.ts'

function fail(why: string): never {
  throw new Error(`Proof account: ${why}. Stop this proof; do not sign in or switch accounts.`)
}

/**
 * A folder that exists only says the login could be there: whether the account actually
 * authenticates is the packaged identity preflight's question, not this one's.
 */
function requireProfileFolder(dir: string): void {
  // lstat, not stat or realpath: the CLI keys its credentials on this literal path.
  const entry = existsSync(dir) ? lstatSync(dir) : undefined
  if (!entry) fail(`the borrowed profile folder ${dir} does not exist`)
  if (!entry.isDirectory()) fail(`the borrowed profile ${dir} is not a plain folder (a link would change the CLI's credential namespace)`)
}

export function proofAccountContext(
  stateRoot: string,
  releaseBuild: boolean,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): BorrowedAccountContext | undefined {
  const id = env.COCKPIT_PROOF_ACCOUNT_ID
  if (releaseBuild || !id) return undefined
  if (!/^[0-9a-f-]{36}$/.test(id)) fail('COCKPIT_PROOF_ACCOUNT_ID is not an account ID')
  // Deliberately not defaultRoot(): COCKPIT_HOME points at the disposable state, not the login's home.
  const sourceRoot = join(home, '.agent-cockpit')
  if (!existsSync(sourceRoot)) fail(`Cockpit's account folder ${sourceRoot} does not exist`)
  if (!existsSync(stateRoot)) fail(`the disposable state folder ${stateRoot} does not exist`)
  if (realpathSync(stateRoot) === realpathSync(sourceRoot)) fail('COCKPIT_HOME must be a disposable folder, not the real account folder')
  const source = createAccountStore(sourceRoot)
  const account = source.get(id)
  if (!account) fail(`no account ${id} in ${sourceRoot}`)
  if (account.agent !== 'claude' || account.mode !== 'managed' || account.isolation !== 'CLAUDE_CONFIG_DIR') fail(`account ${id} is not a managed Claude profile`)
  if (account.identity?.state !== 'known' || !account.identity.key || account.lastKnownKey !== account.identity.key) fail(`account ${id} has no settled known identity`)
  // Keep this literal string: realpath normalization can change the provider's credential namespace.
  const profileDir = source.profileDir(id)
  requireProfileFolder(profileDir)
  const context: BorrowedAccountContext = {
    accountId: id, generation: account.generation, identityKey: account.identity.key, profileDir,
    validate() {
      const current = source.get(id)
      if (current?.generation !== context.generation || current.identity?.state !== 'known'
        || current.identity.key !== context.identityKey || current.lastKnownKey !== context.identityKey) {
        fail(`account ${id} changed in ${sourceRoot} since the proof started`)
      }
      requireProfileFolder(profileDir)
    },
  }
  return context
}
