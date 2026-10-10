import { spawn } from 'node:child_process'
import { startErrorMessage } from '../start-error.ts'
import { AGENT_SPAWN, stopChild } from '../stop.ts'
import type { AgentId, AgentSession, ApprovalBehavior, EventSink, OutgoingImage, PendingApproval } from '../types.ts'
import { acpPrompt } from '../image-input.ts'
import { createRpcClient } from '../codex/rpc.ts'
import { acpTool, acpTurnEnd, parseAcpUpdate } from './parse.ts'
import { inheritedEnv } from '../inherited-env.ts'

// A coding agent that speaks the Agent Client Protocol over stdio (OpenCode: `opencode acp`; Gemini CLI:
// `gemini --acp`). Cockpit is the client: it starts or loads a session, sends each turn with
// session/prompt, shows session/request_permission as an approval card, and cancels with session/cancel.
// It declines the optional client capabilities (file system, terminal), so the agent uses its own tools.

export interface AcpMcpServer {
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

export interface AcpLaunchInput {
  readonly agent: AgentId
  readonly label: string
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  /** Session to load; absent starts a new one, whose id arrives as a `session` event. */
  readonly resume?: string
  /** Cockpit guidance and project instructions: ACP has no system prompt, so they lead the first message of a new session. */
  readonly instructions?: string
  readonly mcpServers?: readonly AcpMcpServer[]
}

type PermissionOption = { optionId: string; kind: string }

export function launchAcp(input: AcpLaunchInput, onEvent: EventSink): AgentSession {
  const child = spawn(input.command, [...input.args], { cwd: input.cwd, stdio: ['pipe', 'pipe', 'pipe'], ...AGENT_SPAWN, env: { ...inheritedEnv(), ...input.env } })
  let exited = false
  let sessionId: string | undefined
  let loading = false
  let firstPrompt = !input.resume
  let message = ''
  let messageCount = 0
  const queued: Array<{ readonly text: string; readonly images?: readonly OutgoingImage[] }> = []
  // Set from initialize: whether the agent takes image blocks in a prompt.
  let takesImages = false
  const approvals = new Map<string, { rpcId: number | string; options: PermissionOption[] }>()

  const flushMessage = (): void => {
    if (!message.trim()) { message = ''; return }
    onEvent({ kind: 'assistant_text', messageId: `acp-${Date.now()}-${++messageCount}`, text: message })
    message = ''
  }
  const fail = (error: unknown): void => onEvent({ kind: 'error', message: error instanceof Error ? error.message : String(error) })

  const rpc = createRpcClient(child, {
    onNotification(method, params) {
      // session/load replays the history Cockpit already has; it is not shown twice.
      if (method !== 'session/update' || loading) return
      const update = parseAcpUpdate(params)
      if (update.type === 'text') {
        message += update.text
        onEvent({ kind: 'text_delta', text: update.text })
      } else if (update.type === 'events') {
        flushMessage()
        for (const event of update.events) onEvent(event)
      }
    },
    onServerRequest(request) {
      if (request.method !== 'session/request_permission') {
        // Cockpit offers no file system or terminal to the agent; anything else is declined.
        rpc.respond(request.id, null)
        return
      }
      flushMessage()
      const params = (request.params ?? {}) as { toolCall?: Record<string, unknown>; options?: PermissionOption[] }
      const options = Array.isArray(params.options) ? params.options : []
      const requestId = String(request.id)
      approvals.set(requestId, { rpcId: request.id, options })
      const tool = acpTool(params.toolCall ?? {})
      onEvent({ kind: 'approval_request', requestId, toolName: tool.name, input: tool.input,
        ...(typeof params.toolCall?.title === 'string' ? { description: params.toolCall.title } : {}),
        suggestions: options.some((o) => o.kind === 'allow_always') ? ['allow_always'] : [] })
    },
    onProtocolError: fail,
  }, { label: input.label, jsonrpc: true })

  const prompt = (text: string, images?: readonly OutgoingImage[]): void => {
    if (!sessionId) { queued.push({ text, ...(images ? { images } : {}) }); return }
    const body = firstPrompt && input.instructions ? `<cockpit-instructions>\n${input.instructions}\n</cockpit-instructions>\n\n${text}` : text
    firstPrompt = false
    rpc.request<{ stopReason?: string }>('session/prompt', { sessionId, prompt: acpPrompt(body, images, takesImages) })
      .then((result) => { flushMessage(); onEvent(acpTurnEnd(result?.stopReason)) })
      .catch((error: unknown) => { if (exited) return; flushMessage(); fail(error); onEvent({ kind: 'result', ok: false }) })
  }

  const mcpServers = (input.mcpServers ?? []).map((s) => ({ name: s.name, command: s.command, args: [...s.args], env: Object.entries(s.env).map(([name, value]) => ({ name, value })) }))
  void (async () => {
    try {
      const init = await rpc.request<{ agentCapabilities?: { loadSession?: boolean; promptCapabilities?: { image?: boolean } } }>('initialize', {
        protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      })
      takesImages = init?.agentCapabilities?.promptCapabilities?.image === true
      if (input.resume && init?.agentCapabilities?.loadSession) {
        loading = true
        await rpc.request('session/load', { sessionId: input.resume, cwd: input.cwd, mcpServers })
        loading = false
        sessionId = input.resume
      } else {
        // An agent that cannot load sessions starts a fresh one; the conversation's history stays in Cockpit.
        const created = await rpc.request<{ sessionId: string }>('session/new', { cwd: input.cwd, mcpServers })
        sessionId = created.sessionId
        firstPrompt = true
      }
      onEvent({ kind: 'session', sessionId })
      for (const turn of queued.splice(0)) prompt(turn.text, turn.images)
    } catch (error) {
      if (exited) return
      loading = false
      onEvent({ kind: 'error', message: `${input.label} failed to start: ${error instanceof Error ? error.message : String(error)}` })
      onEvent({ kind: 'result', ok: false })
      child.stdin.end()
    }
  })()

  child.on('error', (error) => {
    onEvent({ kind: 'error', message: startErrorMessage(input.agent, error) })
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
    onEvent({ kind: 'exit', code })
  })

  return {
    agent: input.agent,
    send: (text, _queuedId, images) => prompt(text, images),
    respondApproval(approval: PendingApproval, behavior: ApprovalBehavior) {
      const pending = approvals.get(approval.requestId)
      if (!pending) return
      approvals.delete(approval.requestId)
      const pick = (...kinds: string[]): string | undefined => kinds.map((k) => pending.options.find((o) => o.kind === k)?.optionId).find(Boolean)
      const optionId = behavior === 'deny' ? pick('reject_once', 'reject_always') : behavior === 'allow_session' ? pick('allow_always', 'allow_once') : pick('allow_once', 'allow_always')
      rpc.respond(pending.rpcId, { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } })
      onEvent({ kind: 'approval_resolved', requestId: approval.requestId, behavior })
    },
    interrupt() {
      if (sessionId) rpc.notify('session/cancel', { sessionId })
      else if (queued.length > 0) {
        // Still starting up: the messages never reach the agent, and the turn ends here as stopped.
        queued.splice(0)
        onEvent({ kind: 'result', ok: false, stopped: true })
      }
      // Unanswered permission requests are cancelled with the turn.
      for (const [requestId, pending] of approvals) {
        rpc.respond(pending.rpcId, { outcome: { outcome: 'cancelled' } })
        approvals.delete(requestId)
      }
    },
    close: () => stopChild(child, () => !exited),
    alive: () => !exited,
  }
}
