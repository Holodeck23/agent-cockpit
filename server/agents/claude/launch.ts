import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { startErrorMessage } from '../start-error.ts'
import { AGENT_SPAWN, stopChild } from '../stop.ts'
import { guardStdin } from '../stdin.ts'
import type { AgentSession, ApprovalBehavior, EventSink, NormalizedEvent, OutgoingImage, PendingApproval } from '../types.ts'
import { claudeUserMessage } from '../image-input.ts'
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
  let pending: { readonly text: string; readonly images?: readonly OutgoingImage[] } | undefined
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
      const prompt = input.appendSystemPrompt && capabilities.appendSystemPromptFile ? writePromptFile(input.appendSystemPrompt) : undefined
      try {
        const args = buildClaudeArgs(prompt ? { ...input, appendSystemPrompt: undefined, appendSystemPromptFile: prompt.file } : input, capabilities)
        validateClaudeArgs(args, capabilities)
        replays = capabilities.replayUserMessages
        session = spawnClaude(input, onEvent, deps, args, () => prompt?.remove())
      } catch (error) {
        prompt?.remove()
        throw error
      }
      if (pending !== undefined) { session.send(pending.text, undefined, pending.images); pending = undefined }
    }).catch((error: unknown) => finish(error))
  return {
    agent: 'claude',
    send(text, queuedId, images) {
      if (session) session.send(text, queuedId, images)
      else if (!ended && pending === undefined) pending = { text, ...(images ? { images } : {}) }
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

/**
 * The appended prompt (guidance, project instructions, a switch handoff) goes in a file only
 * this user can read: argv is visible to every account on the Mac, and a whole handoff (J5)
 * would crowd argv's 1 MB limit. Claude reads it at startup; it is removed when the process ends.
 */
function writePromptFile(text: string): { readonly file: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-prompt-'))
  const file = join(dir, 'prompt.md')
  writeFileSync(file, text, { mode: 0o600 })
  return { file, remove: () => rmSync(dir, { recursive: true, force: true }) }
}

function spawnClaude(input: ClaudeLaunchInput, onEvent: EventSink, deps: ClaudeLaunchDeps, args: string[], cleanup: () => void): AgentSession {
  const child = spawn(deps.executable ?? 'claude', args, {
    cwd: input.cwd,
    stdio: ['pipe', 'pipe', 'pipe'], ...AGENT_SPAWN,
    env: { ...process.env, ...deps.env },
  })
  let exited = false
  const stderrTail: string[] = []
  guardStdin(child, () => { if (!exited) onEvent({ kind: 'error', message: 'Claude Code stopped taking input; that message was not delivered' }) })

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
    // A parser that throws on an odd line must not escape the readline callback (H1).
    let events: NormalizedEvent[]
    try { events = parseClaudeLine(line) } catch (error) {
      onEvent({ kind: 'error', message: `Could not read Claude Code output: ${error instanceof Error ? error.message : String(error)}` })
      return
    }
    for (const event of events) onEvent(event)
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
      cleanup()
      onEvent({ kind: 'result', ok: false })
      onEvent({ kind: 'exit', code: null })
    }
  })
  child.on('exit', (code) => {
    if (exited) return
    exited = true
    cleanup()
    for (const resolve of replies.values()) resolve(undefined)
    replies.clear()
    if (code !== 0 && code !== null && stderrTail.length > 0) {
      onEvent({ kind: 'error', message: stderrTail.join('\n') })
    }
    onEvent({ kind: 'exit', code })
  })

  return {
    agent: 'claude',
    send(text: string, queuedId?: string, images?: readonly OutgoingImage[]) {
      write(claudeUserMessage(text, images, queuedId))
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
