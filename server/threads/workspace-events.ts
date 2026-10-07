import type { StoredEvent } from './types.ts'

// Which workspace each event of a conversation belongs to (W12-15). Since order 18 every event is
// stored with the workspace of the session that produced it, so two agents working at once in one
// conversation never read as one. Older events carry no tag: they belong to the workspace the
// conversation was working in then, which its session boundaries and workspace changes record.

/** One workspace's part of a conversation: '' for events from before any workspace was named. */
export type WorkspaceKey = string

/** The workspace of every event, in order. */
export function attribute(events: readonly StoredEvent[]): WorkspaceKey[] {
  let current: WorkspaceKey = ''
  return events.map(({ event, workspaceId }) => {
    if (event.kind === 'session_boundary' && event.workspaceId && !workspaceId) current = event.workspaceId
    if (event.kind === 'workspace_changed') current = event.to
    return workspaceId ?? current
  })
}

/** The conversation's events per workspace, each in order. A conversation that never named one is a single part. */
export function partition(events: readonly StoredEvent[]): Map<WorkspaceKey, StoredEvent[]> {
  const keys = attribute(events)
  const parts = new Map<WorkspaceKey, StoredEvent[]>()
  // Events from before any workspace was named belong to whichever workspace came first.
  const first = keys.find((k) => k !== '') ?? ''
  events.forEach((stored, i) => {
    const key = keys[i] || first
    const part = parts.get(key)
    if (part) part.push(stored)
    else parts.set(key, [stored])
  })
  return parts
}

/** One workspace's events; a conversation that only ever had one part returns all of them. */
export function eventsIn(events: readonly StoredEvent[], workspaceId: WorkspaceKey): StoredEvent[] {
  const parts = partition(events)
  if (parts.size <= 1) return [...events]
  return parts.get(workspaceId) ?? []
}
