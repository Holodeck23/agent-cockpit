import type { StoredEvent, ThreadStatus } from './types.ts'
import { parseConclusion, turnRoles } from './turns.ts'

/** Approval requests and agent questions that have not been answered yet, oldest first. */
export function openApprovals(events: readonly StoredEvent[]): string[] {
  const pending = new Set<string>()
  for (const { event } of events) {
    if (event.kind === 'session_boundary' || event.kind === 'exit' || event.kind === 'agent_switch' || event.kind === 'result') {
      pending.clear()
    } else if (event.kind === 'approval_request' || event.kind === 'question') pending.add(event.requestId)
    else if (event.kind === 'approval_resolved' || event.kind === 'question_answered') pending.delete(event.requestId)
  }
  return [...pending]
}

/** Helpers (sub-agents) started in the current agent session that have not finished. */
export function runningHelpers(events: readonly StoredEvent[]): string[] {
  const running = new Set<string>()
  for (const { event } of events) {
    if (event.kind === 'session_boundary' || event.kind === 'exit' || event.kind === 'agent_switch') running.clear()
    else if (event.kind === 'subagent' && event.phase === 'started') running.add(event.id)
    else if (event.kind === 'subagent' && event.phase === 'finished') running.delete(event.id)
  }
  return [...running]
}

/**
 * Status comes from the event log alone, plus whether a turn is in flight.
 * Approvals from a process that has since exited are dead, so they only count
 * while a turn is running.
 */
export function deriveStatus(events: readonly StoredEvent[], turnRunning: boolean): ThreadStatus {
  if (turnRunning && openApprovals(events).length > 0) return 'needs_input'
  if (turnRunning) return 'working'
  const last = [...events].reverse().find(({ event }) => event.kind === 'result' || event.kind === 'error' || event.kind === 'user_text')
  if (!last) return 'idle'
  if (last.event.kind === 'result') return last.event.ok ? 'done' : last.event.stopped ? 'idle' : 'error'
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
