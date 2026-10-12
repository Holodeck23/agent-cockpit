// The non-generating checks behind a capability record (G-LIFECYCLE "Probes"). None sends a
// prompt or starts a session; each has a timeout; a failure is reported, never guessed around.
import { execFile } from 'node:child_process'
import { parseClaudeHelp } from '../claude/capabilities.ts'
import { claudeModels } from '../claude/models.ts'
import { queryAppServer, type AppServerQuery } from '../codex/app-server-query.ts'
import type { AgentId } from '../types.ts'
import type { AuthCapability, Capability, ModelOption } from './types.ts'

export interface RunResult {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  /** Spawn error code, e.g. ENOENT when the file vanished after lookup. */
  readonly errno?: string
}

export type Runner = (executable: string, args: readonly string[], timeoutMs: number) => Promise<RunResult>

export const runCommand: Runner = (executable, args, timeoutMs) =>
  new Promise((resolve) => {
    const child = execFile(executable, [...args], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 512 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      const errno = typeof (error as NodeJS.ErrnoException | null)?.code === 'string' ? (error as NodeJS.ErrnoException).code : undefined
      resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr), timedOut: Boolean(error?.killed && !errno), ...(errno ? { errno } : {}) })
    })
    // A check never answers a prompt: a CLI that waits for input sees end of input, not a hang.
    child.stdin?.on('error', () => {}).end()
  })

const firstLine = (text: string): string => text.trim().split('\n')[0]?.trim().slice(0, 200) ?? ''

/** Why a run failed, in the CLI's own words where it gave any. */
export function failure(command: string, result: RunResult, timeoutMs: number): string {
  if (result.timedOut) return `${command} timed out after ${Math.round(timeoutMs / 1000)} s`
  return `${command} failed: ${firstLine(result.stderr) || firstLine(result.stdout) || result.errno || 'no output'}`
}

export interface AgentProbe {
  readonly models: Capability<readonly ModelOption[]> & { readonly source?: string }
  readonly settings: Readonly<Record<string, Capability>>
  readonly auth: AuthCapability
}

const CLAUDE_SETTINGS = {
  permissionMode: '--permission-mode',
  permissionPrompts: '--permission-prompts',
  replayUserMessages: '--replay-user-messages',
  promptSuggestions: '--prompt-suggestions',
  appendSystemPromptFile: '--append-system-prompt-file',
  chrome: '--chrome',
} as const

async function claudeHelp(path: string, run: Runner, timeoutMs: number): Promise<Pick<AgentProbe, 'settings' | 'models'>> {
  const result = await run(path, ['--help'], timeoutMs)
  const source = 'claude --help'
  const all = (capability: Capability): Record<string, Capability> => Object.fromEntries(Object.keys(CLAUDE_SETTINGS).map((name) => [name, capability]))
  const unlisted = (reason: string): AgentProbe['models'] => ({ state: 'unavailable', reason: `${NOT_LISTED.claude} (${reason})`, source })
  if (!result.ok) {
    const reason = failure('claude --help', result, timeoutMs)
    return { settings: all({ state: 'unavailable', reason }), models: unlisted(reason) }
  }
  try {
    const caps = parseClaudeHelp(result.stdout)
    const has: Record<keyof typeof CLAUDE_SETTINGS, boolean> = {
      permissionMode: caps.options.has('--permission-mode'),
      permissionPrompts: caps.permissionPrompts,
      replayUserMessages: caps.replayUserMessages,
      promptSuggestions: caps.promptSuggestions,
      appendSystemPromptFile: caps.appendSystemPromptFile,
      chrome: caps.chrome,
    }
    const settings: Record<string, Capability> = Object.fromEntries(Object.entries(CLAUDE_SETTINGS).map(([name, flag]) => [name, has[name as keyof typeof has]
      ? { state: 'supported' as const } : { state: 'unsupported' as const, reason: `This Claude Code does not declare ${flag}.` }]))
    const models = caps.modelAliases.length > 0 ? { state: 'supported' as const, value: claudeModels(caps.modelAliases), source } : unlisted('--model names no aliases')
    return { settings, models }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { settings: all({ state: 'unavailable', reason }), models: unlisted(reason) }
  }
}

async function claudeAuth(path: string, run: Runner, timeoutMs: number): Promise<AuthCapability> {
  const result = await run(path, ['auth', 'status', '--json'], timeoutMs)
  let report: { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown } | undefined
  try { report = JSON.parse(result.stdout) as typeof report } catch { report = undefined }
  if (report?.loggedIn === true && result.ok) {
    const detail = [report.authMethod, report.subscriptionType].filter((v): v is string => typeof v === 'string' && v.length > 0).join(' · ')
    return { state: 'signed_in', ...(detail ? { detail } : {}) }
  }
  if (report?.loggedIn === false) return { state: 'signed_out', reason: 'Claude Code reports no signed-in account.' }
  return { state: 'unknown', reason: failure('claude auth status', result, timeoutMs) }
}

async function codexAuth(path: string, run: Runner, timeoutMs: number): Promise<AuthCapability> {
  const result = await run(path, ['login', 'status'], timeoutMs)
  const text = `${result.stdout}\n${result.stderr}`
  if (/not logged in/i.test(text)) return { state: 'signed_out', reason: 'Codex reports no signed-in account.' }
  if (result.ok && /logged in/i.test(text)) return { state: 'signed_in', detail: firstLine(text.replace(/^\s+/, '')) }
  return { state: 'unknown', reason: failure('codex login status', result, timeoutMs) }
}

/** `agy models` prints a progress line, then `id<TAB>label` per model. Ids keep the launch-input alphabet. */
export function parseAgyModels(stdout: string): ModelOption[] {
  const models: ModelOption[] = []
  for (const line of stdout.split('\n')) {
    const [id, label] = line.split('\t')
    if (!id || label === undefined || !/^[A-Za-z0-9._\-[\]]{1,100}$/.test(id.trim())) continue
    models.push({ id: id.trim(), ...(label.trim() ? { label: label.trim() } : {}) })
  }
  return models
}

async function agyModels(path: string, run: Runner, timeoutMs: number): Promise<Pick<AgentProbe, 'models' | 'auth'>> {
  const result = await run(path, ['models'], timeoutMs)
  if (result.ok) {
    const models = parseAgyModels(result.stdout)
    return {
      auth: { state: 'signed_in' },
      models: models.length > 0
        ? { state: 'supported', value: models, source: 'agy models' }
        : { state: 'unavailable', reason: 'agy models listed no models.', source: 'agy models' },
    }
  }
  // Only agy's own sign-in message means signed out; offline or a timeout is unknown (G-LIFECYCLE).
  if (!result.timedOut && /please sign in/i.test(`${result.stdout}\n${result.stderr}`)) {
    return {
      auth: { state: 'signed_out', reason: 'Antigravity is not signed in. Run agy in Terminal once to sign in, then Refresh.' },
      models: { state: 'unavailable', reason: 'Sign in to Antigravity to see your models.', source: 'agy models' },
    }
  }
  const reason = failure('agy models', result, timeoutMs)
  return { auth: { state: 'unknown', reason }, models: { state: 'unavailable', reason, source: 'agy models' } }
}

/** model/list's visible models, in the CLI's order. Exported for tests. */
export function parseCodexModels(result: unknown): ModelOption[] {
  const data = (result as { data?: unknown } | undefined)?.data
  if (!Array.isArray(data)) return []
  const models: ModelOption[] = []
  for (const entry of data as Array<{ id?: unknown; model?: unknown; displayName?: unknown; hidden?: unknown }>) {
    const id = typeof entry.id === 'string' ? entry.id : typeof entry.model === 'string' ? entry.model : undefined
    if (!id || entry.hidden === true || !/^[A-Za-z0-9._\-[\]/:]{1,100}$/.test(id)) continue
    models.push({ id, ...(typeof entry.displayName === 'string' && entry.displayName ? { label: entry.displayName } : {}) })
  }
  return models
}

/** The models this Codex offers its signed-in account, from app-server model/list (no prompt is sent). */
async function codexModels(path: string, query: AppServerQuery, timeoutMs: number): Promise<AgentProbe['models']> {
  const source = 'codex app-server model/list'
  const answer = await query(path, 'model/list', {}, { timeoutMs })
  if (answer.error !== undefined) return { state: 'unavailable', reason: `${NOT_LISTED.codex} (${answer.error})`, source }
  const models = parseCodexModels(answer.result)
  return models.length > 0 ? { state: 'supported', value: models, source } : { state: 'unavailable', reason: `${NOT_LISTED.codex} (model/list returned none)`, source }
}

const NOT_LISTED: Record<Exclude<AgentId, 'antigravity'>, string> = {
  claude: 'Claude Code did not name its model aliases: pick Other for a full model id, or leave it on Default.',
  codex: 'Codex did not list its models: type a model id, or leave it blank for your default.',
  opencode: 'OpenCode takes provider/model ids such as openrouter/…; Cockpit does not list them.',
}

/** Everything after `--version`, for one found executable. */
export async function probeAgent(agent: AgentId, path: string, run: Runner, timeoutMs: number, query: AppServerQuery = queryAppServer): Promise<AgentProbe> {
  switch (agent) {
    case 'claude': {
      const [help, auth] = await Promise.all([claudeHelp(path, run, timeoutMs), claudeAuth(path, run, timeoutMs)])
      return { ...help, auth }
    }
    case 'codex': {
      const [auth, models] = await Promise.all([codexAuth(path, run, timeoutMs), codexModels(path, query, timeoutMs)])
      return { settings: {}, auth, models }
    }
    case 'antigravity':
      return { settings: {}, ...(await agyModels(path, run, timeoutMs)) }
    case 'opencode':
      return { settings: {}, auth: { state: 'not_checked', reason: 'Cockpit does not check OpenCode sign-in.' }, models: { state: 'unavailable', reason: NOT_LISTED.opencode } }
  }
}
