// Who is signed in, in one account context, from the CLI's own non-generating report (G-ACCOUNTS
// "Identity"): Claude's `auth status --json`, Codex's app-server `account/read`. Neither sends a
// prompt. The email is hashed at once and only a hint is kept; tokens are never asked for.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { queryAppServer } from '../codex/app-server-query.ts'
import type { AgentId } from '../types.ts'
import type { IdentityObservation } from './types.ts'

const TIMEOUT_MS = 20_000

export const shortHash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 10)

/** "d…@example.com": enough to tell two accounts apart on screen, not the address. */
export function emailHint(email: string): string {
  const at = email.lastIndexOf('@')
  if (at < 1) return '…'
  return `${email.charAt(0)}…${email.slice(at)}`
}

export interface IdentityProbeOptions {
  readonly executable: string
  /** The full environment for the CLI: the profile's context variable is already in it. */
  readonly env: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

export type IdentityProbe = (agent: AgentId, options: IdentityProbeOptions) => Promise<IdentityObservation>

const unknown = (source: IdentityObservation['source'], reason: string): IdentityObservation =>
  ({ state: 'unknown', observedAt: new Date().toISOString(), source, reason })

/** Parses `claude auth status --json`. Exported for tests. */
export function claudeIdentityFrom(stdout: string): IdentityObservation {
  const source = 'claude auth status'
  let report: { loggedIn?: unknown; email?: unknown; orgId?: unknown; subscriptionType?: unknown } | undefined
  try { report = JSON.parse(stdout) as typeof report } catch { return unknown(source, 'Claude Code did not report its sign-in state.') }
  if (report?.loggedIn !== true) return unknown(source, 'Claude Code reports no signed-in account here.')
  const email = typeof report.email === 'string' ? report.email.toLowerCase() : undefined
  if (!email) return unknown(source, 'Claude Code is signed in but did not say to which account.')
  const org = typeof report.orgId === 'string' ? report.orgId : ''
  const plan = typeof report.subscriptionType === 'string' ? report.subscriptionType : undefined
  return { state: 'known', key: `${shortHash(email)}:${org ? shortHash(org) : '-'}`, hint: [emailHint(email), plan].filter(Boolean).join(' · '), observedAt: new Date().toISOString(), source }
}

/** Reads one `account/read` result. Exported for tests. */
export function codexIdentityFrom(result: unknown): IdentityObservation {
  const source = 'codex account/read'
  const holder = (result ?? {}) as { account?: { email?: unknown; planType?: unknown; type?: unknown } | null; email?: unknown; planType?: unknown }
  const account = holder.account ?? holder
  const email = typeof account?.email === 'string' ? account.email.toLowerCase() : undefined
  if (!email) return unknown(source, 'Codex reports no signed-in ChatGPT account here.')
  const plan = typeof account.planType === 'string' ? account.planType : undefined
  return { state: 'known', key: shortHash(email), hint: [emailHint(email), plan].filter(Boolean).join(' · '), observedAt: new Date().toISOString(), source }
}

function claudeIdentity({ executable, env, timeoutMs = TIMEOUT_MS }: IdentityProbeOptions): Promise<IdentityObservation> {
  return new Promise((resolve) => {
    const child = execFile(executable, ['auth', 'status', '--json'], { env: { ...env }, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, encoding: 'utf8' },
      (error, stdout) => {
        // `auth status` exits non-zero when signed out but still prints its JSON.
        if (error && !stdout) { resolve(unknown('claude auth status', error.killed ? 'claude auth status timed out' : `claude auth status failed (${(error as NodeJS.ErrnoException).code ?? error.message})`)); return }
        resolve(claudeIdentityFrom(String(stdout)))
      })
    child.stdin?.on('error', () => {}).end()
  })
}

async function codexIdentity({ executable, env, timeoutMs = TIMEOUT_MS }: IdentityProbeOptions): Promise<IdentityObservation> {
  const answer = await queryAppServer(executable, 'account/read', {}, { env, timeoutMs })
  return answer.error !== undefined ? unknown('codex account/read', answer.error) : codexIdentityFrom(answer.result)
}

/** The real probe: only Claude and Codex have one (the others stay on their CLI default). */
export const observeIdentity: IdentityProbe = (agent, options) => {
  if (agent === 'claude') return claudeIdentity(options)
  if (agent === 'codex') return codexIdentity(options)
  return Promise.resolve(unknown(agent === 'antigravity' ? 'claude auth status' : 'codex account/read', 'Cockpit does not read this agent’s account.'))
}
