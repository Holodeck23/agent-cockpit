// Plain-words usage lines for the agent picker and the conversation menu. Only what the
// provider reported is shown; a reset that has already passed is said to have passed.
import type { NormalizedEvent } from '../../server/agents/types.ts'

type Usage = Pick<Extract<NormalizedEvent, { kind: 'usage' }>, 'status' | 'resetsAt' | 'usedPercent' | 'limitType'>

const STATUS_LABEL: Record<string, string> = {
  allowed: 'Within your limit',
  allowed_warning: 'Getting close to your limit',
  rejected: 'Limit reached',
}

// last_turn: Antigravity's token counts for its latest turn (it reports no limit).
const WINDOW_LABEL: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly', last_turn: 'Last turn' }

export function windowLabel(limitType: string): string {
  return WINDOW_LABEL[limitType] ?? limitType.replace(/_/g, ' ')
}

export function statusLabel(usage: Usage): string {
  if (usage.usedPercent !== undefined && usage.status !== 'rejected') return `${usage.usedPercent}% used`
  return STATUS_LABEL[usage.status] ?? usage.status
}

const sameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString()

/** "3:05 PM" today, "tomorrow 1:00 AM", else "Fri, Oct 2, 1:00 AM": never a bare time for another day. */
export function formatWhen(epochMs: number, nowMs: number = Date.now()): string {
  const when = new Date(epochMs)
  const now = new Date(nowMs)
  const time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (sameDay(when, now)) return time
  const tomorrow = new Date(nowMs)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (sameDay(when, tomorrow)) return `tomorrow ${time}`
  return `${when.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`
}

/** "resets 7:35 PM" or "reset at 1:00 PM; no newer report" once that time has passed. */
export function resetLabel(resetsAt: number | undefined, nowMs: number = Date.now()): string | undefined {
  if (resetsAt === undefined) return undefined
  const ms = resetsAt * 1000
  return ms > nowMs ? `resets ${formatWhen(ms, nowMs)}` : `reset at ${formatWhen(ms, nowMs)}; no newer report`
}

export function usageLine(usage: Usage, nowMs: number = Date.now()): string {
  const reset = resetLabel(usage.resetsAt, nowMs)
  return `${windowLabel(usage.limitType)} usage: ${statusLabel(usage)}${reset ? `, ${reset}` : ''}`
}
