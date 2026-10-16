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
import type { AppServerQuery } from '../codex/app-server-query.ts'
import { ensureSharedInstructions } from './instructions.ts'
import { createAccountStore, LABEL_MAX, type AccountStore } from './store.ts'
import { defaultAccountId, DEFAULT_ONLY_REASON, PROFILE_ISOLATION, supportsProfiles, usageKeyOf, viewOf, type Account, type AccountView, type ResolvedAccount } from './types.ts'

/** The thread manager's side: activity per project/agent, live sessions per account, rebinding. */
export interface AccountSessions {
  activity(projectPath: string, agent: AgentId): { readonly busy: number; readonly queued: number }
  inUse(accountId: string): number
  /** Ends idle sessions on an account, so none still runs in a context about to be signed out. */
  closeIdle(accountId: string): Promise<void>
  rebindProject(projectPath: string, agent: AgentId, to: ResolvedAccount): Promise<void>
  identityChanged(accountId: string, to: ResolvedAccount, from?: AccountRef): Promise<void>
}

/** Host-injected proof context. It borrows a login without owning or changing its profile. */
export interface BorrowedAccountContext {
  readonly accountId: string
  readonly generation: number
  readonly identityKey: string
  readonly profileDir: string
  /** Rechecks the original metadata before resolving or observing the borrowed account. */
  readonly validate: () => void
}

export interface AccountServiceOptions {
  readonly borrowedContext?: BorrowedAccountContext
  readonly stateRoot: string
  readonly store?: AccountStore
  /** The resolved CLI for an agent, the same one a launch runs. */
  readonly executable: (agent: AgentId) => Promise<string>
  /** The agent's environment without any account variable; defaults to Cockpit's own minus its secrets. */
  readonly env?: () => Record<string, string>
  readonly probe?: IdentityProbe
  readonly query?: AppServerQuery
  readonly sessions: AccountSessions
  readonly timeoutMs?: { readonly signin?: number; readonly logout?: number }
  /** Override for tests; managed profiles otherwise share rules from the current user's home. */
  readonly homeDir?: string
}

/** A change refused because conversations on that agent are still working or hold queued input (HTTP 409). */
export class AccountBusyError extends Error {}
/** A removal refused, with what has to happen first (HTTP 409). */
export class AccountInUseError extends Error {
  constructor(message: string, readonly projects: readonly string[] = []) { super(message) }
}

/** An open sign-in: its view, the helper while it runs, and the whole run (including a discard) as one promise. */
interface SigninEntry {
  view: SigninView
  run?: HelperRun
  /** Cancel arrived with no helper to stop (still starting, or already checking): runSignin honours it. */
  cancelled?: boolean
  settled?: Promise<void>
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
  const signins = new Map<string, SigninEntry>()
  const listeners = new Set<(view: SigninView) => void>()
  let refreshing: Promise<void> | undefined
  /** Projects whose conversations wait for an account's sign-out (agent + project -> the account's label). */
  const leaving = new Map<string, string>()
  const leavingKey = (projectPath: string, agent: AgentId): string => `${agent}\0${projectPath}`

  const dirFor = (account: Account): string | undefined => {
    const borrowed = options.borrowedContext
    if (borrowed) {
      // A proof runs on one login only; every other account, the CLI defaults included, is refused on purpose.
      if (account.id !== borrowed.accountId) {
        throw new Error(`Proof mode: only the borrowed account can run here, so “${account.label}” (${label(account.agent)}) is blocked`)
      }
      borrowed.validate()
      if (account.generation !== borrowed.generation || account.mode !== 'managed' || account.agent !== 'claude'
        || account.isolation !== 'CLAUDE_CONFIG_DIR' || account.lastKnownKey !== borrowed.identityKey) {
        throw new Error('Proof mode: this copy of the borrowed account no longer matches the login it borrowed (generation or identity changed). Stop this proof.')
      }
      // Never create instruction links or mutate the borrowed provider profile.
      return borrowed.profileDir
    }
    if (account.mode !== 'managed') return undefined
    const dir = store.profileDir(account.id)
    ensureSharedInstructions(account.agent, dir, options.homeDir ?? homedir())
    return dir
  }
  const resolve = (account: Account): ResolvedAccount => resolved(account, dirFor(account))
  const envFor = (account: Account): Record<string, string> => ({ ...baseEnv(), ...accountEnv(account, dirFor(account)) })
  const label = (agent: AgentId): string => AGENT_LABEL[agent]
  const refOf = (account: Account): AccountRef =>
    ({ id: account.id, label: account.label, ...(account.identity?.state === 'known' && account.identity.hint ? { hint: account.identity.hint } : {}) })

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

  /** A change of account is refused while a conversation of that agent in the project is working or holds queued input. */
  const requireIdle = (projectPath: string, agent: AgentId): void => {
    const { busy, queued } = options.sessions.activity(projectPath, agent)
    if (busy > 0 || queued > 0) {
      throw new AccountBusyError(queued > 0
        ? `A ${label(agent)} conversation in this project has a queued message. Let it be sent, or take it back, then change the account.`
        : `A ${label(agent)} conversation in this project is still working. Change the account when it has finished.`)
    }
  }

  /** The CLI's own sign-out in one profile's context, bounded. */
  async function logout(agent: AgentId, env: Record<string, string>, logFile: string): Promise<HelperExit> {
    const executable = await options.executable(agent)
    return runHelper({ executable, args: LOGOUT_ARGS[agent]!, env, cwd: homedir(), timeoutMs: options.timeoutMs?.logout ?? LOGOUT_TIMEOUT_MS, logFile }).done
  }

  /** Cancel: stops the helper while there is one; later (starting, checking) the run itself sees the flag. */
  const cancelOpen = (entry: SigninEntry): void => {
    if (entry.run) entry.run.cancel()
    else entry.cancelled = true
  }

  /** A sign-in that did not finish leaves no profile: the CLI signs that context out, then the folder goes. */
  async function discard(agent: AgentId, profileId: string, logFile: string): Promise<void> {
    const dir = store.profileDir(profileId)
    const isolation = PROFILE_ISOLATION[agent]!
    await logout(agent, { ...baseEnv(), [isolation]: dir }, logFile).catch(() => undefined)
    store.deleteProfileDir(profileId)
  }

  async function observe(account: Account): Promise<{ account: Account; changed: boolean }> {
    const identity = await probe(account.agent, { executable: await options.executable(account.agent), env: envFor(account), query: options.query })
    const before = refOf(account)
    const result = store.observe(account.id, identity)
    if (result.changed) await options.sessions.identityChanged(account.id, resolve(result.account), before)
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
    const entry = signins.get(id)!
    entry.run = helper
    if (entry.cancelled) helper.cancel()
    const exit = await helper.done
    // The helper is gone: a Cancel from here on has nothing to stop.
    entry.run = undefined
    const unchanged = 'No account was added and no project’s account changed.'
    if (exit.cancelled) { await discard(agent, profileId, logFile); finish(id, 'cancelled', { message: `Sign-in cancelled. ${unchanged}` }); return }
    if (exit.code !== 0) {
      await discard(agent, profileId, logFile)
      const why = exit.error ? `could not start (${exit.error})` : exit.timedOut ? 'was stopped after waiting too long' : `did not finish (exit ${exit.code ?? exit.signal})`
      finish(id, 'error', { message: `${label(agent)} sign-in ${why}. ${unchanged}` })
      return
    }
    update(id, { state: 'checking', message: 'Checking which account signed in…' })
    const identity = await probe(agent, { executable, env, query: options.query })
    if (entry.cancelled) { await discard(agent, profileId, logFile); finish(id, 'cancelled', { message: `Sign-in cancelled. ${unchanged}` }); return }
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
    /**
     * The binding the thread manager launches with. Refused while the project's account is being removed: the
     * project already selects the default, but if the sign-out fails it goes back, and a conversation launched
     * on the default meanwhile would stay there.
     */
    resolve(projectPath: string, agent: AgentId): ResolvedAccount {
      const removing = leaving.get(leavingKey(projectPath, agent))
      if (removing !== undefined) throw new ThreadBusyError(`“${removing}” is being removed from this project: its sign-out has not finished. Send this again in a moment.`)
      return resolve(store.selected(projectPath, agent))
    },
    describe(accountId: string): AccountRef | undefined {
      const account = store.get(accountId)
      return account ? refOf(account) : undefined
    },
    /** The CLI default's current usage key, so its old identity's usage is not shown as its own. */
    defaultUsageKey: (agent: AgentId): string => usageKeyOf(store.get(defaultAccountId(agent))!),
    /** The project's choice per agent: one authority for the picker and project settings. */
    forProject(projectPath: string): Record<AgentId, string> {
      return Object.fromEntries(AGENT_IDS.map((agent) => [agent, store.selected(projectPath, agent).id])) as Record<AgentId, string>
    },

    async select(projectPath: string, agent: AgentId, accountId: string): Promise<Record<AgentId, string>> {
      if (options.borrowedContext && accountId !== options.borrowedContext.accountId) throw new Error('This proof can only use its borrowed account')
      const account = store.get(accountId)
      if (!account || account.agent !== agent) throw new Error(`That account is not a ${label(agent)} account`)
      const previous = store.selected(projectPath, agent)
      if (previous.id !== account.id) {
        requireIdle(projectPath, agent)
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
      if (options.borrowedContext) return Promise.resolve()
      refreshing ??= Promise.all(AGENT_IDS.filter(supportsProfiles).map((agent) => service.refresh(defaultAccountId(agent)).catch((error: unknown) => {
        console.warn(`[cockpit] could not check the ${label(agent)} account:`, error instanceof Error ? error.message : error)
      }))).then(() => undefined).finally(() => { refreshing = undefined })
      return refreshing
    },

    /** Starts the CLI's own sign-in in a new private context. */
    async startSignin(agent: AgentId, accountLabel: string): Promise<SigninView> {
      if (options.borrowedContext) throw new Error('Sign-in is disabled while borrowing a proof account')
      if (!supportsProfiles(agent)) throw new Error(DEFAULT_ONLY_REASON[agent] ?? `${label(agent)} has no account profiles`)
      for (const { view } of signins.values()) if (view.agent === agent && !view.endedAt) throw new AccountBusyError(`A ${label(agent)} sign-in is already open`)
      const name = accountLabel.trim().slice(0, LABEL_MAX)
      if (!name) throw new Error('Name the account, e.g. Work')
      const id = randomUUID()
      const profileId = randomUUID()
      mkdirSync(logDir, { recursive: true, mode: 0o700 })
      const logFile = join(logDir, `${id}.log`)
      writeFileSync(logFile, '', { mode: 0o600 })
      const entry: SigninEntry = { view: { id, agent, label: name, state: 'waiting_for_user', takesCode: agent === 'claude', lines: [], startedAt: new Date().toISOString() } }
      signins.set(id, entry)
      entry.settled = runSignin(id, agent, name, profileId, logFile).catch(async (error: unknown) => {
        const cleanup = discard(agent, profileId, logFile).catch(() => undefined)
        finish(id, 'error', { message: `Cockpit could not finish the sign-in: ${error instanceof Error ? error.message : String(error)}. No account was added.` })
        await cleanup
      })
      return entry.view
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
      if (!entry || entry.view.endedAt) return false
      cancelOpen(entry)
      return true
    },

    /**
     * Removes a managed profile: refused while a session uses it or a project still chooses it
     * (unless `moveProjectsToDefault`, which moves those projects to the default, idle ones only,
     * and puts them back if the removal is then refused). The CLI signs that context out; only
     * then is its folder deleted. The vendor account and the CLI default's sign-in are untouched.
     */
    async remove(accountId: string, removeOptions: { moveProjectsToDefault?: boolean } = {}): Promise<{ removed: true; message: string }> {
      if (options.borrowedContext) throw new AccountInUseError('Borrowed proof accounts cannot be signed out or removed')
      const account = store.get(accountId)
      if (!account) throw new Error('Unknown account')
      if (account.mode !== 'managed') throw new AccountInUseError('The CLI default is not something Cockpit removes. Sign it out with the CLI itself if you mean to.')
      const running = options.sessions.inUse(account.id)
      if (running > 0) throw new AccountInUseError(`${running} conversation${running === 1 ? ' is' : 's are'} running on “${account.label}”. Stop ${running === 1 ? 'it' : 'them'} first.`)
      const choosing = Object.entries(store.selections()).filter(([, chosen]) => chosen[account.agent] === account.id).map(([path]) => path)
      if (choosing.length > 0 && !removeOptions.moveProjectsToDefault) {
        throw new AccountInUseError(`${choosing.length} project${choosing.length === 1 ? ' uses' : 's use'} “${account.label}”. Choose another account for ${choosing.length === 1 ? 'it' : 'them'} first, or move ${choosing.length === 1 ? 'it' : 'them'} to the CLI default.`, choosing)
      }
      // Idle sessions end before any project moves, so a removal refused here has changed nothing.
      await options.sessions.closeIdle(account.id)
      // A turn may have started while the idle ones closed: still never sign out under it.
      if (options.sessions.inUse(account.id) > 0) throw new AccountInUseError(`A conversation started on “${account.label}” just now. Try again when it has finished.`)
      // Every project is checked before the first moves, so a busy one refuses the removal with nothing changed.
      for (const project of choosing) requireIdle(project, account.agent)
      mkdirSync(logDir, { recursive: true, mode: 0o700 })
      const logFile = join(logDir, `remove-${account.id}.log`)
      // Only the selections move before the sign-out, which can still fail: putting a selection back is an exact undo,
      // where rebinding a project's conversations (a new native session, a note each way) is not. So no conversation of
      // a moved project launches until the sign-out settles: one launched now would bind to the default for good.
      const moved: string[] = []
      try {
        for (const project of choosing) {
          store.select(project, account.agent, defaultAccountId(account.agent))
          moved.push(project)
          leaving.set(leavingKey(project, account.agent), account.label)
        }
        const exit = await logout(account.agent, envFor(account), logFile)
        if (exit.code !== 0) {
          const manual = `${PROFILE_ISOLATION[account.agent]}="${store.profileDir(account.id)}" ${account.agent === 'claude' ? 'claude auth logout' : 'codex logout'}`
          throw new AccountInUseError(`${label(account.agent)} could not sign that profile out (${exit.error ?? (exit.timedOut ? 'timed out' : `exit ${exit.code ?? exit.signal}`)}), so Cockpit kept it rather than leave a sign-in behind. Try again, or run: ${manual}`)
        }
      } catch (error) {
        // The profile stays, so a project this call moved goes back to it: a refused removal changes no selection.
        for (const project of moved) store.select(project, account.agent, account.id)
        throw error
      } finally {
        // After the selections are back (or kept): a launch from here reads the settled choice.
        for (const project of moved) leaving.delete(leavingKey(project, account.agent))
      }
      // Signed out: the moved projects' conversations follow now, while the profile can still be named in their note.
      // One that launched after the sign-out settled is already bound to the default.
      for (const project of moved) {
        await options.sessions.rebindProject(project, account.agent, service.resolve(project, account.agent)).catch((rebindError: unknown) => {
          console.warn(`[cockpit] could not move the conversations of ${project} off “${account.label}” yet:`, rebindError instanceof Error ? rebindError.message : rebindError)
        })
      }
      store.deleteProfileDir(account.id)
      store.remove(account.id)
      return { removed: true, message: `Removed “${account.label}”: signed out in its own context and its folder deleted. Your ${label(account.agent)} account itself and the CLI default sign-in are unchanged.` }
    },

    subscribe(listener: (view: SigninView) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** Quit: an open sign-in ends with Cockpit, and its unfinished profile is discarded before this resolves. */
    shutdown(): Promise<unknown> {
      for (const e of signins.values()) if (!e.view.endedAt) cancelOpen(e)
      return Promise.all([...signins.values()].map((e) => e.settled))
    },
  }
  return service
}

export type AccountService = ReturnType<typeof createAccountService>
