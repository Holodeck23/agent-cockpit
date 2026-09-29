import { randomUUID } from 'node:crypto'
import { launchClaude } from '../agents/claude/launch.ts'
import { launchCodex } from '../agents/codex/launch.ts'
import { claudeMcpOptions, codexMcpConfigArgs } from '../mcp/wiring.ts'
import { COCKPIT_GUIDANCE, type CockpitMcpLaunch, type McpGrant } from '../mcp/sessions.ts'
import { buildHandoff } from './handoff.ts'
import type { AgentId, AgentSession, ApprovalBehavior, EventSink, NormalizedEvent, PendingApproval } from '../agents/types.ts'
import { deriveStatus, messageCountOf, previewOf } from './status.ts'
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
}
export type Launcher = (request: LaunchRequest, onEvent: EventSink) => AgentSession

export interface ThreadUpdate {
  readonly threadId: string
  readonly event: NormalizedEvent
  readonly status: ThreadStatus
}
export type UpdateListener = (update: ThreadUpdate) => void

const IDLE_CLOSE_MS = 5 * 60_000

/** Cockpit guidance first (only when its tools are attached), then any handoff seed. */
const instructionsFor = (req: LaunchRequest): string | undefined =>
  [req.cockpit ? COCKPIT_GUIDANCE : undefined, req.seed].filter(Boolean).join('\n\n') || undefined

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
}

/** Issues a session's cockpit MCP launch; `release` revokes its token when the session ends. */
export type McpProvider = (grant: McpGrant) => { readonly launch: CockpitMcpLaunch; release(): void }

export interface ManagerOptions {
  readonly launchers?: Record<AgentId, Launcher>
  readonly mcp?: McpProvider
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
   * and workflow references.
   */
  create(input: { projectPath: string; title?: string; settings: ThreadSettings; text: string; agentText?: string; workflowId?: string; workflowTrigger?: 'manual' | 'scheduled' }): ThreadMeta
  send(threadId: string, text: string, agentText?: string): void
  approve(threadId: string, requestId: string, behavior: ApprovalBehavior): void
  interrupt(threadId: string): void
  setCompleted(threadId: string, completed: boolean): ThreadMeta
  /** Hand the thread to another agent/model; the transcript goes with it. */
  switchAgent(threadId: string, settings: ThreadSettings): ThreadMeta
  summaries(): ThreadSummary[]
  status(threadId: string): ThreadStatus
  /** The agent message currently being streamed, or '' between messages. */
  partialText(threadId: string): string
  subscribe(listener: UpdateListener): () => void
  /** Stops every live agent session; resolves once all have exited. */
  shutdown(): Promise<void>
}

export function createThreadManager(store: ThreadStore, options: ManagerOptions = {}): ThreadManager {
  const launchers = options.launchers ?? defaultLaunchers
  const live = new Map<string, Live>()
  const listeners = new Set<UpdateListener>()
  const generations = new Map<string, symbol>()
  const closing = new Set<Promise<void>>()

  const closeEntry = (entry: Live): Promise<void> => {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
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
    const entry = live.get(threadId)
    // A failed result right after the user pressed Stop is a stop, not an error.
    const event: NormalizedEvent =
      incoming.kind === 'result' && !incoming.ok && entry?.stopRequested ? { ...incoming, stopped: true } : incoming
    // Deltas are for live rendering only; the final assistant_text is persisted.
    if (event.kind !== 'text_delta') store.append(threadId, event)
    if (entry && event.kind === 'text_delta') entry.partial += event.text
    if (entry && (event.kind === 'assistant_text' || event.kind === 'result')) entry.partial = ''
    // Codex assigns its own thread id; remember it so the next process resumes it.
    if (event.kind === 'session') {
      const meta = store.get(threadId)
      if (meta && meta.sessionId !== event.sessionId) store.update(threadId, { sessionId: event.sessionId })
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
    const session = launchers[meta.settings.agent](
      {
        cwd: meta.projectPath,
        settings: meta.settings,
        ...(meta.sessionStarted ? { resume: meta.sessionId } : { sessionId: meta.sessionId }),
        ...(meta.handoff && !meta.sessionStarted ? { seed: meta.handoff } : {}),
        ...(mcp ? { cockpit: mcp.launch } : {}),
      },
      (event) => {
        if (event.kind === 'exit') mcp?.release()
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
      },
    )
    const entry: Live = { pending, session, turnRunning: false, stopRequested: false, partial: '' }
    live.set(meta.id, entry)
    if (!meta.sessionStarted) store.update(meta.id, { sessionStarted: true, handoff: undefined })
    return entry
  }

  const requireMeta = (threadId: string): ThreadMeta => {
    const meta = store.get(threadId)
    if (!meta) throw new Error(`Unknown thread ${threadId}`)
    return meta
  }

  const send = (threadId: string, text: string, agentText = text): void => {
    const meta = requireMeta(threadId)
    const entry = ensureSession(meta)
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.turnRunning = true
    if (meta.completed) {
      store.update(threadId, { completed: false })
      record(threadId, { kind: 'completion_changed', completed: false })
    } else store.update(threadId, {})
    record(threadId, { kind: 'user_text', text })
    entry.session.send(agentText)
  }

  return {
    create({ projectPath, title, settings, text, agentText, workflowId, workflowTrigger }) {
      const now = new Date().toISOString()
      const meta = store.create({
        id: randomUUID(),
        workflowId, workflowTrigger,
        title: title?.trim() || text.slice(0, 60),
        projectPath,
        settings,
        sessionId: randomUUID(),
        sessionStarted: false,
        completed: false,
        createdAt: now,
        updatedAt: now,
      })
      send(meta.id, text, agentText)
      return meta
    },
    send,
    approve(threadId, requestId, behavior) {
      const entry = live.get(threadId)
      if (!entry?.session.alive()) throw new Error('This approval belongs to a session that has ended')
      const request = entry.pending.get(requestId)
      if (!request || !entry.turnRunning) throw new Error('Unknown or expired approval request')
      entry.pending.delete(requestId)
      entry.session.respondApproval(request, behavior)
    },
    interrupt(threadId) {
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
    summaries() {
      const all = store.list().map((meta): ThreadSummary => {
        const events = store.events(meta.id)
        return {
          meta,
          status: deriveStatus(events, live.get(meta.id)?.turnRunning ?? false),
          preview: previewOf(events),
          messageCount: messageCountOf(events),
          lastActivityAt: events.at(-1)?.ts ?? meta.updatedAt,
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
      await Promise.all([...closing, ...[...live.values()].map(closeEntry)])
    },
  }
}
