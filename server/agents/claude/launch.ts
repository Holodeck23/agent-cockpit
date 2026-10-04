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
  let replays = false
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
      replays = capabilities.replayUserMessages
      session = spawnClaude(input, onEvent, deps, args)
      if (pending !== undefined) { session.send(pending); pending = undefined }
    }).catch((error: unknown) => finish(error))
  return {
    agent: 'claude',
    send(text, queuedId) {
      if (session) session.send(text, queuedId)
      else if (!ended && pending === undefined) pending = text
      else onEvent({ kind: 'error', message: ended ? 'Agent process is not running' : 'Claude Code is still starting' })
    },
    respondApproval: (approval, behavior) => session?.respondApproval(approval, behavior),
    respondQuestion: (question, answers) => session?.respondQuestion?.(question, answers),
    queues: () => Boolean(session && replays),
    cancelQueued: (queuedId) => session?.cancelQueued?.(queuedId) ?? Promise.resolve(false),
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

  // Our own control requests that wait for Claude's answer (cancel_async_message).
  const replies = new Map<string, (response: unknown) => void>()
  const ask = (request: Record<string, unknown>): Promise<unknown> => new Promise((resolve) => {
    if (exited || !child.stdin.writable) { resolve(undefined); return }
    const id = randomUUID()
    replies.set(id, resolve)
    write({ type: 'control_request', request_id: id, request })
    setTimeout(() => { if (replies.delete(id)) resolve(undefined) }, 5000)
  })

  createInterface({ input: child.stdout }).on('line', (line) => {
    if (replies.size > 0 && line.includes('"control_response"')) {
      try {
        const message = JSON.parse(line) as { response?: { request_id?: string; response?: unknown } }
        const id = message.response?.request_id
        if (id && replies.has(id)) { replies.get(id)!(message.response?.response); replies.delete(id); return }
      } catch { /* parsed below as usual */ }
    }
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
    for (const resolve of replies.values()) resolve(undefined)
    replies.clear()
    if (code !== 0 && code !== null && stderrTail.length > 0) {
      onEvent({ kind: 'error', message: stderrTail.join('\n') })
    }
    onEvent({ kind: 'exit', code })
  })

  return {
    agent: 'claude',
    send(text: string, queuedId?: string) {
      write({ type: 'user', ...(queuedId ? { uuid: queuedId } : {}), message: { role: 'user', content: [{ type: 'text', text }] } })
    },
    async cancelQueued(queuedId: string) {
      const response = await ask({ subtype: 'cancel_async_message', message_uuid: queuedId })
      return typeof response === 'object' && response !== null && (response as { cancelled?: unknown }).cancelled === true
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
    respondQuestion(question: PendingApproval, answers: Readonly<Record<string, string>> | undefined) {
      // AskUserQuestion reads the answers from its own input, keyed by question text.
      const response = answers
        ? { behavior: 'allow', updatedInput: { ...(question.input as object), answers } }
        : { behavior: 'deny', message: 'The user closed the questions without answering. Carry on without the answers, or ask in your reply.' }
      write({ type: 'control_response', response: { subtype: 'success', request_id: question.requestId, response } })
      onEvent({ kind: 'question_answered', requestId: question.requestId, answers: answers ?? {}, ...(answers ? {} : { dismissed: true }) })
    },
    interrupt() {
      write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } })
    },
    close: () => stopChild(child, () => !exited),
    alive: () => !exited,
  }
}
