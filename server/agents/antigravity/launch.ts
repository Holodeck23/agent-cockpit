import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { EFFORTS, PERMISSION_MODES } from '../claude/flags.ts'
import { startErrorMessage } from '../start-error.ts'
import { AGENT_SPAWN, signalAgent, stopChild } from '../stop.ts'
import { guardStdin } from '../stdin.ts'
import type { AgentSession, EventSink, NormalizedEvent, OutgoingImage } from '../types.ts'
import type { AgentCapabilities } from '../capabilities/types.ts'
import { withImagePaths } from '../image-input.ts'
import { parseAntigravityLine } from './parse.ts'

const inputSchema = z.object({
  cwd: z.string().min(1),
  model: z.string().max(100).regex(/^[A-Za-z0-9._\-[\]]+$/).optional(),
  effort: z.enum(EFFORTS).optional(),
  permissionMode: z.enum(PERMISSION_MODES).default('manual'),
  resume: z.uuid().optional(),
  instructions: z.string().max(500_000).optional(),
  /** The conversation's image folder: agy reads only its workspace in manual mode, so it is added to it. */
  imagesDir: z.string().min(1).optional(),
})

export type AntigravityLaunchInput = z.input<typeof inputSchema>

/** The current CLI accepts low/medium/high; stronger shared picker values clamp to high. */
function antigravityEffort(effort: (typeof EFFORTS)[number] | undefined): string | undefined {
  return effort === 'xhigh' || effort === 'max' ? 'high' : effort
}

/**
 * Antigravity headless mode cannot pause for a host approval. Its default policy
 * auto-allows workspace file operations and soft-denies commands that need a prompt.
 * Auto-like modes use the CLI's explicit all-tools flag; plan mode remains read-only.
 */
export function buildAntigravityArgs(input: AntigravityLaunchInput): string[] {
  const value = inputSchema.parse(input)
  const effort = antigravityEffort(value.effort)
  const auto = ['auto', 'dontAsk', 'bypassPermissions'].includes(value.permissionMode)
  return [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--disable-slash-commands',
    ...(value.model ? ['--model', value.model] : []),
    ...(effort ? ['--effort', effort] : []),
    ...(value.resume ? ['--conversation', value.resume] : []),
    ...(value.permissionMode === 'plan' ? ['--mode', 'plan'] : []),
    ...(auto ? ['--dangerously-skip-permissions'] : []),
    ...(value.imagesDir ? ['--add-dir', value.imagesDir] : []),
  ]
}

export interface AntigravityLaunchDeps {
  readonly executable?: string
  readonly env?: Readonly<Record<string, string>>
  /**
   * The capability record for the agy a launch would run, checked just before it starts (W10-01):
   * its resolved executable is the one spawned (W10-02), whatever the picker had cached.
   */
  readonly check?: () => Promise<AgentCapabilities>
}

/** The executable to run, or why not to start. A model list agy could not give is left to agy. */
export function antigravityLaunchTarget(caps: AgentCapabilities, model: string | undefined): { readonly executable: string } | { readonly refused: string } {
  const { executable } = caps
  if (executable.state === 'missing') return { refused: `Antigravity is not installed: ${executable.reason}. Install it, then retry. Your conversation has been kept; no agent turn was started.` }
  if (executable.state === 'unavailable') return { refused: `Antigravity at ${executable.identity.path} did not answer (${executable.reason}). Check it in Terminal, then retry. Your conversation has been kept; no agent turn was started.` }
  const listed = caps.models.state === 'supported' ? caps.models.value ?? [] : undefined
  if (model && listed && !listed.some((m) => m.id === model)) {
    return { refused: `This Antigravity (${executable.identity.version ?? 'version unknown'}) does not offer the model ${model}. Pick one it lists, or leave the model blank for its default. Your conversation has been kept; no agent turn was started.` }
  }
  return { executable: executable.identity.path }
}

export function launchAntigravity(input: AntigravityLaunchInput, onEvent: EventSink, deps: AntigravityLaunchDeps = {}): AgentSession {
  const value = inputSchema.parse(input)
  const { check } = deps
  if (!check) return spawnAntigravity(value, onEvent, deps.executable ?? 'agy', deps.env)
  let session: AgentSession | undefined
  let ended = false
  let pending: { readonly text: string; readonly queuedId?: string; readonly images?: readonly OutgoingImage[] }[] = []
  const finish = (message?: string, stopped = false): void => {
    if (ended) return
    ended = true
    pending = []
    if (message) onEvent({ kind: 'error', message })
    onEvent({ kind: 'result', ok: false, ...(stopped ? { stopped: true } : {}) })
    onEvent({ kind: 'exit', code: null })
  }
  const ready = Promise.resolve().then(() => (ended ? undefined : check())).then((caps) => {
    if (ended || !caps) return
    const target = antigravityLaunchTarget(caps, value.model)
    if ('refused' in target) { finish(target.refused); return }
    session = spawnAntigravity(value, onEvent, target.executable, deps.env)
    for (const message of pending) session.send(message.text, message.queuedId, message.images)
    pending = []
  }, (error: unknown) => finish(`Could not check Antigravity before starting it (${error instanceof Error ? error.message : String(error)}). Retry, or Refresh it in the agent picker. No agent turn was started.`))
  return {
    agent: 'antigravity',
    send(text, queuedId, images) {
      if (session) session.send(text, queuedId, images)
      else if (!ended) pending.push({ text, ...(queuedId ? { queuedId } : {}), ...(images ? { images } : {}) })
      else onEvent({ kind: 'error', message: 'Agent process is not running' })
    },
    respondApproval() {
      // Headless agy applies policy before execution and never emits host approval requests.
    },
    interrupt() {
      if (session) session.interrupt()
      else finish(undefined, true)
    },
    async close() {
      if (session) { await session.close(); return }
      finish(undefined, true)
      await ready
    },
    alive: () => (session ? session.alive() : !ended),
  }
}

function spawnAntigravity(value: z.output<typeof inputSchema>, onEvent: EventSink, executable: string, env: Readonly<Record<string, string>> | undefined): AgentSession {
  // --add-dir needs the folder to exist, even before the first image arrives.
  if (value.imagesDir) mkdirSync(value.imagesDir, { recursive: true, mode: 0o700 })
  const child = spawn(executable, buildAntigravityArgs(value), {
    cwd: value.cwd,
    stdio: ['pipe', 'pipe', 'pipe'], ...AGENT_SPAWN,
    env: { ...process.env, ...env },
  })
  let exited = false
  let firstTurn = true
  // Set by Stop until the next message: what agy reports about the stopped turn is not shown as a failure.
  let stopping = false
  const stderrTail: string[] = []
  guardStdin(child, () => { if (!exited) onEvent({ kind: 'error', message: 'Antigravity stopped taking input; that message was not delivered' }) })

  createInterface({ input: child.stdout }).on('line', (line) => {
    // A parser that throws on an odd line must not escape the readline callback (H1).
    let events: NormalizedEvent[]
    try { events = parseAntigravityLine(line) } catch (error) {
      onEvent({ kind: 'error', message: `Could not read Antigravity output: ${error instanceof Error ? error.message : String(error)}` })
      return
    }
    // After Stop the turn has already ended as stopped: agy's own "interrupted" result is not a failure.
    for (const event of events) if (!(stopping && (event.kind === 'result' || event.kind === 'error'))) onEvent(event)
  })
  createInterface({ input: child.stderr }).on('line', (line) => {
    stderrTail.push(line)
    if (stderrTail.length > 20) stderrTail.shift()
  })
  child.on('error', (error) => {
    onEvent({ kind: 'error', message: startErrorMessage('antigravity', error) })
    // A failed spawn has no exit event. Complete the turn and release the session now.
    if (!child.pid && !exited) {
      exited = true
      onEvent({ kind: 'result', ok: false })
      onEvent({ kind: 'exit', code: null })
    }
  })
  child.on('exit', (code) => {
    if (exited) return
    exited = true
    if (!stopping && code !== 0 && code !== null && stderrTail.length > 0) onEvent({ kind: 'error', message: stderrTail.join('\n') })
    // A command agy started for the stopped turn may ignore SIGINT (a background job does): it ends with agy.
    if (stopping && child.pid) try { process.kill(-child.pid, 'SIGTERM') } catch { /* nothing left in the group */ }
    onEvent({ kind: 'exit', code })
  })

  return {
    agent: 'antigravity',
    send(text: string, _queuedId?: string, images?: readonly OutgoingImage[]) {
      if (exited || !child.stdin.writable) {
        onEvent({ kind: 'error', message: 'Agent process is not running' })
        return
      }
      // stream-json takes text blocks only (1.2.14: 'image is not supported'), so images go by path.
      const message = withImagePaths(text, images)
      const content = firstTurn && value.instructions
        ? `<cockpit-instructions>\n${value.instructions}\n</cockpit-instructions>\n\n${message}`
        : message
      firstTurn = false
      stopping = false
      child.stdin.write(`${JSON.stringify({ event: 'user', message: { content } })}\n`)
    },
    respondApproval() {
      // Headless agy applies policy before execution and never emits host approval requests.
    },
    interrupt() {
      if (!exited) {
        stopping = true
        onEvent({ kind: 'result', ok: false, stopped: true })
        // The whole group: a shell command agy is running stops too, not only agy (dogfood 10-08: `sleep 45`).
        signalAgent(child, 'SIGINT')
      }
    },
    close: () => stopChild(child, () => !exited),
    alive: () => !exited,
  }
}
