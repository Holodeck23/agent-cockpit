// The environment that puts a CLI in one account context (G-ACCOUNTS "Selected mechanism"): the
// profile's folder as CLAUDE_CONFIG_DIR or CODEX_HOME, with the real HOME left alone (a HOME
// override breaks the Keychain, G-LIFECYCLE). The CLI default adds nothing.
import type { Account, ResolvedAccount } from './types.ts'

/** The variables to add for an account; `dir` is its profile folder when managed. */
export function accountEnv(account: Account, dir: string | undefined): Record<string, string> {
  if (account.mode === 'default' || account.isolation === 'none') return {}
  if (!dir) throw new Error(`The ${account.label} profile has no folder`)
  return { [account.isolation]: dir }
}

export function resolved(account: Account, dir: string | undefined): ResolvedAccount {
  return { accountId: account.id, generation: account.generation, label: account.label, env: accountEnv(account, dir) }
}

/**
 * Sign-in helpers print their link instead of opening the browser: the default browser is usually
 * signed in to the other account, so the user opens the link in a private window or the right
 * profile (G-ACCOUNTS "Sign-in UI"). Both CLIs open the URL with $BROWSER when it is set.
 */
export const NO_BROWSER: Readonly<Record<string, string>> = { BROWSER: '/usr/bin/true' }
