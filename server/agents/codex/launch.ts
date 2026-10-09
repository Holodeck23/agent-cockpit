import { spawn } from 'node:child_process'
import { z } from 'zod'
import { ALL_EFFORTS, PERMISSION_MODES } from '../claude/flags.ts'
import { startErrorMessage } from '../start-error.ts'
import { AGENT_SPAWN, stopChild } from '../stop.ts'
import type { AgentQuestion, AgentSession, ApprovalBehavior, EventSink, OutgoingImage, PendingApproval } from '../types.ts'
import { codexInput } from '../image-input.ts'
import { codexEffort } from './efforts.ts'
import { createCodexStreamState, parseCodexNotification } from './parse.ts'
import { createRpcClient, type ServerRequest } from './rpc.ts'

export const codexLaunchSchema = z.object({
  cwd: z.string().min(1),
  model: z
    .string()
    .max(100)
    .regex(/^[A-Za-z0-9._\-[\]]+$/)
    .optional(),
  effort: z.enum(ALL_EFFORTS).optional(),
  permissionMode: z.enum(PERMISSION_MODES).default('manual'),
  /** Codex thread id to resume; absent means start a new thread. */
  resume: z.string().min(1).max(200).optional(),
  /** Seed context for a brand-new thread (used when switching agents). */
  developerInstructions: z.string().max(500_000).optional(),
})
export type CodexLaunchInput = z.input<typeof codexLaunchSchema>

type Policy = { approvalPolicy: 'on-request' | 'never'; sandbox: 'read-only' | 'workspace-write' | 'danger-full-access' }

/** Cockpit permission modes mapped onto Codex's approval policy + sandbox. */
export function codexPolicy(mode: (typeof PERMISSION_MODES)[number]): Policy {
  switch (mode) {
    case 'plan':
      return { approvalPolicy: 'on-request', sandbox: 'read-only' }
    case 'auto':
    case 'dontAsk':
      return { approvalPolicy: 'never', sandbox: 'workspace-write' }
    case 'bypassPermissions':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' }
    default:
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' }
  }
}

const ELICITATION_METHOD = 'mcpServer/elicitation/request'
/** Codex's (experimental) questions with fixed choices. */
const QUESTION_METHOD = 'item/tool/requestUserInput'

const userInputSchema = z.object({
  questions: z.array(z.looseObject({
    id: z.string(), question: z.string(), header: z.string(),
    options: z.array(z.looseObject({ label: z.string(), description: z.string().optional() })).nullable().optional(),
  })).min(1),
})

/** request_user_input as questions; Codex takes one answer per question id. */
export function codexQuestions(params: unknown): AgentQuestion[] | undefined {
  const parsed = userInputSchema.safeParse(params)
  if (!parsed.success) return undefined
  return parsed.data.questions.map((q) => ({
    id: q.id, question: q.question, header: q.header, multiSelect: false,
    options: (q.options ?? []).map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
  }))
}
const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'execCommandApproval',
  'applyPatchApproval',
  // Codex asks before an MCP tool call (e.g. cockpit start_process) through an MCP elicitation.
  ELICITATION_METHOD,
])

function describeApproval(request: ServerRequest): { toolName: string; input: unknown; description?: string; toolUseId?: string } {
  const params = (request.params ?? {}) as Record<string, unknown>
  if (request.method === ELICITATION_METHOD) {
    const message = typeof params.message === 'string' ? params.message : 'An MCP server is asking to continue'
    return { toolName: `MCP: ${String(params.serverName ?? 'server')}`, input: { message }, description: message }
  }
  const isFile = request.method.includes('fileChange') || request.method === 'applyPatchApproval'
  return {
    toolName: isFile ? 'Edit' : 'Shell',
    ...(typeof params.itemId === 'string' ? { toolUseId: params.itemId } : {}),
    input: isFile ? { file_path: params.grantRoot ?? params.reason ?? 'file change' } : { command: params.command },
    description: typeof params.reason === 'string' ? params.reason : undefined,
  }
}

export interface CodexLaunchDeps {
  readonly executable?: string
  /** Config overrides (`-c key=value`) built by the cockpit, never from the UI. */
  configArgs?: readonly string[]
  /** Added to the app-server's environment. */
  env?: Readonly<Record<string, string>>
}

export function launchCodex(input: CodexLaunchInput, onEvent: EventSink, deps: CodexLaunchDeps = {}): AgentSession {
  const opts = codexLaunchSchema.parse(input)
  const child = spawn(deps.executable ?? 'codex', ['app-server', ...(deps.configArgs ?? [])], {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'], ...AGENT_SPAWN,
    env: { ...process.env, ...deps.env },
  })
  let exited = false
  let threadId: string | undefined
  let currentTurnId: string | undefined
  // Stop pressed after turn/start went out but before Codex named the turn: interrupt it on arrival.
  let interruptOnStart = false
  let turnStarting = false
  let stopGeneration = 0
  const stream = createCodexStreamState()
  // Helper threads' running turns, so Stop stops the helpers too (J7).
  const childTurns = new Map<string, string>()
  const queued: Array<{ readonly text: string; readonly images?: readonly OutgoingImage[] }> = []
  // Approval request id (as a string) -> JSON-RPC id to reply to.
  const approvalIds = new Map<string, number | string>()
  // Which pending approvals are MCP elicitations: they take a different reply shape.
  const elicitations = new Set<string>()

  const rpc = createRpcClient(child, {
    onNotification(method, params) {
      const p = params as { threadId?: unknown; turn?: { id?: string } } | undefined
      const helper = typeof p?.threadId === 'string' && threadId !== undefined && p.threadId !== threadId ? p.threadId : undefined
      if (method === 'turn/started') {
        if (helper) { if (p?.turn?.id) childTurns.set(helper, p.turn.id) } else {
          currentTurnId = p?.turn?.id
          turnStarting = false
          if (interruptOnStart && threadId && currentTurnId) rpc.request('turn/interrupt', { threadId, turnId: currentTurnId }).catch(() => undefined)
          interruptOnStart = false
        }
      }
      if (method === 'turn/completed') {
        if (helper) childTurns.delete(helper)
        else currentTurnId = undefined
      }
      for (const event of parseCodexNotification(method, params, stream)) onEvent(event)
    },
    onServerRequest(request) {
      const questions = request.method === QUESTION_METHOD ? codexQuestions(request.params) : undefined
      if (questions) {
        const requestId = String(request.id)
        approvalIds.set(requestId, request.id)
        onEvent({ kind: 'question', requestId, questions })
        return
      }
      if (!APPROVAL_METHODS.has(request.method)) {
        // Unsupported interactive requests are declined rather than left hanging.
        rpc.respond(request.id, { decision: 'decline' })
        return
      }
      const requestId = String(request.id)
      approvalIds.set(requestId, request.id)
      if (request.method === ELICITATION_METHOD) elicitations.add(requestId)
      onEvent({ kind: 'approval_request', requestId, suggestions: ['acceptForSession'], ...describeApproval(request) })
    },
    onProtocolError(message) {
      onEvent({ kind: 'error', message })
    },
  })

  const startTurn = (text: string, images?: readonly OutgoingImage[]): void => {
    if (!threadId) {
      queued.push({ text, ...(images ? { images } : {}) })
      return
    }
    const input = codexInput(text, images)
    const generation = stopGeneration
    // A level the model does not have (a saved Ultra on a model without it) becomes its highest (R7).
    const effort = codexEffort(opts.model, opts.effort)
    const fail = (error: unknown): void => { if (!exited) onEvent({ kind: 'error', message: error instanceof Error ? error.message : String(error) }) }
    const start = (): Promise<unknown> => {
      // A late steering failure must not restart work canceled by Stop or session close.
      if (exited || generation !== stopGeneration) return Promise.resolve()
      turnStarting = true
      return rpc.request('turn/start', { threadId, input, ...(effort ? { effort } : {}) })
    }
    // Mid-turn, steer the running turn (J1 spike: folded cleanly; a second turn/start left a
    // phantom turn). If that turn ended in the meantime, start a new one instead.
    const running = currentTurnId
    if (running) rpc.request('turn/steer', { threadId, input, expectedTurnId: running }).catch(() => start().catch(fail))
    else start().catch(fail)
  }

  const policy = codexPolicy(opts.permissionMode)
  void (async () => {
    try {
      await rpc.request('initialize', { clientInfo: { name: 'agent-cockpit', title: 'Agent Cockpit', version: '0.1.0' }, capabilities: null })
      rpc.notify('initialized')
      const common = { cwd: opts.cwd, ...policy, ...(opts.model ? { model: opts.model } : {}) }
      const response = opts.resume
        ? await rpc.request<{ thread: { id: string } }>('thread/resume', {
            threadId: opts.resume,
            ...common,
            // Resume takes them too (ThreadResumeParams), so edited project instructions reach a resumed thread.
            ...(opts.developerInstructions ? { developerInstructions: opts.developerInstructions } : {}),
          })
        : await rpc.request<{ thread: { id: string } }>('thread/start', {
            ...common,
            ...(opts.developerInstructions ? { developerInstructions: opts.developerInstructions } : {}),
          })
      threadId = response.thread.id
      stream.mainThreadId = threadId
      onEvent({ kind: 'session', sessionId: threadId })
      for (const turn of queued.splice(0)) startTurn(turn.text, turn.images)
    } catch (error: unknown) {
      if (exited) return
      onEvent({ kind: 'error', message: `Codex failed to start: ${error instanceof Error ? error.message : String(error)}` })
      onEvent({ kind: 'result', ok: false })
      child.stdin.end()
    }
  })()

  child.on('error', (error) => {
    onEvent({ kind: 'error', message: startErrorMessage('codex', error) })
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
    agent: 'codex',
    send(text, _queuedId, images) {
      startTurn(text, images)
    },
    respondApproval(approval: PendingApproval, behavior: ApprovalBehavior) {
      const rpcId = approvalIds.get(approval.requestId)
      if (rpcId === undefined) return
      approvalIds.delete(approval.requestId)
      if (elicitations.delete(approval.requestId)) {
        rpc.respond(rpcId, behavior === 'deny' ? { action: 'decline', content: null, _meta: null } : { action: 'accept', content: {}, _meta: null })
      } else {
        const decision = behavior === 'deny' ? 'decline' : behavior === 'allow_session' ? 'acceptForSession' : 'accept'
        rpc.respond(rpcId, { decision })
      }
      onEvent({ kind: 'approval_resolved', requestId: approval.requestId, behavior })
    },
    respondQuestion(question: PendingApproval, answers: Readonly<Record<string, string>> | undefined) {
      const rpcId = approvalIds.get(question.requestId)
      if (rpcId === undefined) return
      approvalIds.delete(question.requestId)
      rpc.respond(rpcId, { answers: Object.fromEntries(Object.entries(answers ?? {}).map(([id, answer]) => [id, { answers: [answer] }])) })
      onEvent({ kind: 'question_answered', requestId: question.requestId, answers: answers ?? {}, ...(answers ? {} : { dismissed: true }) })
    },
    interrupt() {
      stopGeneration++
      if (threadId && currentTurnId) {
        rpc.request('turn/interrupt', { threadId, turnId: currentTurnId }).catch(() => undefined)
      } else if (queued.length > 0) {
        // Still starting up: the messages never reach Codex, and the turn ends here as stopped.
        queued.splice(0)
        onEvent({ kind: 'result', ok: false, stopped: true })
      } else if (turnStarting) interruptOnStart = true
      for (const [helper, turnId] of childTurns) {
        rpc.request('turn/interrupt', { threadId: helper, turnId }).catch(() => undefined)
      }
    },
    close() {
      stopGeneration++
      return stopChild(child, () => !exited)
    },
    alive: () => !exited,
  }
}
