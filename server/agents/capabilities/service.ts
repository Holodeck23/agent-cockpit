// One cache for every capability record (W10.1). A record is reused only for the same account
// context and the same executable file (path + realpath + size/mtime/inode), and for at most a
// minute. A replaced file, a PATH change or Refresh probes again; a failed probe reports its
// failure and never falls back to what another executable or account said.
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import type { AgentId } from '../types.ts'
import { detectManager } from './manager.ts'
import { failure, probeAgent, runCommand, type Runner } from './probes.ts'
import { resolveExecutable, type ResolvedExecutable } from './resolve.ts'
import { AGENT_COMMANDS, type AgentCapabilities, type ExecutableIdentity, type ModelOption } from './types.ts'

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
  /** Where agy's last model list is kept across restarts; memory only when absent. */
  readonly listingsFile?: string
}

interface Listing {
  readonly models: readonly ModelOption[]
  readonly at: string
}

const isListing = (value: unknown): value is Listing => {
  const v = value as Partial<Listing> | null
  return typeof v === 'object' && v !== null && typeof v.at === 'string' && !Number.isNaN(Date.parse(v.at)) && Array.isArray(v.models) && v.models.length > 0
    && v.models.every((m) => typeof m?.id === 'string' && /^[A-Za-z0-9._\-[\]]{1,100}$/.test(m.id) && (m.label === undefined || typeof m.label === 'string'))
}

/** A missing or damaged file is no listing: the picker then asks for Refresh, as before. */
function readListings(file: string | undefined): Record<string, Listing> {
  if (!file) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, Listing] => isListing(entry[1])))
  } catch {
    return {}
  }
}

function writeListings(file: string | undefined, listings: Record<string, Listing>): void {
  if (!file) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify(listings))
    renameSync(`${file}.tmp`, file)
  } catch {
    // Only a convenience for the next view; the list in memory still serves this run.
  }
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

  // agy's last model list, kept apart from the record: agy replaces itself after nearly every run,
  // so a list tied to one executable was almost never there to show, and the picker had no models.
  const listings = new Map<string, Listing>(Object.entries(readListings(options.listingsFile)))
  const keepListing = (key: string, caps: AgentCapabilities): void => {
    if (caps.agent !== 'antigravity' || caps.models.state !== 'supported' || !caps.models.value?.length || !caps.probedAt) return
    listings.set(key, { models: caps.models.value, at: caps.probedAt })
    writeListings(options.listingsFile, Object.fromEntries(listings))
  }
  /** Not run for the view: the last list agy gave, labelled as an older check. A launch checks again. */
  const lastListed = (caps: AgentCapabilities, key: string): AgentCapabilities => {
    const last = listings.get(key)
    if (!last) return caps
    return { ...caps, probedAt: last.at, stale: true, models: { state: 'supported', value: last.models, source: 'agy models' } }
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
    keepListing(key, caps)
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
      if (!request.refresh && agent === 'antigravity' && request.purpose !== 'launch') return lastListed(unchecked(agent, context, found), key)
      const running = inflight.get(key)
      if (running) return running
      const next = probe(agent, context, key, found).finally(() => inflight.delete(key))
      inflight.set(key, next)
      return next
    },
  }
}
