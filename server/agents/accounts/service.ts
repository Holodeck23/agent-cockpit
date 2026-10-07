// Account profiles as the desktop uses them (W12.1, INTERFACES /api/accounts): add a profile through
// the CLI's own sign-in in a fresh private context, choose one per project and agent, re-read who is
// signed in, and remove a profile with the CLI's own sign-out. Nothing here copies, reads or prints
// a credential, signs out the CLI default, or changes a selection after a failed step.
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AGENT_IDS } from '../capabilities/types.ts'
import { AGENT_LABEL } from '../lifecycle/plans.ts'
import { runHelper, type HelperExit, type HelperRun } from '../lifecycle/runner.ts'
import type { AccountRef, AgentId } from '../types.ts'
import { ThreadBusyError } from '../../threads/manager.ts'
import { accountEnv, NO_BROWSER, resolved } from './env.ts'
import { observeIdentity, type IdentityProbe } from './identity.ts'
import { createAccountStore, LABEL_MAX, type AccountStore } from './store.ts'
import { defaultAccountId, DEFAULT_ONLY_REASON, PROFILE_ISOLATION, supportsProfiles, usageKeyOf, viewOf, type Account, type AccountView, type ResolvedAccount } from './types.ts'

/** The thread manager's side: activity per project/agent, live sessions per account, rebinding. */
export interface AccountSessions {
  activity(projectPath: string, agent: AgentId): { readonly busy: number; readonly queued: number }
  inUse(accountId: string): number
  /** Ends idle sessions on an account, so none still runs in a context about to be signed out. */
  closeIdle(accountId: string): Promise<void>
  rebindProject(projectPath: string, agent: AgentId, to: ResolvedAccount): Promise<void>
  identityChanged(accountId: string, to: ResolvedAccount): Promise<void>
}

export interface AccountServiceOptions {
  readonly stateRoot: string
  readonly store?: AccountStore
  /** The resolved CLI for an agent, the same one a launch runs. */
  readonly executable: (agent: AgentId) => Promise<string>
  /** The agent's environment without any account variable; defaults to Cockpit's own minus its secrets. */
  readonly env?: () => Record<string, string>
  readonly probe?: IdentityProbe
  readonly sessions: AccountSessions
  readonly timeoutMs?: { readonly signin?: number; readonly logout?: number }
}

/** A change refused because conversations on that agent are still working or hold queued input (HTTP 409). */
export class AccountBusyError extends Error {}
/** A removal refused, with what has to happen first (HTTP 409). */
export class AccountInUseError extends Error {
  constructor(message: string, readonly projects: readonly string[] = []) { super(message) }
}

export type SigninState = 'waiting_for_user' | 'checking' | 'verified' | 'error' | 'cancelled'

export interface SigninView {
  readonly id: string
  readonly agent: AgentId
  readonly label: string
  readonly state: SigninState
  /** The sign-in link the CLI printed, to open in a private window or the right browser profile. */
  readonly url?: string
  /** Claude asks for the code the page shows; Codex finishes through its localhost callback. */
  readonly takesCode: boolean
  readonly lines: readonly string[]
  readonly message?: string
  readonly account?: AccountView
  readonly startedAt: string
  readonly endedAt?: string
}

const SIGNIN_TIMEOUT_MS = 10 * 60_000
const LOGOUT_TIMEOUT_MS = 30_000
const URL_IN_LINE = /https:\/\/[^\s"'<>]+/

const SIGNIN_ARGS: Readonly<Partial<Record<AgentId, readonly string[]>>> = { claude: ['auth', 'login'], codex: ['login'] }
const LOGOUT_ARGS: Readonly<Partial<Record<AgentId, readonly string[]>>> = { claude: ['auth', 'logout'], codex: ['logout'] }

/** Cockpit's own environment for an agent CLI: its tokens and Electron's Node mode left out. */
export function agentBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith('COCKPIT_') && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value
  return env
}

export function createAccountService(options: AccountServiceOptions) {
  const store = options.store ?? createAccountStore(options.stateRoot)
  const probe = options.probe ?? observeIdentity
  const baseEnv = options.env ?? agentBaseEnv
  const logDir = join(options.stateRoot, 'account-signins')
  const signins = new Map<string, { view: SigninView; run?: HelperRun }>()
  const listeners = new Set<(view: SigninView) => void>()
  let refreshing: Promise<void> | undefined

  const dirFor = (account: Account): string | undefined => (account.mode === 'managed' ? store.profileDir(account.id) : undefined)
  const resolve = (account: Account): ResolvedAccount => resolved(account, dirFor(account))
  const envFor = (account: Account): Record<string, string> => ({ ...baseEnv(), ...accountEnv(account, dirFor(account)) })
  const label = (agent: AgentId): string => AGENT_LABEL[agent]

  const update = (id: string, patch: Partial<SigninView>): void => {
    const entry = signins.get(id)
    if (!entry) return
    entry.view = { ...entry.view, ...patch }
    for (const listener of listeners) listener(entry.view)
  }
  const finish = (id: string, state: SigninState, patch: Partial<SigninView> = {}): void => {
    const entry = signins.get(id)
    if (entry) entry.run = undefined
    update(id, { state, endedAt: new Date().toISOString(), ...patch })
  }

  /** The CLI's own sign-out in one profile's context, bounded. */
  async function logout(agent: AgentId, env: Record<string, string>, logFile: string): Promise<HelperExit> {
    const executable = await options.executable(agent)
    return runHelper({ executable, args: LOGOUT_ARGS[agent]!, env, cwd: homedir(), timeoutMs: options.timeoutMs?.logout ?? LOGOUT_TIMEOUT_MS, logFile }).done
  }

  /** A sign-in that did not finish leaves no profile: the CLI signs that context out, then the folder goes. */
  async function discard(agent: AgentId, profileId: string, logFile: string): Promise<void> {
    const dir = store.profileDir(profileId)
    const isolation = PROFILE_ISOLATION[agent]!
    await logout(agent, { ...baseEnv(), [isolation]: dir }, logFile).catch(() => undefined)
    store.deleteProfileDir(profileId)
  }

  async function observe(account: Account): Promise<{ account: Account; changed: boolean }> {
    const identity = await probe(account.agent, { executable: await options.executable(account.agent), env: envFor(account) })
    const result = store.observe(account.id, identity)
    if (result.changed) await options.sessions.identityChanged(account.id, resolve(result.account))
    return result
  }

  async function runSignin(id: string, agent: AgentId, accountLabel: string, profileId: string, logFile: string): Promise<void> {
    const isolation = PROFILE_ISOLATION[agent]!
    const dir = store.prepareProfileDir(profileId)
    const env = { ...baseEnv(), [isolation]: dir }
    const executable = await options.executable(agent)
    const helper = runHelper({
      executable, args: SIGNIN_ARGS[agent]!, env: { ...env, ...NO_BROWSER }, cwd: homedir(), input: true, logFile,
      timeoutMs: options.timeoutMs?.signin ?? SIGNIN_TIMEOUT_MS,
      onLine: (line) => {
        const url = signins.get(id)?.view.url ?? URL_IN_LINE.exec(line)?.[0]
        update(id, { lines: [...helper.lines], ...(url ? { url } : {}) })
      },
    })
    signins.get(id)!.run = helper
    const exit = await helper.done
    const unchanged = 'No account was added and no project’s account changed.'
    if (exit.cancelled) { await discard(agent, profileId, logFile); finish(id, 'cancelled', { message: `Sign-in cancelled. ${unchanged}` }); return }
    if (exit.code !== 0) {
      await discard(agent, profileId, logFile)
      const why = exit.error ? `could not start (${exit.error})` : exit.timedOut ? 'was stopped after waiting too long' : `did not finish (exit ${exit.code ?? exit.signal})`
      finish(id, 'error', { message: `${label(agent)} sign-in ${why}. ${unchanged}` })
      return
    }
    update(id, { state: 'checking', message: 'Checking which account signed in…' })
    const identity = await probe(agent, { executable, env })
    if (identity.state !== 'known') {
      await discard(agent, profileId, logFile)
      finish(id, 'error', { message: `Sign-in finished, but ${label(agent)} does not confirm an account (${identity.reason ?? 'unknown'}). ${unchanged}` })
      return
    }
    const twin = store.list().find((a) => a.agent === agent && a.lastKnownKey === identity.key)
    const account = store.createManaged(agent, accountLabel, identity, profileId)
    finish(id, 'verified', {
      account: viewOf(account),
      message: twin
        ? `Signed in as ${identity.hint ?? 'an account'}. That is the same account as “${twin.label}”, so it adds no separate allowance.`
        : `Signed in as ${identity.hint ?? 'a new account'}. Choose it for a project to use it there.`,
    })
  }

  const support = Object.fromEntries(AGENT_IDS.map((agent) => [agent, supportsProfiles(agent)
    ? { profiles: true, takesCode: agent === 'claude' }
    : { profiles: false, reason: DEFAULT_ONLY_REASON[agent] }])) as Record<AgentId, { profiles: boolean; takesCode?: boolean; reason?: string }>

  const service = {
    support,
    list: (): AccountView[] => store.list().map(viewOf),
    /** The binding the thread manager launches with. */
    resolve: (projectPath: string, agent: AgentId): ResolvedAccount => resolve(store.selected(projectPath, agent)),
    describe(accountId: string): AccountRef | undefined {
      const account = store.get(accountId)
      return account ? { id: account.id, label: account.label, ...(account.identity?.state === 'known' && account.identity.hint ? { hint: account.identity.hint } : {}) } : undefined
    },
    /** The CLI default's current usage key, so its old identity's usage is not shown as its own. */
    defaultUsageKey: (agent: AgentId): string => usageKeyOf(store.get(defaultAccountId(agent))!),
    /** The project's choice per agent: one authority for the picker and project settings. */
    forProject(projectPath: string): Record<AgentId, string> {
      return Object.fromEntries(AGENT_IDS.map((agent) => [agent, store.selected(projectPath, agent).id])) as Record<AgentId, string>
    },

    async select(projectPath: string, agent: AgentId, accountId: string): Promise<Record<AgentId, string>> {
      const account = store.get(accountId)
      if (!account || account.agent !== agent) throw new Error(`That account is not a ${label(agent)} account`)
      const previous = store.selected(projectPath, agent)
      if (previous.id !== account.id) {
        const { busy, queued } = options.sessions.activity(projectPath, agent)
        if (busy > 0 || queued > 0) {
          throw new AccountBusyError(queued > 0
            ? `A ${label(agent)} conversation in this project has a queued message. Let it be sent, or take it back, then change the account.`
            : `A ${label(agent)} conversation in this project is still working. Change the account when it has finished.`)
        }
        store.select(projectPath, agent, account.id)
        try {
          await options.sessions.rebindProject(projectPath, agent, resolve(account))
        } catch (error) {
          // A turn started in between: the project keeps the account it is running on.
          store.select(projectPath, agent, previous.id)
          throw error instanceof ThreadBusyError ? new AccountBusyError(error.message) : error
        }
      }
      return service.forProject(projectPath)
    },

    /** Re-reads who is signed in to an account; a change starts a new generation and tells its idle conversations. */
    async refresh(accountId: string): Promise<{ account: AccountView; changed: boolean }> {
      const account = store.get(accountId)
      if (!account) throw new Error('Unknown account')
      if (!supportsProfiles(account.agent)) return { account: viewOf(account), changed: false }
      const result = await observe(account)
      return { account: viewOf(result.account), changed: result.changed }
    },
    /** The Claude and Codex defaults, checked when the picker or project settings open. Overlapping calls share one check. */
    refreshDefaults(): Promise<void> {
      refreshing ??= Promise.all(AGENT_IDS.filter(supportsProfiles).map((agent) => service.refresh(defaultAccountId(agent)).catch((error: unknown) => {
        console.warn(`[cockpit] could not check the ${label(agent)} account:`, error instanceof Error ? error.message : error)
      }))).then(() => undefined).finally(() => { refreshing = undefined })
      return refreshing
    },

    /** Starts the CLI's own sign-in in a new private context. */
    async startSignin(agent: AgentId, accountLabel: string): Promise<SigninView> {
      if (!supportsProfiles(agent)) throw new Error(DEFAULT_ONLY_REASON[agent] ?? `${label(agent)} has no account profiles`)
      for (const { view } of signins.values()) if (view.agent === agent && !view.endedAt) throw new AccountBusyError(`A ${label(agent)} sign-in is already open`)
      const name = accountLabel.trim().slice(0, LABEL_MAX)
      if (!name) throw new Error('Name the account, e.g. Work')
      const id = randomUUID()
      const profileId = randomUUID()
      mkdirSync(logDir, { recursive: true, mode: 0o700 })
      const logFile = join(logDir, `${id}.log`)
      writeFileSync(logFile, '', { mode: 0o600 })
      signins.set(id, { view: { id, agent, label: name, state: 'waiting_for_user', takesCode: agent === 'claude', lines: [], startedAt: new Date().toISOString() } })
      runSignin(id, agent, name, profileId, logFile).catch((error: unknown) => {
        void discard(agent, profileId, logFile).catch(() => undefined)
        finish(id, 'error', { message: `Cockpit could not finish the sign-in: ${error instanceof Error ? error.message : String(error)}. No account was added.` })
      })
      return signins.get(id)!.view
    },
    signin: (id: string): SigninView | undefined => signins.get(id)?.view,
    /** The code Claude's sign-in page shows; passed to the waiting CLI only, never logged or kept. */
    signinInput(id: string, code: string): boolean {
      const entry = signins.get(id)
      if (entry?.view.state !== 'waiting_for_user' || !entry.view.takesCode || !entry.run) return false
      entry.run.write(code.endsWith('\n') ? code : `${code}\n`)
      return true
    },
    cancelSignin(id: string): boolean {
      const entry = signins.get(id)
      if (!entry?.run || entry.view.endedAt) return false
      entry.run.cancel()
      return true
    },

    /**
     * Removes a managed profile: refused while a session uses it or a project still chooses it
     * (unless `moveProjectsToDefault`, which changes those projects first, idle ones only). The
     * CLI signs that context out; only then is its folder deleted. The vendor account and the CLI
     * default's sign-in are untouched.
     */
    async remove(accountId: string, removeOptions: { moveProjectsToDefault?: boolean } = {}): Promise<{ removed: true; message: string }> {
      const account = store.get(accountId)
      if (!account) throw new Error('Unknown account')
      if (account.mode !== 'managed') throw new AccountInUseError('The CLI default is not something Cockpit removes. Sign it out with the CLI itself if you mean to.')
      const running = options.sessions.inUse(account.id)
      if (running > 0) throw new AccountInUseError(`${running} conversation${running === 1 ? ' is' : 's are'} running on “${account.label}”. Stop ${running === 1 ? 'it' : 'them'} first.`)
      const choosing = Object.entries(store.selections()).filter(([, chosen]) => chosen[account.agent] === account.id).map(([path]) => path)
      if (choosing.length > 0 && !removeOptions.moveProjectsToDefault) {
        throw new AccountInUseError(`${choosing.length} project${choosing.length === 1 ? ' uses' : 's use'} “${account.label}”. Choose another account for ${choosing.length === 1 ? 'it' : 'them'} first, or move ${choosing.length === 1 ? 'it' : 'them'} to the CLI default.`, choosing)
      }
      for (const project of choosing) await service.select(project, account.agent, defaultAccountId(account.agent))
      await options.sessions.closeIdle(account.id)
      // A turn may have started while the idle ones closed: still never sign out under it.
      if (options.sessions.inUse(account.id) > 0) throw new AccountInUseError(`A conversation started on “${account.label}” just now. Try again when it has finished.`)
      mkdirSync(logDir, { recursive: true, mode: 0o700 })
      const logFile = join(logDir, `remove-${account.id}.log`)
      const exit = await logout(account.agent, envFor(account), logFile)
      if (exit.code !== 0) {
        const manual = `${PROFILE_ISOLATION[account.agent]}="${store.profileDir(account.id)}" ${account.agent === 'claude' ? 'claude auth logout' : 'codex logout'}`
        throw new AccountInUseError(`${label(account.agent)} could not sign that profile out (${exit.error ?? (exit.timedOut ? 'timed out' : `exit ${exit.code ?? exit.signal}`)}), so Cockpit kept it rather than leave a sign-in behind. Try again, or run: ${manual}`)
      }
      store.deleteProfileDir(account.id)
      store.remove(account.id)
      return { removed: true, message: `Removed “${account.label}”: signed out in its own context and its folder deleted. Your ${label(account.agent)} account itself and the CLI default sign-in are unchanged.` }
    },

    subscribe(listener: (view: SigninView) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** Quit: an open sign-in ends with Cockpit, and its unfinished profile is discarded. */
    shutdown(): Promise<unknown> {
      const open = [...signins.values()].filter((e) => e.run)
      for (const e of open) e.run!.cancel()
      return Promise.all(open.map((e) => e.run?.done))
    },
  }
  return service
}

export type AccountService = ReturnType<typeof createAccountService>
