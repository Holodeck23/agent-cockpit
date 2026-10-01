import type { Workflow, WorkflowInput } from './api.ts'

// The workflow editor's Repeat choice, and how it maps to what the server stores:
// a minute interval, or a calendar rule (days + local time + timezone), never both.

export type RepeatKind = 'never' | 'interval' | 'daily' | 'weekdays' | 'weekly'
export interface RepeatChoice {
  readonly kind: RepeatKind
  readonly minutes: string
  readonly time: string
  /** Weekly only: 0 = Sunday … 6 = Saturday. */
  readonly days: readonly number[]
  readonly timeZone: string
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]
const WEEKDAYS = [1, 2, 3, 4, 5]

export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

export function repeatFrom(workflow: Pick<Workflow, 'intervalMinutes' | 'calendar'> | undefined, zone = localZone()): RepeatChoice {
  const base: RepeatChoice = { kind: 'never', minutes: '', time: '09:00', days: [1], timeZone: zone }
  if (workflow?.intervalMinutes) return { ...base, kind: 'interval', minutes: String(workflow.intervalMinutes) }
  const calendar = workflow?.calendar
  if (!calendar) return base
  const days = [...calendar.days].sort((a, b) => a - b)
  const kind: RepeatKind = days.join() === ALL_DAYS.join() ? 'daily' : days.join() === WEEKDAYS.join() ? 'weekdays' : 'weekly'
  return { ...base, kind, time: calendar.time, days, timeZone: calendar.timeZone }
}

export function repeatInput(choice: RepeatChoice): Pick<WorkflowInput, 'intervalMinutes' | 'calendar'> {
  switch (choice.kind) {
    case 'never': return { intervalMinutes: null, calendar: null }
    case 'interval': return { intervalMinutes: choice.minutes ? Number(choice.minutes) : null, calendar: null }
    case 'daily': return { intervalMinutes: null, calendar: { days: ALL_DAYS, time: choice.time, timeZone: choice.timeZone } }
    case 'weekdays': return { intervalMinutes: null, calendar: { days: WEEKDAYS, time: choice.time, timeZone: choice.timeZone } }
    case 'weekly': return { intervalMinutes: null, calendar: { days: [...choice.days], time: choice.time, timeZone: choice.timeZone } }
  }
}

/** Whether "Save and enable schedule" makes sense. */
export function canSchedule(choice: RepeatChoice): boolean {
  if (choice.kind === 'never') return false
  if (choice.kind === 'interval') return Number(choice.minutes) >= 5
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(choice.time)) return false
  return choice.kind !== 'weekly' || choice.days.length > 0
}
