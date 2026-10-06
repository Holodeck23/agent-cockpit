// The non-generating checks behind a capability record (G-LIFECYCLE "Probes"). None sends a
// prompt or starts a session; each has a timeout; a failure is reported, never guessed around.
import { execFile } from 'node:child_process'
import { parseClaudeHelp } from '../claude/capabilities.ts'
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

async function claudeSettings(path: string, run: Runner, timeoutMs: number): Promise<Record<string, Capability>> {
  const result = await run(path, ['--help'], timeoutMs)
  const all = (capability: Capability): Record<string, Capability> => Object.fromEntries(Object.keys(CLAUDE_SETTINGS).map((name) => [name, capability]))
  if (!result.ok) return all({ state: 'unavailable', reason: failure('claude --help', result, timeoutMs) })
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
    return Object.fromEntries(Object.entries(CLAUDE_SETTINGS).map(([name, flag]) => [name, has[name as keyof typeof has]
      ? { state: 'supported' } : { state: 'unsupported', reason: `This Claude Code does not declare ${flag}.` }]))
  } catch (error) {
    return all({ state: 'unavailable', reason: error instanceof Error ? error.message : String(error) })
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

const NOT_LISTED: Record<Exclude<AgentId, 'antigravity'>, string> = {
  claude: 'Claude Code has no model list command: type an alias (haiku, sonnet, opus) or a full model id, or leave it blank for your default.',
  codex: 'Codex lists models only inside a session: type a model id, or leave it blank for your default.',
  opencode: 'OpenCode takes provider/model ids such as openrouter/…; Cockpit does not list them.',
}

/** Everything after `--version`, for one found executable. */
export async function probeAgent(agent: AgentId, path: string, run: Runner, timeoutMs: number): Promise<AgentProbe> {
  switch (agent) {
    case 'claude': {
      const [settings, auth] = await Promise.all([claudeSettings(path, run, timeoutMs), claudeAuth(path, run, timeoutMs)])
      return { settings, auth, models: { state: 'unavailable', reason: NOT_LISTED.claude } }
    }
    case 'codex':
      return { settings: {}, auth: await codexAuth(path, run, timeoutMs), models: { state: 'unavailable', reason: NOT_LISTED.codex } }
    case 'antigravity':
      return { settings: {}, ...(await agyModels(path, run, timeoutMs)) }
    case 'opencode':
      return { settings: {}, auth: { state: 'not_checked', reason: 'Cockpit does not check OpenCode sign-in.' }, models: { state: 'unavailable', reason: NOT_LISTED.opencode } }
  }
}
