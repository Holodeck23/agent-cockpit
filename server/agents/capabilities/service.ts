// One cache for every capability record (W10.1). A record is reused only for the same account
// context and the same executable file (path + realpath + size/mtime/inode), and for at most a
// minute. A replaced file, a PATH change or Refresh probes again; a failed probe reports its
// failure and never falls back to what another executable or account said.
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import type { AgentId } from '../types.ts'
import { detectManager } from './manager.ts'
import { failure, probeAgent, runCommand, type Runner } from './probes.ts'
import { resolveExecutable, type ResolvedExecutable } from './resolve.ts'
import { AGENT_COMMANDS, type AgentCapabilities, type ExecutableIdentity } from './types.ts'

export const CAPABILITY_CACHE_MS = 60_000
const realHome = (home: string): string => { try { return realpathSync(home) } catch { return home } }
const PROBE_TIMEOUT_MS = 10_000

export interface CapabilityServiceOptions {
  /** The PATH launches use; read on every request so a PATH change is seen. */
  readonly pathEnv?: () => string
  readonly now?: () => number
  readonly home?: string
  readonly timeoutMs?: number
  readonly run?: Runner
}

export interface CapabilityRequest {
  /** Probe now, whatever the cache holds. */
  readonly refresh?: boolean
  /** The account/config context; `default` until account profiles exist (order 16). */
  readonly context?: string
  /**
   * `launch`: just before starting the agent (W10-01). A fresh record is reused; anything older
   * or unchecked is probed, never served stale. `view` (default): what the picker shows.
   */
  readonly purpose?: 'view' | 'launch'
}

export interface CapabilityService {
  get(agent: AgentId, request?: CapabilityRequest): Promise<AgentCapabilities>
}

interface Entry {
  readonly caps: AgentCapabilities
  readonly path: string
  readonly fingerprint: string
  readonly at: number
}

export function createCapabilityService(options: CapabilityServiceOptions = {}): CapabilityService {
  const pathEnv = options.pathEnv ?? (() => process.env.PATH ?? '')
  const now = options.now ?? Date.now
  // Resolved, as executable paths are: /var/folders is /private/var/folders on macOS.
  const home = realHome(options.home ?? homedir())
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
  const run = options.run ?? runCommand
  const cache = new Map<string, Entry>()
  const inflight = new Map<string, Promise<AgentCapabilities>>()

  const identityOf = (agent: AgentId, found: ResolvedExecutable, version?: string): ExecutableIdentity => ({
    command: AGENT_COMMANDS[agent], path: found.path, realpath: found.realpath, fingerprint: found.fingerprint, ...(version !== undefined ? { version } : {}),
  })

  /** Found on PATH, nothing asked yet: Antigravity before Refresh (running agy can start its updater). */
  const unchecked = (agent: AgentId, context: string, found: ResolvedExecutable): AgentCapabilities => {
    const reason = 'Not checked yet. Refresh checks it (running agy can also start its own updater).'
    return {
      agent, context, executable: { state: 'found', identity: identityOf(agent, found) }, manager: detectManager(agent, found.realpath, home),
      models: { state: 'not_checked', reason }, settings: {}, auth: { state: 'not_checked', reason },
    }
  }

  async function probe(agent: AgentId, context: string, key: string, found: ResolvedExecutable): Promise<AgentCapabilities> {
    const started = now()
    const command = AGENT_COMMANDS[agent]
    const base = { agent, context, probedAt: new Date(started).toISOString(), manager: detectManager(agent, found.realpath, home) }
    const version = await run(found.path, ['--version'], timeoutMs)
    let caps: AgentCapabilities
    if (version.errno === 'ENOENT') {
      caps = { ...base, executable: { state: 'missing', reason: `${command} disappeared while Cockpit was checking it` }, models: { state: 'not_checked' }, settings: {}, auth: { state: 'not_checked' } }
    } else if (!version.ok) {
      const reason = failure(`${command} --version`, version, timeoutMs)
      caps = { ...base, executable: { state: 'unavailable', reason, identity: identityOf(agent, found) },
        models: { state: 'not_checked', reason }, settings: {}, auth: { state: 'not_checked', reason } }
    } else {
      const identity = identityOf(agent, found, version.stdout.trim().split('\n')[0]?.trim() ?? '')
      caps = { ...base, executable: { state: 'found', identity }, ...(await probeAgent(agent, found.path, run, timeoutMs)) }
    }
    // A self-updater may have replaced the file meanwhile (agy does, seconds after any run).
    const after = resolveExecutable(command, pathEnv())
    if (!after || after.path !== found.path || after.fingerprint !== found.fingerprint) {
      cache.delete(key)
      return { ...caps, changedDuringProbe: true }
    }
    cache.set(key, { caps, path: found.path, fingerprint: found.fingerprint, at: started })
    return caps
  }

  return {
    async get(agent, request = {}) {
      const context = request.context ?? 'default'
      const key = `${agent}\u0000${context}`
      const found = resolveExecutable(AGENT_COMMANDS[agent], pathEnv())
      if (!found) {
        cache.delete(key)
        return { agent, context, executable: { state: 'missing', reason: `${AGENT_COMMANDS[agent]} is not installed or not on the PATH Cockpit uses` },
          models: { state: 'not_checked' }, settings: {}, auth: { state: 'not_checked' } }
      }
      const cached = cache.get(key)
      const same = cached !== undefined && cached.path === found.path && cached.fingerprint === found.fingerprint
      if (!same) cache.delete(key)
      if (!request.refresh && same) {
        if (now() - cached.at <= CAPABILITY_CACHE_MS) return cached.caps
        // Not re-run on a view: shown as an older check until Refresh or launch.
        if (agent === 'antigravity' && request.purpose !== 'launch') return { ...cached.caps, stale: true }
      }
      if (!request.refresh && agent === 'antigravity' && request.purpose !== 'launch') return unchecked(agent, context, found)
      const running = inflight.get(key)
      if (running) return running
      const next = probe(agent, context, key, found).finally(() => inflight.delete(key))
      inflight.set(key, next)
      return next
    },
  }
}
