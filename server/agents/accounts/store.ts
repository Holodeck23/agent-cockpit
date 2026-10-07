// <root>/accounts.json: account records and each project's one choice per agent (W12.1). The picker
// and project settings read and write the same selection here; there is no second copy. Managed
// profiles' folders live in <root>/account-profiles/<id>, private to this user, and only their ID
// is stored: the folder is derived, never sent to a client.
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writeFileAtomic } from '../../files/atomic.ts'
import { StoreReadError } from '../../state/read-error.ts'
import { AGENT_IDS } from '../capabilities/types.ts'
import type { AgentId } from '../types.ts'
import { defaultAccountId, PROFILE_ISOLATION, type Account, type IdentityObservation } from './types.ts'

export const ACCOUNTS_SCHEMA_VERSION = 1
const agentSchema = z.enum(AGENT_IDS)

const identitySchema = z.object({
  state: z.enum(['known', 'unknown']),
  key: z.string().max(40).optional(),
  hint: z.string().max(200).optional(),
  observedAt: z.string(),
  source: z.enum(['claude auth status', 'codex account/read']),
  reason: z.string().max(500).optional(),
})

const accountSchema = z.object({
  id: z.string().regex(/^(default-[a-z]+|[0-9a-f-]{36})$/),
  agent: agentSchema,
  label: z.string().min(1).max(60),
  mode: z.enum(['default', 'managed']),
  isolation: z.enum(['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'none']),
  identity: identitySchema.optional(),
  generation: z.number().int().min(1),
  lastKnownKey: z.string().max(40).optional(),
  createdAt: z.string(),
  revision: z.number().int().min(1),
})

const fileSchema = z.object({
  version: z.number().int().min(1),
  revision: z.number().int().min(0),
  accounts: z.array(accountSchema),
  /** Project folder → agent → account ID. Absent means the CLI default. */
  selections: z.record(z.string(), z.partialRecord(agentSchema, z.string())),
})
type AccountsFile = z.output<typeof fileSchema>

export const LABEL_MAX = 60

export interface AccountStore {
  /** Every account, the four CLI defaults included. */
  list(): Account[]
  get(id: string): Account | undefined
  /** The account a project uses for an agent: its selection, or the CLI default. */
  selected(projectPath: string, agent: AgentId): Account
  /** Every project's choices, for removal checks. */
  selections(): Readonly<Record<string, Partial<Record<AgentId, string>>>>
  /** Sets a project's choice; returns the new file revision. The caller checks the account is eligible. */
  select(projectPath: string, agent: AgentId, accountId: string): number
  /** A new managed profile record, with its private folder already created. */
  createManaged(agent: AgentId, label: string, identity: IdentityObservation, id?: string): Account
  /** Records a fresh identity observation; bumps the generation when it changed or became unknown. */
  observe(id: string, identity: IdentityObservation): { account: Account; changed: boolean }
  /** Drops the record (the caller has already cleaned up its folder through the CLI). */
  remove(id: string): void
  /** The private folder a managed profile's CLI is pointed at. */
  profileDir(id: string): string
  /** Creates a profile folder (mode 700) for a sign-in that has not finished yet. */
  prepareProfileDir(id: string): string
  /** Deletes a profile folder Cockpit created; only ever under account-profiles/. */
  deleteProfileDir(id: string): void
  revision(): number
}

const defaultAccount = (agent: AgentId, now: string): Account =>
  ({ id: defaultAccountId(agent), agent, label: 'CLI default', mode: 'default', isolation: 'none', generation: 1, createdAt: now, revision: 1 })

/**
 * The generation after an observation. A change of identity, or a change to unknown, starts a new
 * generation; unknown → the same known account as before keeps the current one (nothing ran as
 * anyone else meanwhile that Cockpit could attribute).
 */
export function nextGeneration(account: Account, identity: IdentityObservation): { generation: number; changed: boolean; lastKnownKey?: string } {
  const previous = account.identity
  if (identity.state === 'unknown') {
    const changed = previous?.state === 'known'
    return { generation: account.generation + (changed ? 1 : 0), changed, ...(account.lastKnownKey ? { lastKnownKey: account.lastKnownKey } : {}) }
  }
  const key = identity.key!
  // The first identity ever seen for an account is its first generation, not a change.
  if (!previous && !account.lastKnownKey) return { generation: account.generation, changed: false, lastKnownKey: key }
  const changed = key !== account.lastKnownKey
  return { generation: account.generation + (changed ? 1 : 0), changed, lastKnownKey: key }
}

export function createAccountStore(root: string): AccountStore {
  const file = join(root, 'accounts.json')
  const profiles = join(root, 'account-profiles')

  const read = (): AccountsFile => {
    if (!existsSync(file)) return { version: ACCOUNTS_SCHEMA_VERSION, revision: 0, accounts: [], selections: {} }
    let raw: unknown
    try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { throw new StoreReadError('UNREADABLE', file, 'not valid JSON') }
    const version = (raw as { version?: unknown })?.version
    if (typeof version === 'number' && version > ACCOUNTS_SCHEMA_VERSION) throw new StoreReadError('FUTURE_VERSION', file)
    const parsed = fileSchema.safeParse(raw)
    if (!parsed.success) throw new StoreReadError('UNREADABLE', file, 'unexpected format')
    return parsed.data
  }
  const write = (next: AccountsFile): void => {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`)
  }
  /** Every agent has its CLI default, recorded or not. */
  const withDefaults = (accounts: readonly Account[]): Account[] => {
    const now = new Date().toISOString()
    const missing = AGENT_IDS.filter((agent) => !accounts.some((a) => a.id === defaultAccountId(agent))).map((agent) => defaultAccount(agent, now))
    return [...missing, ...accounts]
  }
  const dirOf = (id: string): string => {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Not a managed profile')
    return join(profiles, id)
  }
  const replace = (current: AccountsFile, account: Account): AccountsFile => {
    const accounts = withDefaults(current.accounts)
    return { ...current, revision: current.revision + 1, accounts: accounts.map((a) => (a.id === account.id ? account : a)) }
  }

  return {
    list: () => withDefaults(read().accounts),
    get: (id) => withDefaults(read().accounts).find((a) => a.id === id),
    selected(projectPath, agent) {
      const current = read()
      const accounts = withDefaults(current.accounts)
      const chosen = current.selections[projectPath]?.[agent]
      // A selection that names a missing account falls back to nothing silently only here, in a read:
      // removal never leaves one behind (it refuses while any project still selects the profile).
      return accounts.find((a) => a.id === chosen && a.agent === agent) ?? accounts.find((a) => a.id === defaultAccountId(agent))!
    },
    selections: () => read().selections,
    select(projectPath, agent, accountId) {
      const current = read()
      const forProject = { ...current.selections[projectPath] }
      if (accountId === defaultAccountId(agent)) delete forProject[agent]
      else forProject[agent] = accountId
      const selections = { ...current.selections }
      if (Object.keys(forProject).length === 0) delete selections[projectPath]
      else selections[projectPath] = forProject
      const next = { ...current, revision: current.revision + 1, selections }
      write(next)
      return next.revision
    },
    createManaged(agent, label, identity, id = randomUUID()) {
      const isolation = PROFILE_ISOLATION[agent]
      if (!isolation) throw new Error(`${agent} has no supported account profiles`)
      const now = new Date().toISOString()
      const account: Account = {
        id, agent, label: label.trim().slice(0, LABEL_MAX) || 'Account', mode: 'managed', isolation, identity, generation: 1,
        ...(identity.state === 'known' ? { lastKnownKey: identity.key } : {}), createdAt: now, revision: 1,
      }
      const current = read()
      write({ ...current, revision: current.revision + 1, accounts: [...current.accounts, account] })
      return account
    },
    observe(id, identity) {
      const current = read()
      const account = withDefaults(current.accounts).find((a) => a.id === id)
      if (!account) throw new Error('Unknown account')
      const { generation, changed, lastKnownKey } = nextGeneration(account, identity)
      const next: Account = { ...account, identity, generation, ...(lastKnownKey ? { lastKnownKey } : {}), revision: account.revision + 1 }
      write(replace(current, next))
      return { account: next, changed }
    },
    remove(id) {
      const current = read()
      write({ ...current, revision: current.revision + 1, accounts: current.accounts.filter((a) => a.id !== id) })
    },
    profileDir: dirOf,
    prepareProfileDir(id) {
      const dir = dirOf(id)
      mkdirSync(profiles, { recursive: true, mode: 0o700 })
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      // mkdirSync's mode is masked and ignored for an existing folder: make it private either way.
      chmodSync(profiles, 0o700)
      chmodSync(dir, 0o700)
      return dir
    },
    deleteProfileDir(id) {
      rmSync(dirOf(id), { recursive: true, force: true })
    },
    revision: () => read().revision,
  }
}
