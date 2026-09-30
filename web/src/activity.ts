// Turns a thread's stored events into the activity pane's rows: one per tool call,
// with its state, input, output and timing. Pure, so it's unit-tested without a browser.
// Only recorded events are used; nothing is inferred beyond pairing calls with results.
import type { StoredEvent } from '../../server/threads/types.ts'
import { describeTool, friendlyToolName } from './transcript.ts'

/** interrupted: the turn or process ended before the tool reported back. */
export type ActivityState = 'running' | 'done' | 'error' | 'interrupted'

export interface ActivityRow {
  readonly id: string
  readonly label: string
  readonly tool: string
  readonly state: ActivityState
  readonly input: string
  readonly output?: string
  readonly startedAt: string
  readonly endedAt?: string
}

const MAX_DETAIL_CHARS = 4000

const bounded = (text: string): string =>
  text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}\n… ${text.length - MAX_DETAIL_CHARS} more characters` : text

function formatInput(input: unknown): string {
  if (input === undefined || input === null) return ''
  if (typeof input === 'string') return bounded(input)
  try {
    return bounded(JSON.stringify(input, null, 2))
  } catch {
    return bounded(String(input))
  }
}

/** Events after which an unanswered tool call can no longer report back. */
const ENDS_TOOL_CALLS = new Set(['result', 'exit', 'session_boundary', 'agent_switch'])

/**
 * `turnRunning` is false when no turn is in flight (e.g. after a restart): a call that
 * never reported back then shows as interrupted rather than running forever.
 */
export function buildActivity(events: readonly StoredEvent[], turnRunning = true): ActivityRow[] {
  const rows: ActivityRow[] = []
  const open = new Map<string, number>()
  for (const { ts, event } of events) {
    if (event.kind === 'tool_use') {
      open.set(event.id, rows.length)
      rows.push({
        id: event.id,
        label: describeTool(event.name, event.input),
        tool: friendlyToolName(event.name),
        state: 'running',
        input: formatInput(event.input),
        startedAt: ts,
      })
    } else if (event.kind === 'tool_result') {
      const at = open.get(event.toolUseId)
      const row = at === undefined ? undefined : rows[at]
      if (at === undefined || !row) continue
      open.delete(event.toolUseId)
      rows[at] = { ...row, state: event.isError ? 'error' : 'done', output: bounded(event.content), endedAt: ts }
    } else if (ENDS_TOOL_CALLS.has(event.kind)) {
      for (const at of open.values()) {
        const row = rows[at]
        if (row) rows[at] = { ...row, state: 'interrupted', endedAt: ts }
      }
      open.clear()
    }
  }
  if (!turnRunning) {
    for (const at of open.values()) {
      const row = rows[at]
      if (row) rows[at] = { ...row, state: 'interrupted' }
    }
  }
  return rows
}

/** "0.4s", "12s", "1:05": sub-second calls are the norm, so whole-second m:ss would read 0:00. */
export function duration(fromIso: string, toMs: number): string {
  const ms = Math.max(0, toMs - Date.parse(fromIso))
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export const ACTIVITY_STATE_LABEL: Record<ActivityState, string> = {
  running: 'Running',
  done: 'Done',
  error: 'Failed',
  interrupted: 'Interrupted',
}
