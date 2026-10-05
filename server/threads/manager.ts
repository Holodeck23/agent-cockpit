import { createHostActions } from './host-actions.ts'
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { launchAntigravity } from '../agents/antigravity/launch.ts'
import { launchOpencode } from '../agents/opencode/launch.ts'
import { launchClaude } from '../agents/claude/launch.ts'
import { launchCodex } from '../agents/codex/launch.ts'
import { claudeMcpOptions, codexMcpConfigArgs } from '../mcp/wiring.ts'
import { effortForClaude } from '../agents/claude/flags.ts'
import { COCKPIT_GUIDANCE, MCP_SERVER_NAME, type CockpitMcpLaunch, type McpGrant } from '../mcp/sessions.ts'
import { buildHandoff } from './handoff.ts'
import type { AgentId, AgentSession, ApprovalBehavior, EventSink, NormalizedEvent, OutgoingImage, PendingApproval, WorkflowSnapshot } from '../agents/types.ts'
import { deriveStatus, latestTurn, messageCountOf, openQuestion, previewOf } from './status.ts'
import { awaitingOf } from './turns.ts'
import type { ThreadStore } from './store.ts'
import { createImageStore, MAX_ATTACHED_IMAGE_BYTES, type ImageStore } from './images.ts'
import { bindingIdOf, inputHash, unfinishedRun } from './identity.ts'
import type { ThreadMeta, ThreadSettings, ThreadStatus, ThreadSummary } from './types.ts'

export interface LaunchRequest {
  readonly cwd: string
  readonly settings: ThreadSettings
  readonly sessionId?: string
  readonly resume?: string
  /** Context for a fresh session after an agent switch. */
  readonly seed?: string
  /** The cockpit MCP server to attach to this session, if the host provides one. */
  readonly cockpit?: CockpitMcpLaunch
  /** The project's own instructions, as set in Cockpit. */
  readonly projectInstructions?: string
  /** Where this conversation's images are kept, for agents that read them as files. */
  readonly imagesDir?: string
}
export type Launcher = (request: LaunchRequest, onEvent: EventSink) => AgentSession

/** An image you attach to a message: its bytes as sent, and the name it had, if any. */
export interface IncomingImage {
  readonly bytes: Buffer
  readonly name?: string
}

export interface ThreadUpdate {
  readonly threadId: string
  readonly event: NormalizedEvent
  readonly status: ThreadStatus
}
export type UpdateListener = (update: ThreadUpdate) => void

const IDLE_CLOSE_MS = 5 * 60_000

/** Wraps a project's instructions so the agent knows where they came from and what they cannot do. */
export function projectInstructionsBlock(text: string): string {
  return `Project instructions, set by the user in Cockpit for this folder. Follow them alongside the repository's own instructions; they do not change your permissions.\n<project-instructions>\n${text}\n</project-instructions>`
}

/** Cockpit guidance first (only when its tools are attached), then project instructions, then any handoff seed. */
/** Events that inform without being activity: they never reorder the list or mark it unread. */
const QUIET = new Set<NormalizedEvent['kind']>(['awaiting_dismissed', 'branch_changed', 'settings_changed', 'suggestion'])

export const instructionsFor = (req: LaunchRequest): string | undefined =>
  [
    req.cockpit ? COCKPIT_GUIDANCE : undefined,
    req.projectInstructions ? projectInstructionsBlock(req.projectInstructions) : undefined,
    req.seed,
  ].filter(Boolean).join('\n\n') || undefined

export const defaultLaunchers: Record<AgentId, Launcher> = {
  claude: (req, onEvent) => {
    const mcp = req.cockpit ? claudeMcpOptions(req.cockpit) : undefined
    return launchClaude(
      {
        cwd: req.cwd,
        model: req.settings.model,
        effort: effortForClaude(req.settings.effort),
        permissionMode: req.settings.permissionMode,
        useHooks: req.settings.useHooks,
        sessionId: req.sessionId,
        resume: req.resume,
        appendSystemPrompt: instructionsFor(req),
        ...(mcp ? { mcpConfig: mcp.mcpConfig, allowedTools: mcp.allowedTools } : {}),
      },
      onEvent,
      mcp ? { env: mcp.env } : {},
    )
  },
  codex: (req, onEvent) =>
    launchCodex(
      {
        cwd: req.cwd,
        model: req.settings.model,
        effort: req.settings.effort,
        permissionMode: req.settings.permissionMode,
        resume: req.resume,
        developerInstructions: instructionsFor(req),
      },
      onEvent,
      req.cockpit ? { configArgs: codexMcpConfigArgs(req.cockpit), env: req.cockpit.secretEnv } : {},
    ),
  antigravity: (req, onEvent) =>
    launchAntigravity({
      cwd: req.cwd,
      model: req.settings.model,
      effort: effortForClaude(req.settings.effort),
      permissionMode: req.settings.permissionMode,
      resume: req.resume,
      instructions: instructionsFor(req),
      ...(req.imagesDir ? { imagesDir: req.imagesDir } : {}),
    }, onEvent),
  opencode: (req, onEvent) =>
    launchOpencode(
      {
        cwd: req.cwd,
        model: req.settings.model,
        permissionMode: req.settings.permissionMode,
        resume: req.resume,
        instructions: instructionsFor(req),
        // The token travels in the MCP server's environment (sent over stdio), never in arguments.
        ...(req.cockpit ? { mcp: { server: { name: MCP_SERVER_NAME, command: req.cockpit.command, args: req.cockpit.args,
          env: { ...req.cockpit.env, ...req.cockpit.secretEnv } }, env: req.cockpit.secretEnv } } : {}),
      },
      onEvent,
    ),
}

/** Issues a session's cockpit MCP launch; `release` revokes its token when the session ends. */
export type McpProvider = (grant: McpGrant) => { readonly launch: CockpitMcpLaunch; release(): void }

/** Current instructions for a project folder, read when an agent session starts. */
export type InstructionsProvider = (projectPath: string) => { readonly text: string; readonly revision: number } | undefined

export interface ManagerOptions {
  readonly launchers?: Partial<Record<AgentId, Launcher>>
  readonly mcp?: McpProvider
  readonly instructions?: InstructionsProvider
  /** Where conversation images are kept; defaults to the store's own state folder. */
  readonly images?: ImageStore
  /** The opaque primary workspace for a project folder (G-IDENTITY); undefined when it cannot be resolved. */
  readonly workspaceFor?: (projectPath: string) => string | undefined
}

interface Live {
  readonly pending: Map<string, PendingApproval>
  readonly questions: Map<string, { readonly request: PendingApproval; readonly ids: ReadonlySet<string> }>
  readonly session: AgentSession
  turnRunning: boolean
  /** Helpers (sub-agents) still running; they keep the session open and the conversation working (J7). */
  readonly helpers: Set<string>
  /** Messages you sent mid-turn that wait in the agent's queue, until it takes them (J1). */
  readonly waiting: Set<string>
  /** A helper finished between turns: the agent reports back on its own, so its next output starts a turn. */
  followUp: boolean
  /** The turn's result came while messages still waited: it is "working" only for them. */
  afterResult: boolean
  stopRequested: boolean
  /** Text streamed so far for the message in progress, so a late viewer sees all of it. */
  partial: string
  idleTimer?: NodeJS.Timeout
  /** This process's launch number for the conversation. */
  readonly generation: number
  /** The run the agent is working on now; its result is stamped with it. */
  runId?: string
  /** Runs of messages still waiting in the queue, by queued id: a taken one becomes the current run. */
  readonly queuedRuns: Map<string, string>
  /** Revokes the session's control grant; also on close, in case no exit event comes (ID-06). */
  readonly releaseGrant: () => void
}

/** The conversation's agent is still working, so this cannot happen yet (HTTP 409). */
export class ThreadBusyError extends Error {}

/** An operation ID already used for a different request (HTTP 409); the first request stands (ID-05). */
export class OperationConflictError extends Error {}

/** A late event worth a label: what a replaced process tried to say, never deltas, usage or its own exit. */
const STALE_LABELLED = new Set<NormalizedEvent['kind']>(['session', 'result', 'assistant_text', 'tool_use', 'approval_request', 'question', 'error', 'subagent'])

export interface ThreadManager {
  /**
   * `text` is what the user wrote (stored, titled, shown); `agentText` is what the
   * agent receives when references were expanded. They differ only for attachments
   * and workflow references. `workflows` records the referenced instructions as they were used.
   */
  requestHostAction(threadId: string, toolName: string, input: unknown, signal?: AbortSignal): Promise<void>
  canControl(threadId: string): boolean
  create(input: { createdByThreadId?: string; delegationDepth?: number; projectPath: string; title?: string; settings: ThreadSettings; text: string; agentText?: string; workflows?: readonly WorkflowSnapshot[]; workflowId?: string; workflowTrigger?: 'manual' | 'scheduled'; images?: readonly IncomingImage[] }): ThreadMeta
  /** `images` are checked and stored before anything is recorded or sent; a bad one throws ImageAttachError. */
  /** `operationId` makes a repeat of the same request a no-op that answers with the first run. */
  send(threadId: string, text: string, agentText?: string, workflows?: readonly WorkflowSnapshot[], fromConversation?: { id: string; title: string }, images?: readonly IncomingImage[], operationId?: string): { runId: string; replayed: boolean }
  /** At startup: closes runs a crash left open as interrupted, and returns their conversations. Relaunches nothing (ID-07). */
  recoverInterrupted(): string[]
  approve(threadId: string, requestId: string, behavior: ApprovalBehavior): void
  /** Takes back a message still waiting in the agent's queue (J1); resolves to its text and images for your draft. */
  unqueue(threadId: string, queuedId: string): Promise<{ text: string; images: { file: string; name?: string }[] }>
  /** Answers the agent's open questions (J6), or with undefined closes them unanswered. */
  answerQuestion(threadId: string, requestId: string, answers: Readonly<Record<string, string>> | undefined): void
  interrupt(threadId: string): void
  setCompleted(threadId: string, completed: boolean): ThreadMeta
  /** Clears the question or blocker the last turn ended with, without replying. */
  dismissAwaiting(threadId: string): void
  /** Tells the project's other conversations that its branch changed (from `byThreadId`, if given). */
  noteBranchChange(projectPath: string, from: string, to: string, byThreadId?: string): void
  /** Stops its agent session, deletes everything stored for it and tells every window. */
  remove(threadId: string): Promise<void>
  /** Same agent, new model/effort/permissions: the native session resumes with them from the next message. */
  changeSettings(threadId: string, settings: ThreadSettings): ThreadMeta
  /** Hand the thread to another agent/model; the transcript goes with it. */
  switchAgent(threadId: string, settings: ThreadSettings): ThreadMeta
  /** Resume with manual permissions and CLI defaults; retain the native session when the agent is unchanged. */
  resumeRecovered(threadId: string, agent: AgentId, text: string, agentText: string): ThreadMeta
  summaries(): ThreadSummary[]
  /** The run the conversation's agent is working on now, if any. */
  currentRunId(threadId: string): string | undefined
  status(threadId: string): ThreadStatus
  /** The agent message currently being streamed, or '' between messages. */
  partialText(threadId: string): string
  subscribe(listener: UpdateListener): () => void
  /** Stops every live agent session; resolves once all have exited. */
  shutdown(): Promise<void>
}

export function createThreadManager(store: ThreadStore, options: ManagerOptions = {}): ThreadManager {
  // Tests replace some launchers; any they leave out keep the real one.
  const launchers: Record<AgentId, Launcher> = { ...defaultLaunchers, ...options.launchers }
  const live = new Map<string, Live>()
  const listeners = new Set<UpdateListener>()
  const generations = new Map<string, symbol>()
  const closing = new Set<Promise<void>>()
  // Deleted conversations: a closing session's last events must not recreate their files.
  const deleted = new Set<string>()
  const hostActions = createHostActions((id, event) => record(id, event))
  const images = options.images ?? createImageStore(store.root)

  /** An image the agent showed, saved; undefined (and logged) when it is not one Cockpit keeps. */
  const keepImage = (threadId: string, event: Extract<NormalizedEvent, { kind: 'image_data' }>): NormalizedEvent | undefined => {
    try {
      const { source } = event
      if ('path' in source && statSync(source.path).size > MAX_ATTACHED_IMAGE_BYTES) throw new Error('over 5 MB')
      const saved = images.save(threadId, 'data' in source ? Buffer.from(source.data, 'base64') : readFileSync(source.path))
      const name = event.name ?? ('path' in source ? basename(source.path) : undefined)
      return { kind: 'image', file: saved.file, mediaType: saved.mediaType, from: 'agent', ...(name ? { name } : {}) }
    } catch (error) {
      console.warn('[cockpit] an image from the agent was not kept:', error instanceof Error ? error.message : error)
      return undefined
    }
  }

  const closeEntry = (entry: Live): Promise<void> => {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.stopRequested = true
    const closingSession = entry.session.close().finally(entry.releaseGrant)
    closing.add(closingSession)
    void closingSession.then(() => closing.delete(closingSession), () => closing.delete(closingSession))
    return closingSession
  }

  const busy = (entry: Live | undefined): boolean => Boolean(entry && (entry.turnRunning || entry.helpers.size > 0))
  const statusOf = (threadId: string): ThreadStatus => deriveStatus(store.events(threadId), busy(live.get(threadId)))
  const armIdleClose = (entry: Live): void => {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => void entry.session.close(), IDLE_CLOSE_MS)
  }

  const broadcast = (threadId: string, event: NormalizedEvent): void => {
    const update: ThreadUpdate = { threadId, event, status: statusOf(threadId) }
    for (const listener of listeners) listener(update)
  }

  const record = (threadId: string, incoming: NormalizedEvent): void => {
    if (deleted.has(threadId)) return
    if (incoming.kind === 'image_data') {
      const image = keepImage(threadId, incoming)
      if (image) record(threadId, image)
      return
    }
    // Taken signals matter only for messages that waited; the rest would just fill the log.
    if (incoming.kind === 'user_taken') {
      const waiting = live.get(threadId)?.waiting
      if (!incoming.id || !waiting?.delete(incoming.id)) return
      const entry = live.get(threadId)!
      entry.afterResult = false
      const taken = entry.queuedRuns.get(incoming.id)
      if (taken) { entry.runId = taken; entry.queuedRuns.delete(incoming.id) }
      // A message queued past the end of a turn (or a Stop) starts the next one when taken.
      if (!entry.turnRunning) {
        entry.turnRunning = true
        if (entry.idleTimer) clearTimeout(entry.idleTimer)
      }
    }
    if (incoming.kind === 'result' || incoming.kind === 'exit' || incoming.kind === 'agent_switch') hostActions.cancel(threadId)
    const entry = live.get(threadId)
    // A dead process cannot finish its turn later. Do not apply this to protocol errors.
    if (incoming.kind === 'exit' && entry?.turnRunning) record(threadId, { kind: 'result', ok: false })
    // A failed result right after the user pressed Stop is a stop, not an error.
    const stopped: NormalizedEvent =
      incoming.kind === 'result' && !incoming.ok && entry?.stopRequested ? { ...incoming, stopped: true } : incoming
    const event: NormalizedEvent = stopped.kind === 'result' && !stopped.runId && entry?.runId ? { ...stopped, runId: entry.runId } : stopped
    // Deltas are for live rendering only; the final assistant_text is persisted.
    if (event.kind !== 'text_delta') store.append(threadId, event)
    if (entry && event.kind === 'text_delta') entry.partial += event.text
    if (entry && (event.kind === 'assistant_text' || event.kind === 'result')) entry.partial = ''
    if (entry && event.kind === 'subagent') {
      if (event.phase === 'started') entry.helpers.add(event.id)
      if (event.phase === 'finished' && entry.helpers.delete(event.id) && !entry.turnRunning) {
        // A helper you stopped does not get reported on.
        entry.followUp = !entry.stopRequested
        if (entry.helpers.size === 0) { entry.stopRequested = false; armIdleClose(entry) }
      }
    }
    if (entry?.followUp && !entry.turnRunning && (event.kind === 'text_delta' || event.kind === 'assistant_text' || event.kind === 'tool_use')) {
      entry.followUp = false
      entry.turnRunning = true
      if (entry.idleTimer) clearTimeout(entry.idleTimer)
    }
    // Only provider evidence makes a session resumable; constructing a process does not.
    if (event.kind === 'session') {
      const meta = store.get(threadId)
      if (meta) store.update(threadId, { sessionId: event.sessionId, sessionStarted: true, handoff: undefined })
    }
    if (entry && event.kind === 'result') {
      entry.pending.clear()
      entry.questions.clear()
      // Messages still waiting run next, without you sending again.
      entry.turnRunning = entry.waiting.size > 0
      entry.afterResult = entry.turnRunning
      entry.stopRequested = false
      // Closing the process would kill helpers still at work, or drop waiting messages.
      if (entry.helpers.size === 0 && !entry.turnRunning) armIdleClose(entry)
    }
    if (event.kind === 'exit') {
      if (entry?.idleTimer) clearTimeout(entry.idleTimer)
      live.delete(threadId)
      generations.delete(threadId)
    }
    broadcast(threadId, event)
  }

  const ensureSession = (meta: ThreadMeta): Live => {
    const existing = live.get(meta.id)
    if (existing?.session.alive()) return existing
    const generation = Symbol()
    generations.set(meta.id, generation)
    const pending = new Map<string, PendingApproval>()
    const questions: Live['questions'] = new Map()
    const requestIds = new Map<string, string>()
    // Persisted before the boundary, so every event after it belongs to this launch, even across a restart.
    const launchNumber = (meta.sessionGeneration ?? 0) + 1
    const workspaceId = meta.workspaceId ?? options.workspaceFor?.(meta.projectPath)
    store.update(meta.id, { sessionGeneration: launchNumber, bindingId: bindingIdOf(meta), ...(workspaceId ? { workspaceId } : {}) })
    record(meta.id, { kind: 'session_boundary', generation: launchNumber, bindingId: bindingIdOf(meta) })
    const mcp = options.mcp?.({ threadId: meta.id, projectPath: meta.projectPath })
    // Read at launch: edits reach the next session, never one already running.
    const instructions = options.instructions?.(meta.projectPath)
    let launching = true
    const deliver: EventSink = (event) => {
      // Even a synchronous launcher callback must follow the initial user_text and live entry.
      if (launching) { queueMicrotask(() => deliver(event)); return }
      handleEvent(event)
    }
    let released = false
    const releaseGrant = (): void => { if (!released) { released = true; mcp?.release() } }
    const handleEvent: EventSink = (event) => {
      if (event.kind === 'exit') releaseGrant()
      // An old process may still talk after its replacement started: it is labelled, never acted on (ID-04).
      if (generations.get(meta.id) !== generation) {
        if (STALE_LABELLED.has(event.kind)) record(meta.id, { kind: 'stale_event', generation: launchNumber, eventKind: event.kind })
        return
      }
      if (event.kind === 'approval_request') {
        const publicId = randomUUID()
        requestIds.set(event.requestId, publicId)
        pending.set(publicId, { requestId: event.requestId, input: event.input, suggestions: event.suggestions })
        record(meta.id, { ...event, requestId: publicId })
      } else if (event.kind === 'question') {
        const publicId = randomUUID()
        requestIds.set(event.requestId, publicId)
        // Claude echoes its tool input back with the answers; this is that input, field for field.
        const input = { questions: event.questions.map(({ question, header, options, multiSelect }) => ({ question, header, options, multiSelect })) }
        questions.set(publicId, { request: { requestId: event.requestId, input, suggestions: [] }, ids: new Set(event.questions.map((q) => q.id)) })
        record(meta.id, { ...event, requestId: publicId })
      } else if (event.kind === 'question_answered') {
        const publicId = requestIds.get(event.requestId)
        if (!publicId) return
        questions.delete(publicId)
        requestIds.delete(event.requestId)
        record(meta.id, { ...event, requestId: publicId })
      } else if (event.kind === 'approval_resolved') {
        const publicId = requestIds.get(event.requestId)
        if (!publicId) return
        pending.delete(publicId)
        requestIds.delete(event.requestId)
        record(meta.id, { ...event, requestId: publicId })
      } else {
        if (event.kind === 'result' || event.kind === 'exit') {
          pending.clear()
          questions.clear()
          requestIds.clear()
        }
        record(meta.id, event)
      }
    }
    const session = launchers[meta.settings.agent](
      {
        ...(instructions ? { projectInstructions: instructions.text } : {}),
        cwd: meta.projectPath,
        settings: meta.settings,
        ...(meta.sessionStarted ? { resume: meta.sessionId } : { sessionId: meta.sessionId }),
        ...(meta.handoff && !meta.sessionStarted ? { seed: meta.handoff } : {}),
        ...(mcp ? { cockpit: mcp.launch } : {}),
        imagesDir: images.dir(meta.id),
      },
      deliver,
    )
    launching = false
    const entry: Live = { pending, questions, helpers: new Set(), waiting: new Set(), followUp: false, afterResult: false, session, turnRunning: false, stopRequested: false, partial: '', generation: launchNumber, queuedRuns: new Map(), releaseGrant }
    live.set(meta.id, entry)
    store.update(meta.id, { instructionsRevision: instructions?.revision, instructionsText: instructions?.text })
    return entry
  }

  const requireMeta = (threadId: string): ThreadMeta => {
    const meta = store.get(threadId)
    if (!meta) throw new Error(`Unknown thread ${threadId}`)
    return meta
  }

  const send = (threadId: string, text: string, agentText = text, workflows?: readonly WorkflowSnapshot[], fromConversation?: { id: string; title: string }, attached: readonly IncomingImage[] = [], operationId?: string): { runId: string; replayed: boolean } => {
    if (deleted.has(threadId)) throw new Error('This conversation was deleted')
    const meta = requireMeta(threadId)
    const operation = operationId ? { id: operationId, inputHash: inputHash(text, attached) } : undefined
    if (operation) {
      // Checked before any effect, against the durable log, so a repeat after a restart is still one request.
      const earlier = store.events(threadId).find((e) => e.event.kind === 'user_text' && e.event.operation?.id === operation.id)?.event
      if (earlier?.kind === 'user_text') {
        if (earlier.operation?.inputHash !== operation.inputHash) throw new OperationConflictError('This request ID was already used for a different message')
        return { runId: earlier.runId!, replayed: true }
      }
    }
    hostActions.cancel(threadId)
    // Every image is checked and stored first, so a bad one sends nothing.
    const stored = attached.map((image) => ({ ...images.save(threadId, image.bytes), image }))
    const outgoing: OutgoingImage[] = stored.map(({ path, mediaType, image }) => ({ path, mediaType, data: image.bytes.toString('base64') }))
    const entry = ensureSession(meta)
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    // Mid-turn, a message waits in the agent's queue where it can still be taken back (J1).
    const queuedId = entry.turnRunning && entry.session.queues?.() ? randomUUID() : undefined
    const runId = randomUUID()
    const bound = requireMeta(threadId)
    const binding = queuedId ? { bindingId: bindingIdOf(bound), ...(bound.workspaceId ? { workspaceId: bound.workspaceId } : {}), agent: bound.settings.agent, generation: entry.generation } : undefined
    if (queuedId) { entry.waiting.add(queuedId); entry.queuedRuns.set(queuedId, runId) }
    else { entry.afterResult = false; entry.runId = runId }
    entry.turnRunning = true
    if (meta.completed) {
      store.update(threadId, { completed: false })
      record(threadId, { kind: 'completion_changed', completed: false })
    } else store.update(threadId, {})
    record(threadId, { kind: 'user_text', text, ...(fromConversation ? { fromConversation } : {}), ...(workflows?.length ? { workflows } : {}), ...(queuedId ? { queuedId } : {}), runId, ...(operation ? { operation } : {}), ...(binding ? { binding } : {}) })
    for (const { file, mediaType, image } of stored) record(threadId, { kind: 'image', file, mediaType, from: 'you', ...(image.name ? { name: image.name } : {}) })
    entry.session.send(agentText, queuedId, outgoing.length ? outgoing : undefined)
    return { runId, replayed: false }
  }

  return {
    canControl: (id) => Boolean(live.get(id)?.turnRunning && !live.get(id)?.stopRequested),
    requestHostAction(threadId, toolName, input, signal) {
      if (!live.get(threadId)?.turnRunning || live.get(threadId)?.stopRequested) return Promise.reject(new Error("The calling conversation is no longer working"))
      return hostActions.request(threadId, toolName, input, signal)
    },
    create({ projectPath, title, settings, text, agentText, workflows, workflowId, workflowTrigger, createdByThreadId, delegationDepth, images: attached }) {
      const now = new Date().toISOString()
      const meta = store.create({
        id: randomUUID(),
        workflowId, workflowTrigger,
        ...(createdByThreadId ? { createdByThreadId, delegationDepth } : {}),
        title: title?.trim() || text.slice(0, 60),
        projectPath,
        settings,
        sessionId: randomUUID(),
        bindingId: randomUUID(),
        ...(options.workspaceFor?.(projectPath) ? { workspaceId: options.workspaceFor(projectPath) } : {}),
        sessionStarted: false,
        completed: false,
        createdAt: now,
        updatedAt: now,
      })
      const source = createdByThreadId ? store.get(createdByThreadId) : undefined
      try {
        send(meta.id, text, agentText, workflows, source ? { id: source.id, title: source.title } : undefined, attached)
      } catch (error) {
        // A refused image leaves no empty conversation behind.
        store.remove(meta.id)
        images.remove(meta.id)
        throw error
      }
      return meta
    },
    send,
    approve(threadId, requestId, behavior) {
      if (hostActions.approve(threadId, requestId, behavior)) return
      const entry = live.get(threadId)
      if (!entry?.session.alive()) throw new Error('This approval belongs to a session that has ended')
      const request = entry.pending.get(requestId)
      if (!request || !entry.turnRunning) throw new Error('Unknown or expired approval request')
      entry.pending.delete(requestId)
      entry.session.respondApproval(request, behavior)
    },
    async unqueue(threadId, queuedId) {
      const entry = live.get(threadId)
      const sent = store.events(threadId).find((e) => e.event.kind === 'user_text' && e.event.queuedId === queuedId)?.event
      if (!entry?.waiting.has(queuedId) || sent?.kind !== 'user_text' || !entry.session.cancelQueued) throw new Error('The agent has already taken this message')
      if (!(await entry.session.cancelQueued(queuedId))) throw new Error('The agent has already taken this message')
      entry.waiting.delete(queuedId)
      // The images sent with it are stored straight after it; they go back to the composer too.
      const events = store.events(threadId)
      const at = events.findIndex((e) => e.event.kind === 'user_text' && e.event.queuedId === queuedId)
      const after = events.slice(at + 1)
      const end = after.findIndex((e) => !(e.event.kind === 'image' && e.event.from === 'you'))
      const images = (end < 0 ? after : after.slice(0, end)).flatMap(({ event }) =>
        event.kind === 'image' ? [{ file: event.file, ...(event.name ? { name: event.name } : {}) }] : [])
      // The turn already ended and only this message kept it working: it is done now. Before
      // recording, so the update carries the new status.
      if (entry.afterResult && entry.waiting.size === 0) {
        entry.afterResult = false
        entry.turnRunning = false
        entry.stopRequested = false
        if (entry.helpers.size === 0) armIdleClose(entry)
      }
      record(threadId, { kind: 'user_unqueued', id: queuedId })
      return { text: sent.text, images }
    },
    answerQuestion(threadId, requestId, answers) {
      const entry = live.get(threadId)
      if (!entry?.session.alive()) throw new Error('These questions belong to a session that has ended')
      const open = entry.questions.get(requestId)
      if (!open || !entry.turnRunning || !entry.session.respondQuestion) throw new Error('Unknown or expired questions')
      // Only answers to the questions asked, so a stale or forged key never reaches the agent.
      const kept = answers ? Object.fromEntries(Object.entries(answers).filter(([id, value]) => open.ids.has(id) && value.trim().length > 0)) : undefined
      entry.questions.delete(requestId)
      entry.session.respondQuestion(open.request, kept && Object.keys(kept).length > 0 ? kept : undefined)
    },
    interrupt(threadId) {
      hostActions.cancel(threadId)
      const entry = live.get(threadId)
      if (!entry) return
      entry.stopRequested = true
      entry.session.interrupt()
    },
    setCompleted(threadId, completed) {
      requireMeta(threadId)
      // J11: nothing to complete while the agent is still at it. Reopening is always allowed.
      if (completed && busy(live.get(threadId))) throw new ThreadBusyError('Mark it complete when the agent has finished')
      const meta = store.update(threadId, { completed })
      record(threadId, { kind: 'completion_changed', completed })
      return meta
    },
    noteBranchChange(projectPath, from, to, byThreadId) {
      const byTitle = byThreadId ? store.get(byThreadId)?.title : undefined
      for (const meta of store.list()) {
        if (meta.projectPath !== projectPath || meta.id === byThreadId || deleted.has(meta.id)) continue
        record(meta.id, { kind: 'branch_changed', from, to, ...(byTitle ? { byTitle } : {}) })
      }
    },
    dismissAwaiting(threadId) {
      requireMeta(threadId)
      if (!awaitingOf(store.events(threadId))) throw new Error('Nothing is waiting on you in this conversation')
      record(threadId, { kind: 'awaiting_dismissed' })
    },
    currentRunId: (threadId) => (live.get(threadId)?.turnRunning ? live.get(threadId)?.runId : undefined),
    async remove(threadId) {
      requireMeta(threadId)
      hostActions.cancel(threadId)
      deleted.add(threadId)
      const entry = live.get(threadId)
      live.delete(threadId)
      generations.delete(threadId)
      if (entry) await closeEntry(entry)
      store.remove(threadId)
      images.remove(threadId)
      const update: ThreadUpdate = { threadId, event: { kind: 'thread_deleted' }, status: 'idle' }
      for (const listener of listeners) listener(update)
    },
    switchAgent(threadId, settings) {
      const meta = requireMeta(threadId)
      const entry = live.get(threadId)
      if (busy(entry)) throw new Error('Stop the current turn before switching agents')
      generations.delete(threadId)
      live.delete(threadId)
      if (entry) void closeEntry(entry)
      const handoff = buildHandoff(store.events(threadId), meta.projectPath, images.dir(threadId))
      store.append(threadId, { kind: 'agent_switch', from: meta.settings.agent, to: settings.agent })
      const next = store.update(threadId, { settings, sessionId: randomUUID(), bindingId: randomUUID(), sessionStarted: false, handoff })
      broadcast(threadId, { kind: 'agent_switch', from: meta.settings.agent, to: settings.agent })
      return next
    },
    changeSettings(threadId, settings) {
      const meta = requireMeta(threadId)
      if (settings.agent !== meta.settings.agent) throw new Error('Switch agents to change the agent')
      const entry = live.get(threadId)
      if (busy(entry)) throw new Error('Stop the current turn before changing settings')
      // Close the idle session; the next message relaunches it with the new flags and resumes it.
      generations.delete(threadId)
      live.delete(threadId)
      if (entry) void closeEntry(entry)
      const next = store.update(threadId, { settings })
      record(threadId, { kind: 'settings_changed', ...(settings.model ? { model: settings.model } : {}), ...(settings.effort ? { effort: settings.effort } : {}), permissionMode: settings.permissionMode })
      return next
    },
    resumeRecovered(threadId, agent, text, agentText) {
      const meta = requireMeta(threadId)
      const entry = live.get(threadId)
      if (busy(entry)) throw new Error('Stop the current turn before resuming recent work')
      const settings: ThreadSettings = { agent, permissionMode: 'manual', useHooks: false }
      if (agent !== meta.settings.agent) this.switchAgent(threadId, settings)
      else {
        // Re-launch even an idle session so an earlier permissive policy cannot survive recovery.
        generations.delete(threadId)
        live.delete(threadId)
        if (entry) void closeEntry(entry)
        store.update(threadId, { settings })
      }
      send(threadId, text, agentText)
      return requireMeta(threadId)
    },
    recoverInterrupted() {
      const recovered: string[] = []
      for (const meta of store.list()) {
        if (live.has(meta.id) || deleted.has(meta.id)) continue
        const run = unfinishedRun(meta.id, store.events(meta.id))
        if (!run) continue
        record(meta.id, { kind: 'result', ok: false, interrupted: true, runId: run.runId })
        recovered.push(meta.id)
      }
      return recovered
    },
    summaries() {
      const all = store.list().map((meta): ThreadSummary => {
        const events = store.events(meta.id)
        return {
          meta,
          status: deriveStatus(events, busy(live.get(meta.id))),
          preview: previewOf(events),
          messageCount: messageCountOf(events),
          lastActivityAt: events.findLast((e) => !QUIET.has(e.event.kind))?.ts ?? meta.updatedAt,
          ...(awaitingOf(events) ? { awaiting: awaitingOf(events) } : {}),
          ...(busy(live.get(meta.id)) && openQuestion(events) ? { asking: openQuestion(events) } : {}),
          ...(latestTurn(events) ? { turn: latestTurn(events) } : {}),
        }
      })
      return all.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
    },
    status: statusOf,
    partialText: (threadId) => live.get(threadId)?.partial ?? '',
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async shutdown() {
      hostActions.cancel()
      await Promise.all([...closing, ...[...live.values()].map(closeEntry)])
    },
  }
}
