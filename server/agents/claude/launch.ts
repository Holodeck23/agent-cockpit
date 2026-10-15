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
import { claudeLaunchSchema } from './flags.ts'
import { writePrivateClaudeConfig } from './private-config.ts'
import { parseClaudeLine } from './parse.ts'
import { probeClaude, validateClaudeArgs } from './capabilities.ts'
import { watchChrome } from './chrome-watch.ts'
import { inheritedEnv } from '../inherited-env.ts'

export interface ClaudeLaunchDeps {
  /** Override for tests or a non-PATH install. */
  executable?: string
  /** Added to the agent's environment (and so inherited by its MCP servers). */
  env?: Readonly<Record<string, string>>
  /** Recheck approved source revisions after the CLI probe, immediately before spawn. */
  validateSources?: () => void
  /** Shortened only by bounded startup tests; production waits for the pinned CLI's init response. */
  initializeTimeoutMs?: number
}

/**
 * Starts one long-lived `claude -p` process in stream-json mode. The process
 * stays alive across turns; each `send` is a new user message on stdin.
 */
export function launchClaude(input: ClaudeLaunchInput, events: EventSink, deps: ClaudeLaunchDeps = {}): AgentSession {
  claudeLaunchSchema.parse(input) // Validate before probing any executable.
  const controller = new AbortController()
  let session: AgentSession | undefined
  // Use my Chrome: the first Chrome call gets a bounded wait (chrome-watch.ts).
  const onEvent: EventSink = input.chrome ? watchChrome(events, () => session?.interrupt()) : events
  let ended = false
  let initialized = false
  let startupError: string | undefined
  const startupEvents: NormalizedEvent[] = []
  // Every message sent before the --help probe resolves waits here, in order, and is written once Claude is up.
  let pending: readonly { readonly text: string; readonly queuedId?: string; readonly images?: readonly OutgoingImage[] }[] = []
  let replays = false
  const finish = (error?: unknown, stopped = false) => {
    if (ended) return
    ended = true
    pending = []
    if (error) onEvent({ kind: 'error', message: error instanceof Error ? error.message : 'Could not check Claude Code compatibility' })
    onEvent({ kind: 'result', ok: false, ...(stopped ? { stopped: true } : {}) })
    onEvent({ kind: 'exit', code: null })
  }
  const closeFailedStart = (): void => {
    if (session) void session.close().catch((error: unknown) => onEvent({ kind: 'error', message: `Could not close Claude Code after startup failed: ${error instanceof Error ? error.message : String(error)}` }))
  }
  const fromProvider: EventSink = (event) => {
    if (ended) return
    if (!initialized) {
      if (event.kind === 'error') startupError = event.message
      else if (event.kind === 'exit') finish(new Error(startupError ?? 'Claude Code exited before it was ready to take input'))
      else startupEvents.push(event)
      return
    }
    onEvent(event)
  }
  // Defer spawning until callers can register the session (or immediately close
  // it). In particular, never abort an execFile whose spawn has already failed.
  const ready = Promise.resolve().then(() => ended ? undefined :
    probeClaude(deps.executable ?? 'claude', input.cwd, cleanClaudeEnv(deps.env), controller.signal))
    .then(async (capabilities) => {
      if (ended || !capabilities) return
      deps.validateSources?.()
      const prompt = input.appendSystemPrompt && capabilities.appendSystemPromptFile ? writePromptFile(input.appendSystemPrompt) : undefined
      const selected = claudeLaunchSchema.parse(input)
      const privateConfig = writePrivateClaudeConfig(selected.mcpConfig, selected.useHooks ? selected.hookSettings : { disableAllHooks: true })
      try {
        const args = buildClaudeArgs({ ...input, mcpConfigFile: privateConfig.mcpFile, settingsFile: privateConfig.settingsFile,
          ...(prompt ? { appendSystemPrompt: undefined, appendSystemPromptFile: prompt.file } : {}) }, capabilities)
        validateClaudeArgs(args, capabilities)
        replays = capabilities.replayUserMessages
        const started = spawnClaude(input, fromProvider, deps, args, () => { prompt?.remove(); privateConfig.remove() })
        session = started.session
        await started.initialized
        if (startupError) throw new Error(startupError)
        deps.validateSources?.()
      } catch (error) {
        prompt?.remove()
        privateConfig.remove()
        throw error
      }
      if (ended) return
      initialized = true
      for (const event of startupEvents) onEvent(event)
      startupEvents.length = 0
      const waiting = pending
      pending = []
      for (const message of waiting) {
        session.send(message.text, message.queuedId, message.images)
        // Without --replay-user-messages Claude never says when it takes a message, so one the manager is
        // waiting on counts as taken once it is written, as a message sent after startup would have.
        if (message.queuedId && !replays) onEvent({ kind: 'user_taken', text: message.text, id: message.queuedId })
      }
    }).catch((error: unknown) => { finish(error); closeFailedStart() })
  return {
    agent: 'claude',
    send(text, queuedId, images) {
      if (session && initialized) session.send(text, queuedId, images)
      else if (!ended) pending = [...pending, { text, ...(queuedId ? { queuedId } : {}), ...(images ? { images } : {}) }]
      else onEvent({ kind: 'error', message: 'Agent process is not running' })
    },
    respondApproval: (approval, behavior) => session?.respondApproval(approval, behavior),
    respondQuestion: (question, answers) => session?.respondQuestion?.(question, answers),
    // A message sent mid-turn while Claude is still starting waits in `pending` and counts as queued, so the manager
    // tracks it like any other; whether Claude replays it is known once Claude is up.
    queues: () => initialized ? replays : !ended,
    preparing: () => !initialized && !ended,
    cancelQueued(queuedId) {
      if (session && initialized) return session.cancelQueued?.(queuedId) ?? Promise.resolve(false)
      // Not written yet: taking it back is dropping it from the wait.
      const kept = pending.filter((message) => message.queuedId !== queuedId)
      const dropped = kept.length < pending.length
      pending = kept
      return Promise.resolve(dropped)
    },
    interrupt() {
      if (session && initialized) session.interrupt()
      else if (session) { finish(undefined, true); closeFailedStart() }
      else { finish(undefined, true); controller.abort() }
    },
    async close() {
      if (session) { if (!initialized) finish(undefined, true); await session.close(); await ready; return }
      finish(undefined, true)
      controller.abort()
      await ready
    },
    alive: () => !ended && (session ? session.alive() : true),
  }
}

/** Neither an inherited parent grant nor account overrides may enter Claude's ambient environment. */
function cleanClaudeEnv(extra: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const { COCKPIT_MCP_URL: _url, COCKPIT_MCP_TOKEN: _token, ...clean } = { ...inheritedEnv(), ...extra }
  return clean
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

function spawnClaude(input: ClaudeLaunchInput, onEvent: EventSink, deps: ClaudeLaunchDeps, args: string[], cleanup: () => void): {
  readonly session: AgentSession; readonly initialized: Promise<void>
} {
  const child = spawn(deps.executable ?? 'claude', args, {
    cwd: input.cwd,
    stdio: ['pipe', 'pipe', 'pipe'], ...AGENT_SPAWN,
    env: cleanClaudeEnv(deps.env),
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
  type ControlResponse = { readonly subtype?: string; readonly response?: unknown }
  const replies = new Map<string, (response: ControlResponse | undefined) => void>()
  const askRaw = (request: Record<string, unknown>, timeoutMs = 5000): Promise<ControlResponse | undefined> => new Promise((resolve) => {
    if (exited || !child.stdin.writable) { resolve(undefined); return }
    const id = randomUUID()
    const timeout = setTimeout(() => { if (replies.delete(id)) resolve(undefined) }, timeoutMs)
    replies.set(id, (response) => { clearTimeout(timeout); resolve(response) })
    write({ type: 'control_request', request_id: id, request })
  })
  const ask = async (request: Record<string, unknown>): Promise<unknown> => (await askRaw(request))?.response

  // The CLI responds to initialize without a user prompt. Do not dispatch the first
  // message until this protocol boundary has answered; a timeout keeps it recoverable.
  const initTimeoutMs = deps.initializeTimeoutMs ?? 15_000
  const initialized = askRaw({ subtype: 'initialize', hooks: null }, initTimeoutMs).then((response) => {
    if (response?.subtype !== 'success') throw new Error(`Claude Code did not become ready to take input within ${initTimeoutMs} ms`)
  })

  createInterface({ input: child.stdout }).on('line', (line) => {
    if (replies.size > 0 && line.includes('"control_response"')) {
      try {
        const message = JSON.parse(line) as { response?: { request_id?: string; subtype?: string; response?: unknown } }
        const id = message.response?.request_id
        if (id && replies.has(id)) { replies.get(id)!(message.response); replies.delete(id); return }
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
    onEvent({ kind: 'error', message: startErrorMessage('claude', error, input.cwd) })
    // A failed spawn has no exit event. Complete the turn and release the session now.
    if (!child.pid && !exited) {
      exited = true
      cleanup()
      for (const resolve of replies.values()) resolve(undefined)
      replies.clear()
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

  const session: AgentSession = {
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
  return { session, initialized }
}
