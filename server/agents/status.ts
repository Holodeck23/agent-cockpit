// What the agent picker shows about each agent: is its CLI installed, and what did its
// provider last report about usage. Read-only: no sign-in, no agent calls, no polling.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CapabilityService } from './capabilities/service.ts'
import { AGENT_COMMANDS, AGENT_IDS, type AgentCapabilities } from './capabilities/types.ts'
import type { ThreadStore } from '../threads/store.ts'
import type { AgentId, NormalizedEvent } from './types.ts'

type UsageEvent = Extract<NormalizedEvent, { kind: 'usage' }>

export interface AgentUsage extends Omit<UsageEvent, 'kind'> {
  /** When Cockpit received this report; it says nothing about usage since then. */
  readonly observedAt: string
}

/** `version` is absent while the CLI is found but not checked yet (Antigravity before Refresh). */
export type Installation =
  | { readonly installed: true; readonly version?: string }
  | { readonly installed: false; readonly problem: string }

/**
 * Use my Chrome (H4), checked without starting a turn: does this Claude Code take --chrome, and is
 * the Claude extension's native helper registered with Chrome? Whether Chrome answers is only known
 * from a real call (server/agents/claude/chrome-watch.ts).
 */
export interface ChromeReadiness {
  readonly supported: boolean
  readonly extension: boolean
}

export interface AgentStatus {
  readonly id: AgentId
  readonly installation: Installation
  readonly usage?: AgentUsage
  /** Claude only. */
  readonly chrome?: ChromeReadiness
}

/** Where Chrome looks for the Claude extension's helper; an override for tests and proofs. */
export const chromeHostManifest = (): string => join(process.env.COCKPIT_CHROME_NATIVE_HOSTS
  ?? join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'), 'com.anthropic.claude_code_browser_extension.json')

export { AGENT_COMMANDS }
/** Usage older than this many recently active threads is not worth scanning for. */
const MAX_THREADS_SCANNED = 50

/** The picker's summary of a capability record: a failed check is "present but unusable", not "not installed". */
export function installationOf(caps: AgentCapabilities): Installation {
  const { executable } = caps
  if (executable.state === 'missing') return { installed: false, problem: executable.reason }
  if (executable.state === 'unavailable') return { installed: false, problem: `${executable.identity.path} was found but did not answer: ${executable.reason}` }
  return { installed: true, ...(executable.identity.version !== undefined ? { version: executable.identity.version } : {}) }
}

/** A fixed per-command answer, for tests and proofs that must not run real CLIs. */
export type VersionProbe = (command: string) => Promise<Installation>

export function fixedCapabilities(probe: VersionProbe): CapabilityService {
  return {
    async get(agent, request = {}) {
      const command = AGENT_COMMANDS[agent]
      const result = await probe(command)
      const identity = { command, path: command, realpath: command, fingerprint: `fixture:${command}` }
      return {
        agent, context: request.context ?? 'default', models: { state: 'not_checked' }, settings: {}, auth: { state: 'not_checked' },
        executable: result.installed ? { state: 'found', identity: { ...identity, ...(result.version !== undefined ? { version: result.version } : {}) } } : { state: 'missing', reason: result.problem },
      }
    },
  }
}

/**
 * The latest usage report per agent, newest threads first. A thread's events are
 * attributed to whichever agent was running it at the time, so switches are followed.
 */
export function latestUsage(store: ThreadStore): Partial<Record<AgentId, AgentUsage>> {
  const found: Partial<Record<AgentId, AgentUsage>> = {}
  const threads = [...store.list()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_THREADS_SCANNED)
  for (const meta of threads) {
    const events = store.events(meta.id)
    const firstSwitch = events.find((e) => e.event.kind === 'agent_switch')?.event
    let agent: AgentId = firstSwitch?.kind === 'agent_switch' ? firstSwitch.from : meta.settings.agent
    for (const { ts, event } of events) {
      if (event.kind === 'agent_switch') agent = event.to
      else if (event.kind === 'usage') {
        const current = found[agent]
        if (!current || current.observedAt < ts) {
          const { kind: _kind, ...report } = event
          found[agent] = { ...report, observedAt: ts }
        }
      }
    }
  }
  return found
}

/** Installation and Chrome readiness come from the capability cache (one probe policy); usage is always fresh. */
export function createAgentStatus(store: ThreadStore, capabilities: CapabilityService, chromeManifest: () => string = chromeHostManifest) {
  return async (): Promise<AgentStatus[]> => {
    const records = await Promise.all(AGENT_IDS.map((id) => capabilities.get(id)))
    const usage = latestUsage(store)
    return records.map((caps) => ({
      id: caps.agent,
      installation: installationOf(caps),
      ...(usage[caps.agent] ? { usage: usage[caps.agent] } : {}),
      ...(caps.agent === 'claude' ? { chrome: {
        supported: caps.settings.chrome?.state === 'supported',
        extension: caps.executable.state === 'found' && existsSync(chromeManifest()),
      } } : {}),
    }))
  }
}
