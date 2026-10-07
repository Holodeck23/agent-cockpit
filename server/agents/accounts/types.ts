// Account profiles (W12.1 L5, G-ACCOUNTS). An account is either the CLI's own default login or a
// managed profile: a Cockpit-owned folder the CLI is pointed at with CLAUDE_CONFIG_DIR or
// CODEX_HOME, never a different HOME. Cockpit never reads, copies or prints a credential: what it
// knows about an account is the non-secret identity the CLI reports, kept as a short hash.
import type { AgentId } from '../types.ts'

/** The environment variable a managed profile is isolated by; `none` for the CLI default. */
export type Isolation = 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME' | 'none'

/** Agents whose CLI supports an isolated account context (G-ACCOUNTS verdict). */
export const PROFILE_ISOLATION: Readonly<Partial<Record<AgentId, Exclude<Isolation, 'none'>>>> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
}

/** Why an agent stays on its CLI default: said in the picker instead of offering a switch. */
export const DEFAULT_ONLY_REASON: Readonly<Partial<Record<AgentId, string>>> = {
  antigravity: 'Antigravity has no supported way to keep a second account separate, so Cockpit uses the account agy is signed in to.',
  opencode: 'OpenCode has no supported way to keep a second account separate, so Cockpit uses its own default sign-in.',
}

export const supportsProfiles = (agent: AgentId): boolean => PROFILE_ISOLATION[agent] !== undefined

/** The CLI default's account ID for an agent: one per agent, always present. */
export const defaultAccountId = (agent: AgentId): string => `default-${agent}`

/** What the CLI reported about who is signed in, without any secret. */
export interface IdentityObservation {
  /** `unknown`: the check failed or reported nobody; never treated as the previous account. */
  readonly state: 'known' | 'unknown'
  /** sha256 of the email (and org, for Claude), shortened: compares accounts, reveals nothing. */
  readonly key?: string
  /** A hint the user can recognise, e.g. "d…@example.com · pro". Never a full address. */
  readonly hint?: string
  readonly observedAt: string
  /** The command it came from. */
  readonly source: 'claude auth status' | 'codex account/read'
  readonly reason?: string
}

export interface Account {
  readonly id: string
  readonly agent: AgentId
  /** The user's name for it ("Work"); the default is "CLI default". */
  readonly label: string
  readonly mode: 'default' | 'managed'
  readonly isolation: Isolation
  readonly identity?: IdentityObservation
  /**
   * Bumped whenever the identity behind the account changes or becomes unknown. Usage and native
   * sessions belong to one generation; a new one never shows or resumes the old one's.
   */
  readonly generation: number
  /** The last identity key a generation was counted from, so a flicker to unknown and back is seen. */
  readonly lastKnownKey?: string
  readonly createdAt: string
  readonly revision: number
}

/** What the desktop is shown: no folder path, no identity key. */
export interface AccountView {
  readonly id: string
  readonly agent: AgentId
  readonly label: string
  readonly mode: 'default' | 'managed'
  readonly isolation: Isolation
  readonly identity?: Omit<IdentityObservation, 'key'>
  readonly generation: number
  /** `${id}#${generation}`: what usage is keyed by. */
  readonly usageKey: string
}

export const usageKeyOf = (account: Pick<Account, 'id' | 'generation'>): string => `${account.id}#${account.generation}`

export function viewOf(account: Account): AccountView {
  const { key: _key, ...identity } = account.identity ?? ({} as IdentityObservation)
  return {
    id: account.id, agent: account.agent, label: account.label, mode: account.mode, isolation: account.isolation,
    ...(account.identity ? { identity } : {}), generation: account.generation, usageKey: usageKeyOf(account),
  }
}

/** What a launch runs under: the account, its generation and the environment that selects it. */
export interface ResolvedAccount {
  readonly accountId: string
  readonly generation: number
  readonly label: string
  /** Added to the agent's environment; empty for the CLI default. */
  readonly env: Readonly<Record<string, string>>
}
