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
import { inheritedEnv } from '../inherited-env.ts'
import { createCodexStop } from './stop.ts'
import { codexStartupConfigArgs } from './startup-config.ts'
import { codexReviewedThreadConfig } from './startup-review.ts'
import { codexStartupPreflight } from './startup-preflight.ts'
import { bindCodexStartup } from './startup-binding.ts'
import { createCodexInputReview } from './input-review.ts'

export const codexLaunchSchema = z.object({
  cwd: z.string().min(1),
  model: z
    .string()
    .max(100)
    .regex(/^[A-Za-z0-9._\-[\]/:]+$/)
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
  /** The intended Cockpit bridge has authenticated this session's scoped grant. */
  hostReady?: () => Promise<void>
  /** Recheck the selected setup before native thread creation and each input. */
  validateSources?: () => void
  /** Shortened only by startup tests; production retains 15/30/60-second budgets. */
  initializeTimeoutMs?: number
  capabilityTimeoutMs?: number
  startupTimeoutMs?: number
}

export function launchCodex(input: CodexLaunchInput, onEvent: EventSink, deps: CodexLaunchDeps = {}): AgentSession {
  const opts = codexLaunchSchema.parse(input)
  const env = { ...inheritedEnv(), ...deps.env }
  const controller = new AbortController()
  const deadline = performance.now() + (deps.startupTimeoutMs ?? 60_000)
  let session: AgentSession | undefined, ended = false
  const pending: Array<{ text: string; queuedId?: string; images?: readonly OutgoingImage[] }> = []
  const finish = (error?: unknown, stopped = false): void => {
    if (ended) return
    ended = true
    controller.abort()
    pending.splice(0)
    if (error) onEvent({ kind: 'error', message: error instanceof Error ? error.message : 'Codex startup could not be checked. Your message was not delivered.' })
    onEvent({ kind: 'result', ok: false, ...(stopped ? { stopped: true } : {}) })
    onEvent({ kind: 'exit', code: null })
  }
  const checked = Promise.resolve().then(async () => {
    if (ended) return
    await codexStartupPreflight(env, controller.signal)
    if (ended) return
    try { deps.validateSources?.() }
    catch { throw new Error('Codex setup changed before startup; review Project Settings. Your message was not delivered.') }
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new Error('Codex startup review did not finish in time. Your message was not delivered.')
    session = spawnCodex(opts, event => { if (!ended) onEvent(event) }, { ...deps, startupTimeoutMs: remaining }, env)
    for (const message of pending.splice(0)) session.send(message.text, message.queuedId, message.images)
  }).catch(error => finish(error))
  return {
    agent: 'codex',
    reviewsInput: true,
    send(text, queuedId, images) {
      if (ended) return
      if (session) session.send(text, queuedId, images)
      else pending.push({ text, ...(queuedId ? { queuedId } : {}), ...(images ? { images } : {}) })
    },
    preparing: () => !ended && (session?.preparing?.() ?? !session),
    queues: () => !ended && (session?.queues?.() ?? !session),
    cancelQueued(queuedId) {
      if (session) return session.cancelQueued?.(queuedId) ?? Promise.resolve(false)
      const index = pending.findIndex(message => message.queuedId === queuedId)
      if (index < 0) return Promise.resolve(false)
      pending.splice(index, 1)
      return Promise.resolve(true)
    },
    respondApproval: (approval, behavior) => { if (!ended) session?.respondApproval(approval, behavior) },
    respondQuestion: (question, answers) => { if (!ended) session?.respondQuestion?.(question, answers) },
    interrupt() {
      if (ended) return
      if (session) session.interrupt()
      else {
        for (const message of pending) if (message.queuedId) onEvent({ kind: 'user_undelivered', id: message.queuedId })
        finish(undefined, true)
      }
    },
    async close() {
      ended = true; controller.abort(); pending.splice(0)
      // Fence an existing provider synchronously, before yielding to late RPCs.
      const closing = session?.close()
      await checked
      await closing
    },
    alive: () => session?.alive() ?? !ended,
  }
}

/** Called only after the cancellable local source preflight completes. */
function spawnCodex(opts: z.output<typeof codexLaunchSchema>, onEvent: EventSink, deps: CodexLaunchDeps, env: NodeJS.ProcessEnv): AgentSession {
  // Keep these after earlier launch options; ordinary user/project config has lower precedence.
  const child = spawn(deps.executable ?? 'codex', ['app-server', ...(deps.configArgs ?? []), ...codexStartupConfigArgs()], {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'], ...AGENT_SPAWN,
    env,
  })
  let exited = false
  let exitReported = false
  let ready = false
  let startupFailed = false
  let closing = false
  const startup = new AbortController()
  const deadline = performance.now() + (deps.startupTimeoutMs ?? 60_000)
  let retirement: Promise<void> | undefined
  const retire = (): Promise<void> => retirement ??= stopChild(child, () => !exited)
  const waitForStartup = <T>(promise: Promise<T>, budget: number, message: string, withinStartup = true): Promise<T> =>
    new Promise((resolve, reject) => {
      let settled = false
      const abort = (): void => finish(false, new Error('Codex startup was cancelled'))
      const finish = (ok: boolean, value: unknown): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        startup.signal.removeEventListener('abort', abort)
        if (ok) resolve(value as T); else reject(value)
      }
      const timer = setTimeout(() => finish(false, new Error(message)), Math.max(0, Math.min(budget, withinStartup ? deadline - performance.now() : budget)))
      startup.signal.addEventListener('abort', abort, { once: true })
      promise.then((value) => finish(true, value), (error: unknown) => finish(false, error))
      if (startup.signal.aborted) abort()
    })
  let threadId: string | undefined
  let nativeBinding: ReturnType<typeof bindCodexStartup> | undefined
  let recheckNative: ((withinStartup?: boolean) => Promise<void>) | undefined
  let currentTurnId: string | undefined
  // Stop pressed after turn/start went out but before Codex named the turn: interrupt it on arrival.
  let interruptOnStart = false
  let turnStarting = false
  let stopping = false
  let stopGeneration = 0
  const stream = createCodexStreamState()
  // Helper threads' running turns, so Stop stops the helpers too (J7).
  const childTurns = new Map<string, string>()
  const queued: Array<{ readonly text: string; readonly queuedId?: string; readonly images?: readonly OutgoingImage[] }> = []
  // Approval request id (as a string) -> JSON-RPC id to reply to.
  const approvalIds = new Map<string, number | string>()
  // Which pending approvals are MCP elicitations: they take a different reply shape.
  const elicitations = new Set<string>()

  const rpc = createRpcClient(child, {
    onNotification(method, params) {
      stops.observe(method, params)
      const p = params as { threadId?: unknown; turn?: { id?: string } } | undefined
      const helper = typeof p?.threadId === 'string' && threadId !== undefined && p.threadId !== threadId ? p.threadId : undefined
      if (method === 'turn/started') {
        if (helper) { if (p?.turn?.id) childTurns.set(helper, p.turn.id) } else {
          currentTurnId = p?.turn?.id
          turnStarting = false
          if (interruptOnStart && threadId && currentTurnId) stops.interrupt(threadId, currentTurnId)
          interruptOnStart = false
        }
      }
      if (method === 'turn/completed') {
        if (helper) childTurns.delete(helper)
        // Main turn stays reserved until terminal cancellation is confirmed.
      }
      const deliver = (errors: readonly string[] = []): void => {
        if (exited || closing || startupFailed) return
        if (method === 'turn/completed' && !helper) currentTurnId = undefined
        for (const event of parseCodexNotification(method, params, stream)) {
          // Stock announces thread/started before the final source/bridge checks.
          // Publish the session only after startup qualifies below.
          if (event.kind !== 'session' || ready) onEvent(event)
        }
        // Keep a failed cancellation visible after the model's stopped result.
        for (const message of errors) onEvent({ kind: 'error', message })
        if (method === 'turn/completed' && !helper) {
          stopping = false
          for (const turn of queued.splice(0)) startTurn(turn.text, turn.images, turn.queuedId)
        }
      }
      if (method === 'turn/completed' && typeof p?.threadId === 'string' && p.turn?.id) stops.finish(p.threadId, p.turn.id, deliver)
      else deliver()
    },
    onServerRequest(request) {
      if (closing || startupFailed) { rpc.respond(request.id, { decision: 'decline' }); return }
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

  const stops = createCodexStop(rpc, (message) => { if (!exited) onEvent({ kind: 'error', message }) })

  const failStartup = (message: string): void => {
    if (exited || closing || startupFailed) return
    startupFailed = true
    queued.splice(0)
    inputReview.clear()
    startup.abort()
    onEvent({ kind: 'error', message })
    // No provider turn exists for an idle input still held by review. Exit lets
    // the manager settle its receipt without rewriting a prior completed run.
    if (!ready || currentTurnId || turnStarting) onEvent({ kind: 'result', ok: false })
    // End the logical session and revoke its host grant immediately; process cleanup follows.
    exitReported = true
    onEvent({ kind: 'exit', code: null })
    void retire().catch(() => onEvent({ kind: 'error', message: 'Codex could not be closed after the refused start' }))
  }
  const startTurn = (text: string, images?: readonly OutgoingImage[], queuedId?: string, startupInput = false): void => {
    if (exited || closing || startupFailed) return
    if (!threadId || !ready || stopping) {
      queued.push({ text, ...(queuedId ? { queuedId } : {}), ...(images ? { images } : {}) })
      return
    }
    inputReview.enqueue({ text, ...(queuedId ? { queuedId } : {}), ...(images ? { images } : {}), ...(startupInput ? { startupInput } : {}) })
  }
  const dispatchReviewed = (text: string, images?: readonly OutgoingImage[], queuedId?: string): void => {
    if (exited || closing || startupFailed) return
    if (stopping) { queued.push({ text, ...(queuedId ? { queuedId } : {}), ...(images ? { images } : {}) }); return }
    const input = codexInput(text, images)
    const generation = stopGeneration
    // A level the model does not have (a saved Ultra on a model without it) becomes its highest (R7).
    const effort = codexEffort(opts.model, opts.effort)
    // A rejected turn/start never names a turn, so end it here: left as is the conversation stays
    // working, and a Stop pressed meanwhile would interrupt the next turn the moment it starts.
    const fail = (error: unknown): void => {
      turnStarting = false
      interruptOnStart = false
      stopping = false
      if (exited || closing || startupFailed) return
      onEvent({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      if (!currentTurnId) {
        onEvent({ kind: 'result', ok: false })
        for (const turn of queued.splice(0)) startTurn(turn.text, turn.images, turn.queuedId)
      }
    }
    const start = (): Promise<unknown> => {
      // A late steering failure must not restart work canceled by Stop or session close.
      if (exited || closing || startupFailed || generation !== stopGeneration) return Promise.resolve()
      try { deps.validateSources?.(); nativeBinding?.checkFiles() }
      catch { failStartup('Codex setup changed before input; review Project Settings. Your message was not delivered.'); return Promise.resolve() }
      turnStarting = true
      if (queuedId) onEvent({ kind: 'user_taken', text, id: queuedId })
      return rpc.request('turn/start', { threadId, input, ...(effort ? { effort } : {}) })
    }
    // Mid-turn, steer the running turn (J1 spike: folded cleanly; a second turn/start left a
    // phantom turn). If that turn ended in the meantime, start a new one instead.
    const running = currentTurnId
    if (running) {
      try { deps.validateSources?.(); nativeBinding?.checkFiles() }
      catch { failStartup('Codex setup changed before input; review Project Settings. Your message was not delivered.'); return }
      if (queuedId) onEvent({ kind: 'user_taken', text, id: queuedId })
      rpc.request('turn/steer', { threadId, input, expectedTurnId: running }).catch(async () => {
        if (exited || closing || startupFailed || generation !== stopGeneration) return
        try { await recheckNative!(false) }
        catch (error) {
          if (!exited && !closing && !startupFailed && generation === stopGeneration) {
            failStartup(error instanceof Error ? error.message : 'Codex setup could not be rechecked. Your message was not delivered.')
          }
          return
        }
        await start().catch(fail)
      })
    }
    else start().catch(fail)
  }

  const inputReview = createCodexInputReview({
    live: () => !exited && !closing && !startupFailed,
    check: async input => {
      try { deps.validateSources?.() }
      catch { throw new Error('Codex setup changed before input; review Project Settings. Your message was not delivered.') }
      await recheckNative!(input.startupInput === true)
    },
    dispatch: input => dispatchReviewed(input.text, input.images, input.queuedId),
    failed: error => failStartup(error instanceof Error ? error.message : 'Codex setup could not be rechecked. Your message was not delivered.'),
  })

  const policy = codexPolicy(opts.permissionMode)
  void (async () => {
    try {
      await waitForStartup(rpc.request('initialize', { clientInfo: { name: 'agent-cockpit', title: 'Agent Cockpit', version: '0.1.0' }, capabilities: { experimentalApi: true } }),
        deps.initializeTimeoutMs ?? 15_000, 'Codex did not initialize in time. Your message was not delivered.')
      if (exited || closing || startupFailed) return
      try { deps.validateSources?.() }
      catch { throw new Error('Codex setup changed before startup; review Project Settings. Your message was not delivered.') }
      rpc.notify('initialized')
      const effective = await waitForStartup(rpc.request('config/read', { cwd: opts.cwd, includeLayers: true }),
        deps.capabilityTimeoutMs ?? 30_000, 'Codex setup review did not finish in time. Your message was not delivered.')
      if (exited || closing || startupFailed) return
      const hostBridge = deps.configArgs?.some(arg => arg.startsWith('mcp_servers.cockpit.command=')) === true
      const config = codexReviewedThreadConfig(effective, hostBridge)
      nativeBinding = bindCodexStartup(effective, hostBridge)
      recheckNative = async (withinStartup = true): Promise<void> => {
        let current: unknown
        try {
          current = await waitForStartup(rpc.request('config/read', { cwd: opts.cwd, includeLayers: true }),
            deps.capabilityTimeoutMs ?? 30_000, 'Codex setup recheck did not finish in time. Your message was not delivered.', withinStartup)
        } catch {
          // Native parser errors may include private config contents or paths.
          throw new Error('Codex setup could not be rechecked; review Project Settings. Your message was not delivered.')
        }
        if (exited || closing || startupFailed) throw new Error('Codex startup was cancelled')
        nativeBinding!.recheck(current)
      }
      await recheckNative()
      try { deps.validateSources?.() }
      catch { throw new Error('Codex setup changed before startup; review Project Settings. Your message was not delivered.') }
      nativeBinding.checkFiles()
      const common = { cwd: opts.cwd, ...policy, config, ...(opts.model ? { model: opts.model } : {}) }
      const response = await waitForStartup(opts.resume
        ? rpc.request<{ thread: { id: string } }>('thread/resume', {
            threadId: opts.resume,
            ...common,
            // Resume takes them too (ThreadResumeParams), so edited project instructions reach a resumed thread.
            ...(opts.developerInstructions ? { developerInstructions: opts.developerInstructions } : {}),
          })
        : rpc.request<{ thread: { id: string } }>('thread/start', {
            ...common,
            ...(opts.developerInstructions ? { developerInstructions: opts.developerInstructions } : {}),
          }), deps.capabilityTimeoutMs ?? 30_000, 'Codex did not prepare the conversation in time. Your message was not delivered.')
      threadId = response.thread.id
      stream.mainThreadId = threadId
      if (deps.hostReady) {
        try { await waitForStartup(Promise.resolve().then(deps.hostReady), deps.capabilityTimeoutMs ?? 30_000,
          'Cockpit’s bridge did not authenticate in time. Your message was not delivered.') }
        catch { if (!closing && !exited) failStartup('Codex could not authenticate Cockpit’s bridge. Your message was not delivered.'); return }
      }
      if (exited || closing || startupFailed) return
      await recheckNative()
      try { deps.validateSources?.() }
      catch { throw new Error('Codex setup changed before input; review Project Settings. Your message was not delivered.') }
      nativeBinding.checkFiles()
      ready = true
      onEvent({ kind: 'session', sessionId: threadId })
      for (const turn of queued.splice(0)) startTurn(turn.text, turn.images, turn.queuedId, true)
    } catch (error: unknown) {
      failStartup(`Codex failed to start: ${error instanceof Error ? error.message : 'Startup failed'}`)
    }
  })()

  child.on('error', (error) => {
    onEvent({ kind: 'error', message: startErrorMessage('codex', error, opts.cwd) })
    // A failed spawn has no exit event. Complete the turn and release the session now.
    if (!child.pid && !exited) {
      exited = true
      onEvent({ kind: 'result', ok: false })
      exitReported = true
      onEvent({ kind: 'exit', code: null })
    }
  })
  child.on('exit', (code) => {
    if (exited) return
    exited = true
    startup.abort()
    if (!exitReported) { exitReported = true; onEvent({ kind: 'exit', code }) }
  })

  return {
    agent: 'codex',
    reviewsInput: true,
    send(text, queuedId, images) {
      startTurn(text, images, queuedId)
    },
    preparing: () => !ready && !startupFailed && !closing && !exited,
    queues: () => !ready && !startupFailed && !closing && !exited,
    cancelQueued(queuedId) {
      if (inputReview.cancel(queuedId)) return Promise.resolve(true)
      const index = queued.findIndex((item) => item.queuedId === queuedId)
      if (index < 0) return Promise.resolve(false)
      queued.splice(index, 1)
      return Promise.resolve(true)
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
      const reviewing = inputReview.has()
      for (const id of inputReview.clear()) onEvent({ kind: 'user_undelivered', id })
      if (threadId && currentTurnId) {
        stopping = true
        queued.splice(0)
        stops.interrupt(threadId, currentTurnId)
      } else if (turnStarting) {
        queued.splice(0)
        stopping = true
        interruptOnStart = true
      } else if (queued.length > 0 || reviewing) {
        // Still starting up: the messages never reach Codex, and the turn ends here as stopped.
        for (const item of queued.splice(0)) if (item.queuedId) onEvent({ kind: 'user_undelivered', id: item.queuedId })
        onEvent({ kind: 'result', ok: false, stopped: true })
      }
      for (const [helper, turnId] of childTurns) {
        stops.interrupt(helper, turnId)
      }
    },
    close() {
      closing = true
      inputReview.clear()
      stopGeneration++
      startup.abort()
      return retire()
    },
    alive: () => !exited && !startupFailed,
  }
}
