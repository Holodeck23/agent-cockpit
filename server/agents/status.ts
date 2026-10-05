// What the agent picker shows about each agent: is its CLI installed, and what did its
// provider last report about usage. Read-only: no sign-in, no agent calls, no polling.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseClaudeHelp } from './claude/capabilities.ts'
import type { ThreadStore } from '../threads/store.ts'
import type { AgentId, NormalizedEvent } from './types.ts'

type UsageEvent = Extract<NormalizedEvent, { kind: 'usage' }>

export interface AgentUsage extends Omit<UsageEvent, 'kind'> {
  /** When Cockpit received this report; it says nothing about usage since then. */
  readonly observedAt: string
}

export type Installation =
  | { readonly installed: true; readonly version: string }
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

export type ChromeProbe = () => Promise<ChromeReadiness>

export const probeChrome: ChromeProbe = () =>
  new Promise((resolve) => {
    const extension = existsSync(chromeHostManifest())
    execFile(AGENT_COMMANDS.claude, ['--help'], { timeout: VERSION_TIMEOUT_MS, maxBuffer: 256 * 1024 }, (error, stdout) => {
      let supported = false
      if (!error) { try { supported = parseClaudeHelp(String(stdout)).chrome } catch { supported = false } }
      resolve({ supported, extension })
    })
  })

export const AGENT_COMMANDS: Record<AgentId, string> = { claude: 'claude', codex: 'codex', antigravity: 'agy', opencode: 'opencode' }
const VERSION_TIMEOUT_MS = 10_000
const CACHE_MS = 60_000
/** Usage older than this many recently active threads is not worth scanning for. */
const MAX_THREADS_SCANNED = 50

export type VersionProbe = (command: string) => Promise<Installation>

export const probeVersion: VersionProbe = (command) =>
  new Promise((resolve) => {
    execFile(command, ['--version'], { timeout: VERSION_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ installed: true, version: stdout.trim().split('\n')[0] ?? '' })
        return
      }
      const code = (error as NodeJS.ErrnoException).code
      // The CLI's own first stderr line says more than Node's "Command failed: …".
      const reason = String(stderr).trim().split('\n')[0] || (error.killed ? 'timed out' : error.message)
      resolve({
        installed: false,
        problem: code === 'ENOENT' ? `${command} is not installed or not on your PATH` : `${command} --version failed: ${reason.slice(0, 200)}`,
      })
    })
  })

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

/** Installation is cached briefly (a version check spawns the CLI); usage is always fresh. */
export function createAgentStatus(store: ThreadStore, probe: VersionProbe = probeVersion, now: () => number = Date.now, chromeProbe: ChromeProbe = probeChrome) {
  let cached: { at: number; installs: Record<AgentId, Installation>; chrome: ChromeReadiness } | undefined
  return async (): Promise<AgentStatus[]> => {
    if (!cached || now() - cached.at > CACHE_MS) {
      const [claude, codex, antigravity, opencode] = await Promise.all([
        probe(AGENT_COMMANDS.claude), probe(AGENT_COMMANDS.codex), probe(AGENT_COMMANDS.antigravity), probe(AGENT_COMMANDS.opencode),
      ])
      const chrome = claude.installed ? await chromeProbe() : { supported: false, extension: false }
      cached = { at: now(), installs: { claude, codex, antigravity, opencode }, chrome }
    }
    const usage = latestUsage(store)
    return (['claude', 'codex', 'antigravity', 'opencode'] as const).map((id) => ({
      id,
      installation: cached!.installs[id],
      ...(usage[id] ? { usage: usage[id] } : {}),
      ...(id === 'claude' ? { chrome: cached!.chrome } : {}),
    }))
  }
}
