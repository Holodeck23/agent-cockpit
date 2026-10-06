// Guided install, update and sign-in (W10.2/W10.3), desktop only. One operation per agent at a
// time; each is an explicit action with a fixed plan, a bounded helper, a redacted log kept on
// disk, and an outcome read back from the CLI itself, never assumed from an exit code.
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityService } from '../capabilities/service.ts'
import { resolveExecutable } from '../capabilities/resolve.ts'
import type { AgentCapabilities, AuthState } from '../capabilities/types.ts'
import type { AgentId } from '../types.ts'
import { AGENT_LABEL, INSTALLERS, installPlanFor, manualInstall, signinPlanFor, updatePlanFor, type InstallerSpec, type Plan } from './plans.ts'
import { runHelper, type HelperExit, type HelperRun } from './runner.ts'

export type OperationKind = 'install' | 'update' | 'signin'
export type OperationState =
  | 'installing' | 'updating' | 'waiting_for_user'
  /** An update waits for every conversation using the executable to finish; new sessions wait too. */
  | 'waiting_for_idle'
  /** An update that was waiting when Cockpit quit: it never resumes by itself (W10-08). */
  | 'pending_confirmation'
  | 'installed' | 'auth_needed' | 'updated' | 'incompatible' | 'verified' | 'unknown' | 'cancelled' | 'error'

export interface OperationView {
  readonly id: string
  readonly agent: AgentId
  readonly kind: OperationKind
  readonly state: OperationState
  readonly startedAt: string
  readonly endedAt?: string
  /** The helper's redacted output, latest lines. */
  readonly lines: readonly string[]
  readonly message?: string
  /** The exact command to run yourself when Cockpit cannot. */
  readonly manual?: string
  readonly logFile: string
  readonly result?: { readonly path?: string; readonly version?: string; readonly previousVersion?: string; readonly auth?: AuthState }
}

export interface LifecycleOptions {
  /** Operation logs and records live in <stateRoot>/agent-operations. */
  readonly stateRoot: string
  readonly home?: string
  readonly capabilities: CapabilityService
  /** The PATH Cockpit uses for agents (with ~/.local/bin). */
  readonly pathEnv?: () => string
  readonly download?: (url: string) => Promise<Buffer>
  readonly installers?: Readonly<Partial<Record<AgentId, InstallerSpec>>>
  readonly timeoutMs?: Partial<Record<OperationKind, number>>
  /** The agent sessions Cockpit runs: an update replaces the executable only when none is working. */
  readonly sessions?: {
    activity(agent: AgentId): { readonly busy: number }
    /** Gracefully ends idle sessions on that agent before its file is replaced. */
    closeIdle(agent: AgentId): Promise<void>
  }
}

export class OperationBusyError extends Error {}

const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
const TIMEOUTS: Record<OperationKind, number> = { install: 20 * 60_000, update: 20 * 60_000, signin: 10 * 60_000 }
const RUNNING = new Set<OperationState>(['installing', 'updating', 'waiting_for_user', 'waiting_for_idle'])

interface PendingUpdate { readonly id: string; readonly agent: AgentId; readonly requestedAt: string }

async function fetchInstaller(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'follow' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/** What there is now, in words: the report after every operation reads the CLI again. */
function describe(caps: AgentCapabilities): string {
  const { executable } = caps
  if (executable.state === 'missing') return 'not installed'
  if (executable.state === 'unavailable') return `present at ${executable.identity.path} but not answering (${executable.reason})`
  return `installed at ${executable.identity.path}${executable.identity.version ? ` (${executable.identity.version})` : ''}`
}

/** Found, but without what Cockpit needs to run it: kept, reported, never "rolled back". */
function incompatibility(caps: AgentCapabilities): string | undefined {
  if (caps.executable.state === 'unavailable') return caps.executable.reason
  if (caps.agent === 'claude' && caps.executable.state === 'found' && caps.settings.permissionMode?.state !== 'supported') {
    return caps.settings.permissionMode?.reason ?? 'its --help does not declare --permission-mode'
  }
  return undefined
}

export function createLifecycle(options: LifecycleOptions) {
  const home = options.home ?? homedir()
  const pathEnv = options.pathEnv ?? (() => process.env.PATH ?? '')
  const download = options.download ?? fetchInstaller
  const installers = options.installers ?? INSTALLERS
  const dir = join(options.stateRoot, 'agent-operations')
  const ops = new Map<string, { view: OperationView; run?: HelperRun }>()
  const listeners = new Set<(view: OperationView) => void>()
  const pendingFile = join(dir, 'pending-updates.json')
  const prefsFile = join(dir, 'preferences.json')
  const readJson = <T>(file: string, fallback: T): T => { try { return JSON.parse(readFileSync(file, 'utf8')) as T } catch { return fallback } }
  const writeJson = (file: string, value: unknown): void => {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }
  const pending = (): PendingUpdate[] => readJson<PendingUpdate[]>(pendingFile, []).filter((p) => typeof p?.id === 'string' && typeof p.agent === 'string')
  const clearPending = (id: string): void => { if (pending().some((p) => p.id === id)) writeJson(pendingFile, pending().filter((p) => p.id !== id)) }
  // Updates that were waiting when Cockpit quit come back as questions, not as work.
  for (const p of pending()) {
    ops.set(p.id, { view: { id: p.id, agent: p.agent, kind: 'update', state: 'pending_confirmation', startedAt: p.requestedAt, lines: [], logFile: join(dir, `${p.id}.log`),
      message: `An update to ${AGENT_LABEL[p.agent] ?? p.agent} was waiting when Cockpit closed. Resume it, or cancel it.` } })
  }

  const update = (id: string, patch: Partial<OperationView>): void => {
    const entry = ops.get(id)
    if (!entry) return
    entry.view = { ...entry.view, ...patch }
    if (entry.view.endedAt) {
      try { writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(entry.view, null, 2)}\n`, { mode: 0o600 }) } catch { /* the log is still there */ }
    }
    for (const listener of listeners) listener(entry.view)
  }
  const log = (id: string, line: string): void => {
    const entry = ops.get(id)
    if (!entry) return
    entry.view = { ...entry.view, lines: [...entry.view.lines, line].slice(-400) }
    try { writeFileSync(entry.view.logFile, `${line}\n`, { flag: 'a', mode: 0o600 }) } catch { /* shown anyway */ }
  }

  // The agent's own environment, minus anything of Cockpit's (tokens, Electron's Node mode).
  const agentEnv = (extra?: Readonly<Record<string, string>>): Record<string, string> => {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith('COCKPIT_') && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value
    const path = pathEnv()
    return { ...env, HOME: home, PATH: path.split(':').includes('/usr/bin') ? path : `${path}:${SYSTEM_PATH}`, ...extra }
  }
  // Installers see ~/.local/bin on their PATH, so none of them edits a shell profile (G-LIFECYCLE).
  const installEnv = (extra?: Readonly<Record<string, string>>): Record<string, string> => {
    const keep = ['USER', 'LOGNAME', 'TMPDIR', 'LANG', 'SHELL'] as const
    const env: Record<string, string> = { HOME: home, PATH: `${join(home, '.local', 'bin')}:${SYSTEM_PATH}`, TERM: 'dumb' }
    for (const key of keep) { const value = process.env[key]; if (value) env[key] = value }
    return { ...env, ...extra }
  }

  async function plan(agent: AgentId, kind: OperationKind): Promise<Plan> {
    if (kind === 'install') return installPlanFor(agent, await options.capabilities.get(agent), home)
    if (kind === 'update') return updatePlanFor(await options.capabilities.get(agent, { refresh: true }), { brew: resolveExecutable('brew', pathEnv())?.path })
    return signinPlanFor(await options.capabilities.get(agent))
  }

  function begin(agent: AgentId, kind: OperationKind, state: OperationState): string {
    for (const { view } of ops.values()) if (view.agent === agent && !view.endedAt) throw new OperationBusyError(`${AGENT_LABEL[agent]} already has an operation running`)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const id = randomUUID()
    ops.set(id, { view: { id, agent, kind, state, startedAt: new Date().toISOString(), lines: [], logFile: join(dir, `${id}.log`) } })
    writeFileSync(join(dir, `${id}.log`), '', { mode: 0o600 })
    return id
  }
  const finish = (id: string, state: OperationState, patch: Partial<OperationView> = {}): void => {
    const entry = ops.get(id)
    if (entry) entry.run = undefined
    if (entry?.view.kind === 'update') clearPending(id)
    update(id, { state, endedAt: new Date().toISOString(), ...patch })
  }

  /** Runs a waiting update once nothing uses its executable: close idle sessions, recheck, update. */
  const advance = (id: string): void => {
    const entry = ops.get(id)
    if (!entry || entry.view.state !== 'waiting_for_idle') return
    const { agent } = entry.view
    const label = AGENT_LABEL[agent]
    const busy = options.sessions?.activity(agent).busy ?? 0
    if (busy > 0) {
      update(id, { message: `Waiting for ${busy} conversation${busy === 1 ? '' : 's'} using ${label} to finish. New ${label} sessions wait until the update is done.` })
      return
    }
    update(id, { state: 'updating', message: `Closing idle ${label} sessions, then updating.` })
    void (async () => {
      await options.sessions?.closeIdle(agent)
      // Revalidate: what is installed now is what gets updated, by the manager that owns it now.
      const before = await options.capabilities.get(agent, { refresh: true })
      const p = updatePlanFor(before, { brew: resolveExecutable('brew', pathEnv())?.path })
      if (!p.available) { finish(id, 'error', { message: `Nothing was updated: ${p.reason}`, ...(p.manual ? { manual: p.manual } : {}) }); return }
      await updateCli(id, agent, before, p)
    })().catch((error: unknown) => finish(id, 'error', { message: `Cockpit could not finish: ${error instanceof Error ? error.message : String(error)}` }))
  }

  const run = (id: string, executable: string, args: readonly string[], env: Record<string, string>, kind: OperationKind, input = false): Promise<HelperExit> => {
    const entry = ops.get(id)!
    log(id, `$ ${[executable, ...args].join(' ')}`)
    const helper = runHelper({ executable, args, env, cwd: home, timeoutMs: options.timeoutMs?.[kind] ?? TIMEOUTS[kind], input, logFile: entry.view.logFile,
      onLine: (line) => { const e = ops.get(id); if (e) { e.view = { ...e.view, lines: [...helper.lines] }; for (const l of listeners) l(e.view) } } })
    entry.run = helper
    return helper.done
  }
  const exitText = (exit: HelperExit, what: string): string =>
    exit.error ? `${what} could not start (${exit.error})` : exit.timedOut ? `${what} was stopped after running too long` : `${what} exited with ${exit.code ?? exit.signal}`

  async function install(id: string, agent: AgentId): Promise<void> {
    const spec = installers[agent]!
    const manual = manualInstall(agent)
    let bytes: Buffer
    log(id, `Downloading ${spec.url}`)
    try { bytes = await download(spec.url) } catch (error) {
      finish(id, 'error', { message: `Could not download the official installer (${error instanceof Error ? error.message : String(error)}). Nothing was installed.`, manual })
      return
    }
    const sha = createHash('sha256').update(bytes).digest('hex')
    log(id, `sha256 ${sha}`)
    if (sha !== spec.sha256) {
      finish(id, 'error', { message: `The official installer has changed since this version of Cockpit reviewed it, so Cockpit did not run it. Run it yourself in Terminal if you trust it, then Recheck.`, manual })
      return
    }
    const script = join(dir, `${id}-installer.sh`)
    writeFileSync(script, bytes, { mode: 0o700 })
    const exit = await run(id, '/bin/bash', [script, ...spec.args], installEnv(spec.env), 'install')
    const caps = await options.capabilities.get(agent, { refresh: true })
    const label = AGENT_LABEL[agent]
    if (exit.cancelled) { finish(id, 'cancelled', { message: `Cancelled. ${label} is ${describe(caps)}.` }); return }
    if (exit.code !== 0 || caps.executable.state !== 'found') {
      finish(id, 'error', { message: `${exitText(exit, 'The installer')}. ${label} is now ${describe(caps)}. Its output is kept in the log.`, manual })
      return
    }
    const identity = caps.executable.identity
    const result = { path: identity.path, ...(identity.version ? { version: identity.version } : {}), auth: caps.auth.state }
    const broken = incompatibility(caps)
    if (broken) { finish(id, 'incompatible', { result, message: `${label} was installed but does not support what Cockpit needs: ${broken}.` }); return }
    finish(id, caps.auth.state === 'signed_out' ? 'auth_needed' : 'installed', { result,
      message: caps.auth.state === 'signed_out' ? `${label} is installed. Sign in to use it.` : `${label} is installed.` })
  }

  async function updateCli(id: string, agent: AgentId, before: AgentCapabilities, p: Extract<Plan, { available: true }>): Promise<void> {
    const previousVersion = before.executable.state === 'found' ? before.executable.identity.version : undefined
    const exit = await run(id, p.executable, p.args, agentEnv(p.env), 'update')
    const caps = await options.capabilities.get(agent, { refresh: true })
    const label = AGENT_LABEL[agent]
    if (exit.cancelled) { finish(id, 'cancelled', { message: `Cancelled. ${label} is ${describe(caps)}.` }); return }
    const manual = caps.executable.state === 'missing' ? manualInstall(agent) : `${AGENT_LABEL[agent] === 'Antigravity' ? 'agy' : agent} update`
    if (exit.code !== 0 || caps.executable.state !== 'found') {
      finish(id, 'error', { message: `${exitText(exit, 'The update')}. ${label} is now ${describe(caps)}. Your conversations are kept; the update's output is in the log.`, manual })
      return
    }
    const identity = caps.executable.identity
    const result = { path: identity.path, ...(identity.version ? { version: identity.version } : {}), ...(previousVersion ? { previousVersion } : {}), auth: caps.auth.state }
    const broken = incompatibility(caps)
    if (broken) {
      finish(id, 'incompatible', { result, message: `${label} is now ${identity.version ?? 'a new version'}, which does not support what Cockpit needs (${broken}). Your conversations are kept. Update it again when a fixed version is out, or reinstall a working one yourself.` })
      return
    }
    finish(id, 'updated', { result, message: identity.version === previousVersion ? `${label} is already up to date (${identity.version}).` : `${label} updated to ${identity.version}.` })
  }

  async function signin(id: string, agent: AgentId, p: Extract<Plan, { available: true }>): Promise<void> {
    const exit = await run(id, p.executable, p.args, agentEnv(), 'signin', true)
    const label = AGENT_LABEL[agent]
    if (exit.cancelled) { finish(id, 'cancelled', { message: 'Sign-in cancelled. Nothing else was changed.' }); return }
    const caps = await options.capabilities.get(agent, { refresh: true })
    if (exit.code !== 0) { finish(id, 'error', { message: `${exitText(exit, 'Sign-in')}. ${label} reports: ${caps.auth.state.replace('_', ' ')}.`, result: { auth: caps.auth.state } }); return }
    if (caps.auth.state === 'signed_in') { finish(id, 'verified', { message: `${label} is signed in${caps.auth.detail ? ` (${caps.auth.detail})` : ''}.`, result: { auth: 'signed_in' } }); return }
    finish(id, 'unknown', { message: `Sign-in finished, but ${label} does not confirm an account yet${caps.auth.reason ? `: ${caps.auth.reason}` : ''}.`, result: { auth: caps.auth.state } })
  }

  return {
    plan,
    /** The explicit action. Throws when the plan is not available (the plan says why). */
    async start(agent: AgentId, kind: OperationKind): Promise<OperationView> {
      const before = kind === 'update' ? await options.capabilities.get(agent, { refresh: true }) : await options.capabilities.get(agent)
      const p = kind === 'install' ? installPlanFor(agent, before, home) : kind === 'update' ? updatePlanFor(before, { brew: resolveExecutable('brew', pathEnv())?.path }) : signinPlanFor(before)
      if (!p.available) throw new Error(p.manual ? `${p.reason} Run it yourself: ${p.manual}` : p.reason)
      const id = begin(agent, kind, kind === 'install' ? 'installing' : kind === 'update' ? 'waiting_for_idle' : 'waiting_for_user')
      if (kind === 'update') {
        writeJson(pendingFile, [...pending(), { id, agent, requestedAt: ops.get(id)!.view.startedAt }])
        advance(id)
        return ops.get(id)!.view
      }
      const work = kind === 'install' ? install(id, agent) : signin(id, agent, p)
      work.catch((error: unknown) => finish(id, 'error', { message: `Cockpit could not finish: ${error instanceof Error ? error.message : String(error)}` }))
      return ops.get(id)!.view
    },
    get: (id: string): OperationView | undefined => ops.get(id)?.view,
    list: (): OperationView[] => [...ops.values()].map((e) => e.view),
    /** Typed input for a waiting helper; never logged. */
    write(id: string, text: string): void {
      const entry = ops.get(id)
      if (entry?.view.state === 'waiting_for_user') entry.run?.write(text)
    },
    /** Explicit confirmation of an update that was pending when Cockpit quit. */
    resume(id: string): boolean {
      const entry = ops.get(id)
      if (entry?.view.state !== 'pending_confirmation') return false
      update(id, { state: 'waiting_for_idle', message: undefined })
      advance(id)
      return true
    },
    /** Call when any agent session starts or finishes work. */
    activityChanged(): void {
      for (const { view } of [...ops.values()]) if (view.state === 'waiting_for_idle') advance(view.id)
    },
    /** Why a new session on this agent must not start now, if it must not. */
    launchBlock(agent: AgentId): string | undefined {
      for (const { view } of ops.values()) {
        if (view.agent !== agent || view.endedAt) continue
        const label = AGENT_LABEL[agent]
        if (view.state === 'waiting_for_idle') return `${label} is waiting to update, so new ${label} sessions start after it finishes. Your message is in the conversation but was not sent; send it again then, or cancel the update in the agent picker.`
        if (view.state === 'updating' || view.state === 'installing') return `${label} is being ${view.state === 'updating' ? 'updated' : 'installed'}. Your message is in the conversation but was not sent; send it again when that finishes.`
      }
      return undefined
    },
    skip(agent: AgentId, version: string): void {
      const prefs = readJson<{ skipped?: Partial<Record<AgentId, string>> }>(prefsFile, {})
      writeJson(prefsFile, { ...prefs, skipped: { ...prefs.skipped, [agent]: version } })
    },
    skipped(agent: AgentId): string | undefined {
      const value = readJson<{ skipped?: Partial<Record<AgentId, unknown>> }>(prefsFile, {}).skipped?.[agent]
      return typeof value === 'string' ? value : undefined
    },
    cancel(id: string): boolean {
      const entry = ops.get(id)
      if (entry && (entry.view.state === 'waiting_for_idle' || entry.view.state === 'pending_confirmation')) {
        finish(id, 'cancelled', { message: 'Update cancelled. Nothing was changed.' })
        return true
      }
      if (!entry || !RUNNING.has(entry.view.state) || !entry.run) return false
      entry.run.cancel()
      return true
    },
    subscribe(listener: (view: OperationView) => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export type Lifecycle = ReturnType<typeof createLifecycle>
