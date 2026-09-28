import { randomUUID } from 'node:crypto'
import { launchClaude } from '../agents/claude/launch.ts'
import type { AgentId, AgentSession, ApprovalBehavior, EventSink, NormalizedEvent } from '../agents/types.ts'
import { deriveStatus, previewOf } from './status.ts'
import type { ThreadStore } from './store.ts'
import type { ThreadMeta, ThreadSettings, ThreadStatus, ThreadSummary } from './types.ts'

export interface LaunchRequest {
  readonly cwd: string
  readonly settings: ThreadSettings
  readonly sessionId?: string
  readonly resume?: string
}
export type Launcher = (request: LaunchRequest, onEvent: EventSink) => AgentSession

export interface ThreadUpdate {
  readonly threadId: string
  readonly event: NormalizedEvent
  readonly status: ThreadStatus
}
export type UpdateListener = (update: ThreadUpdate) => void

const IDLE_CLOSE_MS = 5 * 60_000

export const defaultLaunchers: Record<AgentId, Launcher> = {
  claude: (req, onEvent) =>
    launchClaude(
      {
        cwd: req.cwd,
        model: req.settings.model,
        effort: req.settings.effort,
        permissionMode: req.settings.permissionMode,
        useHooks: req.settings.useHooks,
        sessionId: req.sessionId,
        resume: req.resume,
      },
      onEvent,
    ),
  codex: () => {
    throw new Error('Codex adapter arrives in phase 3')
  },
}

interface Live {
  readonly session: AgentSession
  turnRunning: boolean
  stopRequested: boolean
  idleTimer?: NodeJS.Timeout
}

export interface ThreadManager {
  create(input: { projectPath: string; title?: string; settings: ThreadSettings; text: string }): ThreadMeta
  send(threadId: string, text: string): void
  approve(threadId: string, requestId: string, behavior: ApprovalBehavior): void
  interrupt(threadId: string): void
  setCompleted(threadId: string, completed: boolean): ThreadMeta
  summaries(): ThreadSummary[]
  status(threadId: string): ThreadStatus
  subscribe(listener: UpdateListener): () => void
  shutdown(): void
}

export function createThreadManager(store: ThreadStore, launchers: Record<AgentId, Launcher> = defaultLaunchers): ThreadManager {
  const live = new Map<string, Live>()
  const listeners = new Set<UpdateListener>()

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
    if (entry && event.kind === 'result') {
      entry.turnRunning = false
      entry.stopRequested = false
      entry.idleTimer = setTimeout(() => entry.session.close(), IDLE_CLOSE_MS)
    }
    if (event.kind === 'exit') live.delete(threadId)
    broadcast(threadId, event)
  }

  const ensureSession = (meta: ThreadMeta): Live => {
    const existing = live.get(meta.id)
    if (existing?.session.alive()) return existing
    const session = launchers[meta.settings.agent](
      {
        cwd: meta.projectPath,
        settings: meta.settings,
        ...(meta.sessionStarted ? { resume: meta.sessionId } : { sessionId: meta.sessionId }),
      },
      (event) => record(meta.id, event),
    )
    const entry: Live = { session, turnRunning: false, stopRequested: false }
    live.set(meta.id, entry)
    if (!meta.sessionStarted) store.update(meta.id, { sessionStarted: true })
    return entry
  }

  const requireMeta = (threadId: string): ThreadMeta => {
    const meta = store.get(threadId)
    if (!meta) throw new Error(`Unknown thread ${threadId}`)
    return meta
  }

  const send = (threadId: string, text: string): void => {
    const meta = requireMeta(threadId)
    const entry = ensureSession(meta)
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.turnRunning = true
    if (meta.completed) store.update(threadId, { completed: false })
    else store.update(threadId, {})
    entry.session.send(text)
  }

  return {
    create({ projectPath, title, settings, text }) {
      const now = new Date().toISOString()
      const meta = store.create({
        id: randomUUID(),
        title: title?.trim() || text.slice(0, 60),
        projectPath,
        settings,
        sessionId: randomUUID(),
        sessionStarted: false,
        completed: false,
        createdAt: now,
        updatedAt: now,
      })
      send(meta.id, text)
      return meta
    },
    send,
    approve(threadId, requestId, behavior) {
      const entry = live.get(threadId)
      if (!entry?.session.alive()) throw new Error('This approval belongs to a session that has ended')
      const request = store
        .events(threadId)
        .map(({ event }) => event)
        .find((event) => event.kind === 'approval_request' && event.requestId === requestId)
      if (request?.kind !== 'approval_request') throw new Error('Unknown approval request')
      entry.session.respondApproval({ requestId, input: request.input, suggestions: request.suggestions }, behavior)
    },
    interrupt(threadId) {
      const entry = live.get(threadId)
      if (!entry) return
      entry.stopRequested = true
      entry.session.interrupt()
    },
    setCompleted(threadId, completed) {
      requireMeta(threadId)
      return store.update(threadId, { completed })
    },
    summaries() {
      return store.list().map((meta) => {
        const events = store.events(meta.id)
        return {
          meta,
          status: deriveStatus(events, live.get(meta.id)?.turnRunning ?? false),
          preview: previewOf(events),
        }
      })
    },
    status: statusOf,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    shutdown() {
      for (const entry of live.values()) entry.session.close()
    },
  }
}
