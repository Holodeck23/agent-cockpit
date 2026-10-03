import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { startErrorMessage } from '../start-error.ts'
import { stopChild } from '../stop.ts'
import type { AgentSession, ApprovalBehavior, EventSink, PendingApproval } from '../types.ts'
import { buildClaudeArgs, type ClaudeLaunchInput } from './flags.ts'
import { parseClaudeLine } from './parse.ts'
import { probeClaude, validateClaudeArgs } from './capabilities.ts'

export interface ClaudeLaunchDeps {
  /** Override for tests or a non-PATH install. */
  executable?: string
  /** Added to the agent's environment (and so inherited by its MCP servers). */
  env?: Readonly<Record<string, string>>
}

/**
 * Starts one long-lived `claude -p` process in stream-json mode. The process
 * stays alive across turns; each `send` is a new user message on stdin.
 */
export function launchClaude(input: ClaudeLaunchInput, onEvent: EventSink, deps: ClaudeLaunchDeps = {}): AgentSession {
  buildClaudeArgs(input) // Validate caller input synchronously, before probing any executable.
  const controller = new AbortController()
  let session: AgentSession | undefined
  let ended = false
  let pending: string | undefined
  const finish = (error?: unknown, stopped = false) => {
    if (ended) return
    ended = true
    pending = undefined
    if (error) onEvent({ kind: 'error', message: error instanceof Error ? error.message : 'Could not check Claude Code compatibility' })
    onEvent({ kind: 'result', ok: false, ...(stopped ? { stopped: true } : {}) })
    onEvent({ kind: 'exit', code: null })
  }
  // Defer spawning until callers can register the session (or immediately close
  // it). In particular, never abort an execFile whose spawn has already failed.
  const ready = Promise.resolve().then(() => ended ? undefined :
    probeClaude(deps.executable ?? 'claude', input.cwd, { ...process.env, ...deps.env }, controller.signal))
    .then((capabilities) => {
      if (ended || !capabilities) return
      const args = buildClaudeArgs(input, capabilities)
      validateClaudeArgs(args, capabilities)
      session = spawnClaude(input, onEvent, deps, args)
      if (pending !== undefined) { session.send(pending); pending = undefined }
    }).catch((error: unknown) => finish(error))
  return {
    agent: 'claude',
    send(text) {
      if (session) session.send(text)
      else if (!ended && pending === undefined) pending = text
      else onEvent({ kind: 'error', message: ended ? 'Agent process is not running' : 'Claude Code is still starting' })
    },
    respondApproval: (approval, behavior) => session?.respondApproval(approval, behavior),
    interrupt() {
      if (session) session.interrupt()
      else { finish(undefined, true); controller.abort() }
    },
    async close() {
      if (session) { await session.close(); return }
      finish(undefined, true)
      controller.abort()
      await ready
    },
    alive: () => session ? session.alive() : !ended,
  }
}

function spawnClaude(input: ClaudeLaunchInput, onEvent: EventSink, deps: ClaudeLaunchDeps, args: string[]): AgentSession {
  const child = spawn(deps.executable ?? 'claude', args, {
    cwd: input.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...deps.env },
  })
  let exited = false
  const stderrTail: string[] = []

  const write = (message: unknown): void => {
    if (exited || !child.stdin.writable) {
      onEvent({ kind: 'error', message: 'Agent process is not running' })
      return
    }
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  createInterface({ input: child.stdout }).on('line', (line) => {
    for (const event of parseClaudeLine(line)) onEvent(event)
  })
  createInterface({ input: child.stderr }).on('line', (line) => {
    stderrTail.push(line)
    if (stderrTail.length > 20) stderrTail.shift()
  })
  child.on('error', (error) => {
    onEvent({ kind: 'error', message: startErrorMessage('claude', error) })
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
    if (code !== 0 && code !== null && stderrTail.length > 0) {
      onEvent({ kind: 'error', message: stderrTail.join('\n') })
    }
    onEvent({ kind: 'exit', code })
  })

  return {
    agent: 'claude',
    send(text: string) {
      write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
    },
    respondApproval(approval: PendingApproval, behavior: ApprovalBehavior) {
      // updatedInput must echo the original input: an empty object would replace it.
      const response =
        behavior === 'deny'
          ? { behavior: 'deny', message: 'Denied from Agent Cockpit' }
          : {
              behavior: 'allow',
              updatedInput: approval.input,
              ...(behavior === 'allow_session' ? { updatedPermissions: approval.suggestions } : {}),
            }
      write({ type: 'control_response', response: { subtype: 'success', request_id: approval.requestId, response } })
      onEvent({ kind: 'approval_resolved', requestId: approval.requestId, behavior })
    },
    interrupt() {
      write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } })
    },
    close: () => stopChild(child, () => !exited),
    alive: () => !exited,
  }
}
