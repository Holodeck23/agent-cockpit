import { z } from 'zod'

// Calendar schedules: chosen weekdays at a local wall-clock time in a named timezone.
// Daily is every day, Weekdays is Monday to Friday, Weekly is any chosen days.
//
// Clock changes, stated so nobody has to guess:
//  - a time the clocks skip (02:30 on a spring-forward night) runs that many minutes later
//    (03:30), the moment that wall time would have been;
//  - a time that happens twice (01:30 on a fall-back night) runs once, the first time.
// Missed runs are the scheduler's business (runner.ts): one late run, no backlog.

export const calendarSchema = z.object({
  /** 0 = Sunday … 6 = Saturday; at least one, no repeats. */
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7)
    .refine((days) => new Set(days).size === days.length, 'Each day once')
    .transform((days) => [...days].sort((a, b) => a - b)),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time like 09:00'),
  timeZone: z.string().min(1).max(64).refine(isTimeZone, 'Unknown timezone'),
})
export type Calendar = z.output<typeof calendarSchema>

export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** The Mac's own timezone, which new calendar schedules use. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

interface Wall { year: number; month: number; day: number; hour: number; minute: number }

const formatters = new Map<string, Intl.DateTimeFormat>()
function wallClock(instant: number, timeZone: string): Wall {
  let format = formatters.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
    formatters.set(timeZone, format)
  }
  const parts = Object.fromEntries(format.formatToParts(instant).map((p) => [p.type, p.value]))
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute) }
}

/** Milliseconds the zone is ahead of UTC at that instant. */
function offsetAt(instant: number, timeZone: string): number {
  const w = wallClock(instant, timeZone)
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - Math.floor(instant / 60_000) * 60_000
}

/** The instant a wall-clock time happens in the zone, under the clock-change rules above. */
export function instantOf(wall: Wall, timeZone: string): number {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute)
  const before = offsetAt(asUtc - 12 * 3_600_000, timeZone)
  const after = offsetAt(asUtc + 12 * 3_600_000, timeZone)
  const matches = [asUtc - before, asUtc - after].filter((t) => {
    const w = wallClock(t, timeZone)
    return w.year === wall.year && w.month === wall.month && w.day === wall.day && w.hour === wall.hour && w.minute === wall.minute
  })
  // Two matches: the time happens twice, take the first. None: it was skipped, use the old offset.
  return matches.length ? Math.min(...matches) : asUtc - before
}

/** The first run strictly after `after`. */
export function nextCalendarRun(calendar: Calendar, after: number): number {
  const [hour, minute] = calendar.time.split(':').map(Number) as [number, number]
  const today = wallClock(after, calendar.timeZone)
  for (let i = 0; i <= 8; i++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + i))
    if (!calendar.days.includes(date.getUTCDay())) continue
    const at = instantOf({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour, minute }, calendar.timeZone)
    if (at > after) return at
  }
  throw new Error('No upcoming run for this schedule')
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAYS = [1, 2, 3, 4, 5]

/** "Daily at 09:00", "Weekdays at 08:30", "Mon, Thu at 17:00". */
export function describeCalendar(calendar: Pick<Calendar, 'days' | 'time'>): string {
  const days = [...calendar.days].sort((a, b) => a - b)
  const which = days.length === 7 ? 'Daily' : days.join() === WEEKDAYS.join() ? 'Weekdays' : days.map((d) => DAY_NAMES[d]).join(', ')
  return `${which} at ${calendar.time}`
}
