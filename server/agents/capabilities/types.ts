// The one capability contract every agent CLI is described by (W10.1 L2/L3). A record always
// belongs to one resolved executable and one account context: nothing in it is borrowed from
// another executable or account, and "not checked" never stands in for "not installed".
import type { AgentId } from '../types.ts'

export const AGENT_COMMANDS: Record<AgentId, string> = { claude: 'claude', codex: 'codex', antigravity: 'agy', opencode: 'opencode' }
export const AGENT_IDS = ['claude', 'codex', 'antigravity', 'opencode'] as const satisfies readonly AgentId[]

/** `not_checked`: Cockpit has not asked yet. `unavailable`: it asked and could not find out. */
export type CapabilityState = 'supported' | 'unsupported' | 'unavailable' | 'not_checked'

export interface Capability<T = never> {
  readonly state: CapabilityState
  readonly reason?: string
  readonly value?: T
}

export interface ExecutableIdentity {
  /** The command name looked up on PATH. */
  readonly command: string
  /** The first PATH hit, which is what a launch runs. */
  readonly path: string
  readonly realpath: string
  /** realpath plus size, mtime and inode: changes when the file is replaced, even by a self-updater. */
  readonly fingerprint: string
  /** First line of `--version`; absent while not checked. */
  readonly version?: string
}

export type ExecutableState =
  | { readonly state: 'found'; readonly identity: ExecutableIdentity }
  | { readonly state: 'missing'; readonly reason: string }
  /** On PATH, but `--version` failed or timed out: present, not proven usable. */
  | { readonly state: 'unavailable'; readonly reason: string; readonly identity: ExecutableIdentity }

export type InstallManagerKind = 'native' | 'npm' | 'bun' | 'homebrew' | 'standalone' | 'unknown'

export interface InstallManager {
  readonly kind: InstallManagerKind
  readonly label: string
}

export type AuthState = 'signed_in' | 'signed_out' | 'unknown' | 'not_checked'

export interface AuthCapability {
  readonly state: AuthState
  readonly reason?: string
  /** Non-secret detail the CLI reported, e.g. the sign-in method. Never a token or an email. */
  readonly detail?: string
}

export interface ModelOption {
  readonly id: string
  readonly label?: string
}

export interface AgentCapabilities {
  readonly agent: AgentId
  /** The account/config context the record belongs to; `default` is the CLI's own default login. */
  readonly context: string
  /** When the probe that produced this record started; absent when nothing was probed. */
  readonly probedAt?: string
  readonly executable: ExecutableState
  readonly manager?: InstallManager
  readonly models: Capability<readonly ModelOption[]> & { readonly source?: string }
  /** Launch options and protocol features, by name (Claude's flags today). */
  readonly settings: Readonly<Record<string, Capability>>
  readonly auth: AuthCapability
  /** Older than the cache window and kept rather than re-run (Antigravity): Refresh to check again. */
  readonly stale?: boolean
  /** The executable was replaced while it was being checked; the record is not kept. */
  readonly changedDuringProbe?: boolean
}
