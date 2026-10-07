// Is there a newer version? (W10.3 L1) Only a version feed that answered counts: offline, a rate
// limit, a malformed answer or an agent with no feed is "unavailable", never "up to date". A skipped
// version hides exactly that version, never a different newer one, and never blocks Update.
import type { AgentCapabilities } from '../capabilities/types.ts'
import type { AgentId } from '../types.ts'

export type LatestCheck =
  | { readonly state: 'available' | 'up_to_date' | 'skipped'; readonly installed: string; readonly latest: string; readonly source: string; readonly checkedAt: string; readonly note?: string }
  | { readonly state: 'unavailable'; readonly installed?: string; readonly reason: string; readonly checkedAt: string }

const FEEDS: Partial<Record<AgentId, { readonly url: string; readonly source: string }>> = {
  claude: { url: 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest', source: 'npm registry' },
  codex: { url: 'https://registry.npmjs.org/@openai/codex/latest', source: 'npm registry' },
}

/** The x.y.z in "2.1.291 (Claude Code)", "codex-cli 0.160.1" or "1.3.0". */
export function parseVersion(text: string | undefined): string | undefined {
  return text?.match(/\b(\d+\.\d+\.\d+)\b/)?.[1]
}

const compare = (a: string, b: string): number => {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } })
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}${response.status === 429 ? ' (rate limited)' : ''}`), { status: response.status })
  return response.json() as Promise<unknown>
}

export async function checkLatest(caps: AgentCapabilities, options: { readonly fetchJson?: (url: string) => Promise<unknown>; readonly now?: () => number; readonly skipped?: string } = {}): Promise<LatestCheck> {
  const checkedAt = new Date((options.now ?? Date.now)()).toISOString()
  const installed = caps.executable.state === 'found' ? parseVersion(caps.executable.identity.version) : undefined
  const feed = FEEDS[caps.agent]
  if (!feed) return { state: 'unavailable', ...(installed ? { installed } : {}), reason: 'This agent has no version feed Cockpit can read; Update asks the CLI itself.', checkedAt }
  if (!installed) return { state: 'unavailable', reason: 'The installed version is not known yet; Refresh first.', checkedAt }
  let answer: unknown
  try { answer = await (options.fetchJson ?? fetchJson)(feed.url) } catch (error) {
    return { state: 'unavailable', installed, reason: `Could not check for updates (${error instanceof Error ? error.message : String(error)}).`, checkedAt }
  }
  const latest = typeof answer === 'object' && answer !== null && typeof (answer as { version?: unknown }).version === 'string' ? parseVersion((answer as { version: string }).version) : undefined
  if (!latest) return { state: 'unavailable', installed, reason: 'The version feed gave an answer Cockpit could not read.', checkedAt }
  const note = caps.manager?.kind === 'homebrew' ? 'Homebrew may offer a new version a little later than the npm registry.' : undefined
  const base = { installed, latest, source: feed.source, checkedAt, ...(note ? { note } : {}) }
  if (compare(latest, installed) <= 0) return { state: 'up_to_date', ...base }
  return { state: options.skipped === latest ? 'skipped' : 'available', ...base }
}
