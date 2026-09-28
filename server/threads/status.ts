import type { StoredEvent, ThreadStatus } from './types.ts'

/** Approval requests that have not been answered yet, oldest first. */
export function openApprovals(events: readonly StoredEvent[]): string[] {
  const pending = new Set<string>()
  for (const { event } of events) {
    if (event.kind === 'session_boundary' || event.kind === 'exit' || event.kind === 'agent_switch' || event.kind === 'result') {
      pending.clear()
    } else if (event.kind === 'approval_request') pending.add(event.requestId)
    else if (event.kind === 'approval_resolved') pending.delete(event.requestId)
  }
  return [...pending]
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

/** Last assistant (or user) text, for the thread list. */
export function previewOf(events: readonly StoredEvent[]): string {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]?.event
    if (event?.kind === 'assistant_text' || event?.kind === 'user_text') return event.text.slice(0, 140)
  }
  return ''
}
