import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { EFFORTS, PERMISSION_MODES } from '../claude/flags.ts'
import { startErrorMessage } from '../start-error.ts'
import { stopChild } from '../stop.ts'
import type { AgentSession, EventSink, OutgoingImage } from '../types.ts'
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
}

export function launchAntigravity(input: AntigravityLaunchInput, onEvent: EventSink, deps: AntigravityLaunchDeps = {}): AgentSession {
  const value = inputSchema.parse(input)
  // --add-dir needs the folder to exist, even before the first image arrives.
  if (value.imagesDir) mkdirSync(value.imagesDir, { recursive: true, mode: 0o700 })
  const child = spawn(deps.executable ?? 'agy', buildAntigravityArgs(value), {
    cwd: value.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...deps.env },
  })
  let exited = false
  let firstTurn = true
  const stderrTail: string[] = []

  createInterface({ input: child.stdout }).on('line', (line) => {
    for (const event of parseAntigravityLine(line)) onEvent(event)
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
    if (code !== 0 && code !== null && stderrTail.length > 0) onEvent({ kind: 'error', message: stderrTail.join('\n') })
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
      child.stdin.write(`${JSON.stringify({ event: 'user', message: { content } })}\n`)
    },
    respondApproval() {
      // Headless agy applies policy before execution and never emits host approval requests.
    },
    interrupt() {
      if (!exited) {
        onEvent({ kind: 'result', ok: false, stopped: true })
        child.kill('SIGINT')
      }
    },
    close: () => stopChild(child, () => !exited),
    alive: () => !exited,
  }
}
