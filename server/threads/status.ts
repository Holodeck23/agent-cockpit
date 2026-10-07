import type { StoredEvent, ThreadStatus } from './types.ts'
import { parseConclusion, turnRoles } from './turns.ts'
import { partition, type WorkspaceKey } from './workspace-events.ts'

// Two agents can work at once in one conversation, each in its own workspace (W12-15). What is
// open, waiting or running is worked out per workspace and then combined, so one run's result or
// new session never closes another's approvals, queue or helpers.
const acrossWorkspaces = <T>(events: readonly StoredEvent[], one: (part: readonly StoredEvent[]) => T[]): T[] => {
  const parts = partition(events)
  return parts.size <= 1 ? one(events) : [...parts.values()].flatMap(one)
}
const anyWorkspace = (events: readonly StoredEvent[], one: (part: readonly StoredEvent[]) => boolean): boolean => {
  const parts = partition(events)
  return parts.size <= 1 ? one(events) : [...parts.values()].some(one)
}

/** Approval requests and agent questions that have not been answered yet, oldest first within each workspace. */
export const openApprovals = (events: readonly StoredEvent[]): string[] => acrossWorkspaces(events, openApprovalsIn)
function openApprovalsIn(events: readonly StoredEvent[]): string[] {
  const pending = new Set<string>()
  for (const { event } of events) {
    if (event.kind === 'session_boundary' || event.kind === 'exit' || event.kind === 'agent_switch' || event.kind === 'result') {
      pending.clear()
    } else if (event.kind === 'approval_request' || event.kind === 'question') pending.add(event.requestId)
    else if (event.kind === 'approval_resolved' || event.kind === 'question_answered') pending.delete(event.requestId)
  }
  return [...pending]
}

/** The first open agent question (J6), oldest first; undefined when none waits. */
export function openQuestion(events: readonly StoredEvent[]): string | undefined {
  const open = new Set(openApprovals(events))
  for (const { event } of events) if (event.kind === 'question' && open.has(event.requestId)) return event.questions[0]?.question
  return undefined
}

const TURN_ACTIVITY = new Set(['text_delta', 'assistant_text', 'tool_use', 'subagent', 'compaction', 'question'])

/**
 * When the latest turn started and, once it has, ended (A11): from your message, or from the
 * agent's own output when it reports back unasked (a helper finished between turns).
 */
export function latestTurn(events: readonly StoredEvent[]): { startedAt: string; endedAt?: string } | undefined {
  let startedAt: string | undefined
  let endedAt: string | undefined
  for (const { ts, event } of events) {
    if (event.kind === 'user_text' && (!startedAt || endedAt)) { startedAt = ts; endedAt = undefined }
    else if (TURN_ACTIVITY.has(event.kind) && startedAt && endedAt && !(event.kind === 'subagent' && event.phase !== 'progress')) { startedAt = ts; endedAt = undefined }
    else if (event.kind === 'result' && startedAt && !endedAt) endedAt = ts
  }
  return startedAt ? { startedAt, ...(endedAt ? { endedAt } : {}) } : undefined
}

/** Messages you sent mid-turn that the agent has not taken yet (J1), by queued id. */
export const waitingMessages = (events: readonly StoredEvent[]): string[] => acrossWorkspaces(events, waitingMessagesIn)
function waitingMessagesIn(events: readonly StoredEvent[]): string[] {
  const waiting = new Set<string>()
  for (const { event } of events) {
    if (event.kind === 'session_boundary' || event.kind === 'exit' || event.kind === 'agent_switch') waiting.clear()
    else if (event.kind === 'user_text' && event.queuedId) waiting.add(event.queuedId)
    else if (event.kind === 'user_taken' && event.id) waiting.delete(event.id)
    else if (event.kind === 'user_unqueued') waiting.delete(event.id)
  }
  return [...waiting]
}

/** An agent is summarising earlier context right now (J3): its last compaction started and has not finished. */
export const compactingNow = (events: readonly StoredEvent[]): boolean => anyWorkspace(events, compactingNowIn)
function compactingNowIn(events: readonly StoredEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const { event } = events[i]!
    if (event.kind === 'compaction') return event.phase === 'started'
    if (event.kind === 'result' || event.kind === 'exit' || event.kind === 'session_boundary') return false
  }
  return false
}

/** Helpers (sub-agents) started in the current agent sessions that have not finished. */
export const runningHelpers = (events: readonly StoredEvent[]): string[] => acrossWorkspaces(events, runningHelpersIn)
function runningHelpersIn(events: readonly StoredEvent[]): string[] {
  const running = new Set<string>()
  for (const { event } of events) {
    if (event.kind === 'session_boundary' || event.kind === 'exit' || event.kind === 'agent_switch') running.clear()
    else if (event.kind === 'subagent' && event.phase === 'started') running.add(event.id)
    else if (event.kind === 'subagent' && event.phase === 'finished') running.delete(event.id)
  }
  return [...running]
}

// Anything that only the agent's process can produce: proof it is up, or that it failed.
const PROVIDER_EVIDENCE = new Set([
  'session', 'assistant_text', 'tool_use', 'tool_result', 'subagent', 'compaction', 'question', 'approval_request',
  'image', 'user_taken', 'result', 'error', 'exit',
])

/**
 * The agent process was launched (session_boundary) and has reported nothing since: no session,
 * no output, no failure. Cockpit cannot see further into a CLI's startup than that.
 */
export const startingNow = (events: readonly StoredEvent[]): boolean => anyWorkspace(events, startingNowIn)
function startingNowIn(events: readonly StoredEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const { event } = events[i]!
    if (event.kind === 'session_boundary') return true
    if (PROVIDER_EVIDENCE.has(event.kind) && !(event.kind === 'image' && event.from !== 'agent')) return false
  }
  return false
}

/** A turn is in flight: starting, at work, or held on your answer. */
export const isBusy = (status: ThreadStatus): boolean => status === 'starting' || status === 'working' || status === 'needs_input'

/**
 * Status comes from the event log alone, plus whether a turn is in flight.
 * Approvals from a process that has since exited are dead, so they only count
 * while a turn is running. Starting lasts only while a turn runs, so a launch that
 * fails or is stopped falls through to Error or Waiting like any other turn.
 */
export function deriveStatus(events: readonly StoredEvent[], turnRunning: boolean | ((workspace: WorkspaceKey) => boolean)): ThreadStatus {
  const parts = partition(events)
  if (typeof turnRunning === 'function') {
    // One workspace: as it always was. Several: the most urgent of them, else how the latest run ended.
    if (parts.size <= 1) return deriveOne(events, [...parts.keys()].some(turnRunning) || turnRunning(''))
    const each = [...parts].map(([key, part]) => deriveOne(part, turnRunning(key)))
    for (const status of ['needs_input', 'working', 'starting'] as const) if (each.includes(status)) return status
    return deriveOne(events, false)
  }
  return deriveOne(events, turnRunning)
}

function deriveOne(events: readonly StoredEvent[], turnRunning: boolean): ThreadStatus {
  if (turnRunning && openApprovalsIn(events).length > 0) return 'needs_input'
  if (turnRunning) return startingNowIn(events) ? 'starting' : 'working'
  const last = [...events].reverse().find(({ event }) => event.kind === 'result' || event.kind === 'error' || event.kind === 'user_text')
  if (!last) return 'idle'
  if (last.event.kind === 'result') return last.event.ok ? 'done' : last.event.stopped || last.event.interrupted ? 'idle' : 'error'
  if (last.event.kind === 'error') return 'error'
  return 'idle'
}

export function messageCountOf(events: readonly StoredEvent[]): number {
  return events.filter(({ event }) => event.kind === 'user_text' || event.kind === 'assistant_text').length
}

/**
 * For the thread list: your latest message or the agent's latest conclusion, whichever is newer.
 * Acknowledgements and updates are skipped (U12), and a conclusion's Question:/Blocked: marker is dropped.
 */
export function previewOf(events: readonly StoredEvent[]): string {
  const roles = turnRoles(events)
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]?.event
    if (event?.kind === 'user_text') return event.text.slice(0, 140)
    if (event?.kind === 'assistant_text' && roles.get(i) === 'conclusion') return parseConclusion(event.text).text.slice(0, 140)
  }
  return ''
}
