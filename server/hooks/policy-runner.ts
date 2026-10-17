// W13 U3c: Claude hooks on events that can block an action run through this runner, so a hook that
// fails, hangs, crashes or answers with something unrecognised denies instead of letting the action
// through. Natively Claude treats any exit other than 2, and its own timeout, as a non-blocking error:
// the tool runs, the prompt is sent, the turn ends. The runner turns every such case into exit 2,
// Claude's native block, and passes a hook's own valid answer through unchanged.
import { spawn } from 'node:child_process'

/** Events whose hooks can stop the protected action: a tool call, a permission, a prompt, the end of a turn. */
export const POLICY_EVENTS: ReadonlySet<string> = new Set(['PreToolUse', 'PermissionRequest', 'UserPromptSubmit', 'Stop', 'SubagentStop'])

export type HookOutcome =
  | { readonly kind: 'exit'; readonly code: number; readonly stdout: string; readonly stderr: string }
  | { readonly kind: 'signal'; readonly signal: string }
  | { readonly kind: 'timeout'; readonly ms: number }
  | { readonly kind: 'error'; readonly message: string }

export interface Verdict { readonly code: 0 | 2; readonly stdout: string; readonly stderr: string }

const deny = (why: string): Verdict => ({ code: 2, stdout: '', stderr: `Cockpit blocked this because a policy hook ${why}.\n` })

// The decisions each event accepts (Claude Code hooks reference). Anything else is unknown, and unknown denies.
const TOP_DECISIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  PreToolUse: new Set(['approve', 'block']), PermissionRequest: new Set([]),
  UserPromptSubmit: new Set(['block']), Stop: new Set(['block']), SubagentStop: new Set(['block']),
}
const PERMISSION_DECISIONS = new Set(['allow', 'deny', 'ask'])
const PERMISSION_BEHAVIOURS = new Set(['allow', 'deny'])

/** Why a hook's JSON answer is not one Claude would act on as intended, or undefined when it is. */
function unrecognised(event: string, answer: Record<string, unknown>): string | undefined {
  if (answer.decision !== undefined && !(typeof answer.decision === 'string' && TOP_DECISIONS[event]?.has(answer.decision))) return `answered with an unknown decision`
  if (answer.continue !== undefined && typeof answer.continue !== 'boolean') return 'answered with an invalid continue flag'
  const specific = answer.hookSpecificOutput
  if (specific === undefined) return undefined
  if (!specific || typeof specific !== 'object' || Array.isArray(specific)) return 'answered with invalid event output'
  const fields = specific as Record<string, unknown>
  if (fields.hookEventName !== undefined && fields.hookEventName !== event) return 'answered for a different event'
  if (fields.permissionDecision !== undefined && !(event === 'PreToolUse' && typeof fields.permissionDecision === 'string' && PERMISSION_DECISIONS.has(fields.permissionDecision))) {
    return 'answered with an unknown permission decision'
  }
  if (fields.decision !== undefined) {
    const behaviour = (fields.decision as { behavior?: unknown } | null)?.behavior
    if (!(event === 'PermissionRequest' && typeof behaviour === 'string' && PERMISSION_BEHAVIOURS.has(behaviour))) return 'answered with an unknown permission decision'
  }
  return undefined
}

/** What Claude should see for one hook run: its own answer when valid, otherwise a block. */
export function judge(event: string, outcome: HookOutcome): Verdict {
  if (outcome.kind === 'timeout') return deny(`did not answer within ${outcome.ms < 1000 ? `${outcome.ms} ms` : `${outcome.ms / 1000} second${outcome.ms === 1000 ? '' : 's'}`}`)
  if (outcome.kind === 'signal') return deny(`was stopped by ${outcome.signal}`)
  if (outcome.kind === 'error') return deny(`could not run (${outcome.message})`)
  if (outcome.code === 2) return { code: 2, stdout: '', stderr: outcome.stderr || 'Blocked by a policy hook.\n' }
  if (outcome.code !== 0) return deny(`failed with exit code ${outcome.code}`)
  const text = outcome.stdout.trim()
  // Plain text on success is not a decision to Claude: passed through as it would be natively. Anything that
  // looks like JSON is an attempted answer, and must be one Claude can act on.
  if (!text.startsWith('{') && !text.startsWith('[')) return { code: 0, stdout: outcome.stdout, stderr: outcome.stderr }
  let answer: unknown
  try { answer = JSON.parse(text) } catch { return deny('answered with malformed JSON') }
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return deny('answered with something other than an object')
  const why = unrecognised(event, answer as Record<string, unknown>)
  return why ? deny(why) : { code: 0, stdout: outcome.stdout, stderr: outcome.stderr }
}

const MAX_OUTPUT = 1024 * 1024
const KILL_GRACE_MS = 500

/** Runs one reviewed hook argv in its own process group; a timeout ends the whole group. */
export function runHook(argv: readonly string[], stdin: string, timeoutMs: number): Promise<HookOutcome> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try { child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], detached: true }) }
    catch (error) { resolve({ kind: 'error', message: error instanceof Error ? error.message : String(error) }); return }
    let stdout = '', stderr = '', settled = false, timedOut = false
    const finish = (outcome: HookOutcome): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(outcome) } }
    const group = (signal: NodeJS.Signals): void => { try { if (child.pid) process.kill(-child.pid, signal) } catch { /* Already gone. */ } }
    const timer = setTimeout(() => {
      timedOut = true
      group('SIGTERM')
      setTimeout(() => group('SIGKILL'), KILL_GRACE_MS).unref()
      // Answer now: a hook that ignores SIGTERM must not hold the action open past its timeout.
      finish({ kind: 'timeout', ms: timeoutMs })
    }, timeoutMs)
    child.stdout!.on('data', (chunk: Buffer) => { if (stdout.length < MAX_OUTPUT) stdout += chunk.toString('utf8') })
    child.stderr!.on('data', (chunk: Buffer) => { if (stderr.length < MAX_OUTPUT) stderr += chunk.toString('utf8') })
    child.on('error', (error) => finish({ kind: 'error', message: error.message }))
    child.on('close', (code, signal) => {
      if (timedOut) return
      finish(signal ? { kind: 'signal', signal } : { kind: 'exit', code: code ?? 1, stdout, stderr })
    })
    child.stdin!.on('error', () => { /* A hook may exit without reading its input. */ })
    child.stdin!.end(stdin)
  })
}

/**
 * The shell command Claude runs for one policy hook. The tail turns anything but 0 or 2 from the
 * runner itself (it could not start, or crashed) into Claude's native block.
 */
export function policyHookCommand(runner: { readonly command: string; readonly args: readonly string[]; readonly env?: Readonly<Record<string, string>> },
  event: string, timeoutMs: number, argv: readonly string[]): string {
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
  const env = Object.entries(runner.env ?? {}).map(([key, value]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid policy runner variable: ${key}`)
    return `${key}=${quote(value)} `
  }).join('')
  const run = [runner.command, ...runner.args, '--event', event, '--timeout-ms', String(timeoutMs), '--', ...argv].map(quote).join(' ')
  return `${env}${run}; s=$?; [ "$s" -eq 0 ] || exit 2`
}
