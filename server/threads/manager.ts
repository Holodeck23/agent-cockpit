import { createHostActions } from './host-actions.ts'
import { randomUUID } from 'node:crypto'
import { launchAntigravity } from '../agents/antigravity/launch.ts'
import { launchOpencode } from '../agents/opencode/launch.ts'
import { launchClaude } from '../agents/claude/launch.ts'
import { launchCodex } from '../agents/codex/launch.ts'
import { claudeMcpOptions, codexMcpConfigArgs } from '../mcp/wiring.ts'
import { COCKPIT_GUIDANCE, MCP_SERVER_NAME, type CockpitMcpLaunch, type McpGrant } from '../mcp/sessions.ts'
import { buildHandoff } from './handoff.ts'
import type { AgentId, AgentSession, ApprovalBehavior, EventSink, NormalizedEvent, PendingApproval, WorkflowSnapshot } from '../agents/types.ts'
import { deriveStatus, messageCountOf, previewOf } from './status.ts'
import { awaitingOf } from './turns.ts'
import type { ThreadStore } from './store.ts'
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
}
export type Launcher = (request: LaunchRequest, onEvent: EventSink) => AgentSession

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
const QUIET = new Set<NormalizedEvent['kind']>(['awaiting_dismissed', 'branch_changed', 'settings_changed'])

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
        effort: req.settings.effort,
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
      effort: req.settings.effort,
      permissionMode: req.settings.permissionMode,
      resume: req.resume,
      instructions: instructionsFor(req),
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
}

interface Live {
  readonly pending: Map<string, PendingApproval>
  readonly session: AgentSession
  turnRunning: boolean
  stopRequested: boolean
  /** Text streamed so far for the message in progress, so a late viewer sees all of it. */
  partial: string
  idleTimer?: NodeJS.Timeout
}

export interface ThreadManager {
  /**
   * `text` is what the user wrote (stored, titled, shown); `agentText` is what the
   * agent receives when references were expanded. They differ only for attachments
   * and workflow references. `workflows` records the referenced instructions as they were used.
   */
  requestHostAction(threadId: string, toolName: string, input: unknown, signal?: AbortSignal): Promise<void>
  canControl(threadId: string): boolean
  create(input: { createdByThreadId?: string; delegationDepth?: number; projectPath: string; title?: string; settings: ThreadSettings; text: string; agentText?: string; workflows?: readonly WorkflowSnapshot[]; workflowId?: string; workflowTrigger?: 'manual' | 'scheduled' }): ThreadMeta
  send(threadId: string, text: string, agentText?: string, workflows?: readonly WorkflowSnapshot[], fromConversation?: { id: string; title: string }): void
  approve(threadId: string, requestId: string, behavior: ApprovalBehavior): void
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

  const closeEntry = (entry: Live): Promise<void> => {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.stopRequested = true
    const closingSession = entry.session.close()
    closing.add(closingSession)
    void closingSession.then(() => closing.delete(closingSession), () => closing.delete(closingSession))
    return closingSession
  }

  const statusOf = (threadId: string): ThreadStatus =>
    deriveStatus(store.events(threadId), live.get(threadId)?.turnRunning ?? false)

  const broadcast = (threadId: string, event: NormalizedEvent): void => {
    const update: ThreadUpdate = { threadId, event, status: statusOf(threadId) }
    for (const listener of listeners) listener(update)
  }

  const record = (threadId: string, incoming: NormalizedEvent): void => {
    if (deleted.has(threadId)) return
    if (incoming.kind === 'result' || incoming.kind === 'exit' || incoming.kind === 'agent_switch') hostActions.cancel(threadId)
    const entry = live.get(threadId)
    // A dead process cannot finish its turn later. Do not apply this to protocol errors.
    if (incoming.kind === 'exit' && entry?.turnRunning) record(threadId, { kind: 'result', ok: false })
    // A failed result right after the user pressed Stop is a stop, not an error.
    const event: NormalizedEvent =
      incoming.kind === 'result' && !incoming.ok && entry?.stopRequested ? { ...incoming, stopped: true } : incoming
    // Deltas are for live rendering only; the final assistant_text is persisted.
    if (event.kind !== 'text_delta') store.append(threadId, event)
    if (entry && event.kind === 'text_delta') entry.partial += event.text
    if (entry && (event.kind === 'assistant_text' || event.kind === 'result')) entry.partial = ''
    // Only provider evidence makes a session resumable; constructing a process does not.
    if (event.kind === 'session') {
      const meta = store.get(threadId)
      if (meta) store.update(threadId, { sessionId: event.sessionId, sessionStarted: true, handoff: undefined })
    }
    if (entry && event.kind === 'result') {
      entry.pending.clear()
      entry.turnRunning = false
      entry.stopRequested = false
      entry.idleTimer = setTimeout(() => void entry.session.close(), IDLE_CLOSE_MS)
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
    const requestIds = new Map<string, string>()
    record(meta.id, { kind: 'session_boundary' })
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
    const handleEvent: EventSink = (event) => {
      if (event.kind === 'exit' && !released) { released = true; mcp?.release() }
      // An old process may exit after its replacement has already started.
      if (generations.get(meta.id) !== generation) return
      if (event.kind === 'approval_request') {
        const publicId = randomUUID()
        requestIds.set(event.requestId, publicId)
        pending.set(publicId, { requestId: event.requestId, input: event.input, suggestions: event.suggestions })
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
      },
      deliver,
    )
    launching = false
    const entry: Live = { pending, session, turnRunning: false, stopRequested: false, partial: '' }
    live.set(meta.id, entry)
    store.update(meta.id, { instructionsRevision: instructions?.revision, instructionsText: instructions?.text })
    return entry
  }

  const requireMeta = (threadId: string): ThreadMeta => {
    const meta = store.get(threadId)
    if (!meta) throw new Error(`Unknown thread ${threadId}`)
    return meta
  }

  const send = (threadId: string, text: string, agentText = text, workflows?: readonly WorkflowSnapshot[], fromConversation?: { id: string; title: string }): void => {
    hostActions.cancel(threadId)
    if (deleted.has(threadId)) throw new Error('This conversation was deleted')
    const meta = requireMeta(threadId)
    const entry = ensureSession(meta)
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.turnRunning = true
    if (meta.completed) {
      store.update(threadId, { completed: false })
      record(threadId, { kind: 'completion_changed', completed: false })
    } else store.update(threadId, {})
    record(threadId, { kind: 'user_text', text, ...(fromConversation ? { fromConversation } : {}), ...(workflows?.length ? { workflows } : {}) })
    entry.session.send(agentText)
  }

  return {
    canControl: (id) => Boolean(live.get(id)?.turnRunning && !live.get(id)?.stopRequested),
    requestHostAction(threadId, toolName, input, signal) {
      if (!live.get(threadId)?.turnRunning || live.get(threadId)?.stopRequested) return Promise.reject(new Error("The calling conversation is no longer working"))
      return hostActions.request(threadId, toolName, input, signal)
    },
    create({ projectPath, title, settings, text, agentText, workflows, workflowId, workflowTrigger, createdByThreadId, delegationDepth }) {
      const now = new Date().toISOString()
      const meta = store.create({
        id: randomUUID(),
        workflowId, workflowTrigger,
        ...(createdByThreadId ? { createdByThreadId, delegationDepth } : {}),
        title: title?.trim() || text.slice(0, 60),
        projectPath,
        settings,
        sessionId: randomUUID(),
        sessionStarted: false,
        completed: false,
        createdAt: now,
        updatedAt: now,
      })
      const source = createdByThreadId ? store.get(createdByThreadId) : undefined
      send(meta.id, text, agentText, workflows, source ? { id: source.id, title: source.title } : undefined)
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
    interrupt(threadId) {
      hostActions.cancel(threadId)
      const entry = live.get(threadId)
      if (!entry) return
      entry.stopRequested = true
      entry.session.interrupt()
    },
    setCompleted(threadId, completed) {
      requireMeta(threadId)
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
    async remove(threadId) {
      requireMeta(threadId)
      hostActions.cancel(threadId)
      deleted.add(threadId)
      const entry = live.get(threadId)
      live.delete(threadId)
      generations.delete(threadId)
      if (entry) await closeEntry(entry)
      store.remove(threadId)
      const update: ThreadUpdate = { threadId, event: { kind: 'thread_deleted' }, status: 'idle' }
      for (const listener of listeners) listener(update)
    },
    switchAgent(threadId, settings) {
      const meta = requireMeta(threadId)
      const entry = live.get(threadId)
      if (entry?.turnRunning) throw new Error('Stop the current turn before switching agents')
      generations.delete(threadId)
      live.delete(threadId)
      if (entry) void closeEntry(entry)
      const handoff = buildHandoff(store.events(threadId), meta.projectPath)
      store.append(threadId, { kind: 'agent_switch', from: meta.settings.agent, to: settings.agent })
      const next = store.update(threadId, { settings, sessionId: randomUUID(), sessionStarted: false, handoff })
      broadcast(threadId, { kind: 'agent_switch', from: meta.settings.agent, to: settings.agent })
      return next
    },
    changeSettings(threadId, settings) {
      const meta = requireMeta(threadId)
      if (settings.agent !== meta.settings.agent) throw new Error('Switch agents to change the agent')
      const entry = live.get(threadId)
      if (entry?.turnRunning) throw new Error('Stop the current turn before changing settings')
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
      if (entry?.turnRunning) throw new Error('Stop the current turn before resuming recent work')
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
    summaries() {
      const all = store.list().map((meta): ThreadSummary => {
        const events = store.events(meta.id)
        return {
          meta,
          status: deriveStatus(events, live.get(meta.id)?.turnRunning ?? false),
          preview: previewOf(events),
          messageCount: messageCountOf(events),
          lastActivityAt: events.findLast((e) => !QUIET.has(e.event.kind))?.ts ?? meta.updatedAt,
          ...(awaitingOf(events) ? { awaiting: awaitingOf(events) } : {}),
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
