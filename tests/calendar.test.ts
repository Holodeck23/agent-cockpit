import { describe, expect, it } from 'vitest'
import { calendarSchema, describeCalendar, nextCalendarRun } from '../server/workflows/calendar.ts'

const VIENNA = 'Europe/Vienna'
const at = (iso: string): number => Date.parse(iso)
const iso = (ms: number): string => new Date(ms).toISOString()
const cal = (days: number[], time: string, timeZone = VIENNA) => calendarSchema.parse({ days, time, timeZone })

describe('calendar schedules', () => {
  it('runs later today, or on the next allowed day', () => {
    const daily = cal([0, 1, 2, 3, 4, 5, 6], '09:00')
    // Wednesday 1 Oct 2026, 07:00 UTC = 09:00 Vienna (CEST, UTC+2)
    expect(iso(nextCalendarRun(daily, at('2026-10-01T06:00:00Z')))).toBe('2026-10-01T07:00:00.000Z')
    expect(iso(nextCalendarRun(daily, at('2026-10-01T07:00:00Z')))).toBe('2026-10-02T07:00:00.000Z')
    const weekdays = cal([1, 2, 3, 4, 5], '09:00')
    // Friday 2 Oct after 09:00 → Monday 5 Oct
    expect(iso(nextCalendarRun(weekdays, at('2026-10-02T08:00:00Z')))).toBe('2026-10-05T07:00:00.000Z')
    const sundays = cal([0], '18:30')
    expect(iso(nextCalendarRun(sundays, at('2026-10-01T00:00:00Z')))).toBe('2026-10-04T16:30:00.000Z')
  })

  it('keeps the local time across a clock change', () => {
    const daily = cal([0, 1, 2, 3, 4, 5, 6], '09:00')
    // Vienna leaves summer time on Sunday 25 Oct 2026: 09:00 is 07:00 UTC before, 08:00 UTC after.
    expect(iso(nextCalendarRun(daily, at('2026-10-24T08:00:00Z')))).toBe('2026-10-25T08:00:00.000Z')
  })

  it('runs a skipped time once, shifted by the jump', () => {
    // Spring forward on 29 Mar 2026: 02:00 → 03:00 in Vienna, so 02:30 never happens.
    const nightly = cal([0, 1, 2, 3, 4, 5, 6], '02:30')
    expect(iso(nextCalendarRun(nightly, at('2026-03-28T12:00:00Z')))).toBe('2026-03-29T01:30:00.000Z') // 03:30 CEST
  })

  it('runs a repeated time once, the first time', () => {
    // Fall back on 25 Oct 2026: 03:00 → 02:00, so 02:30 happens at 00:30 UTC and again at 01:30 UTC.
    const nightly = cal([0, 1, 2, 3, 4, 5, 6], '02:30')
    const first = nextCalendarRun(nightly, at('2026-10-24T12:00:00Z'))
    expect(iso(first)).toBe('2026-10-25T00:30:00.000Z')
    expect(iso(nextCalendarRun(nightly, first))).toBe('2026-10-26T01:30:00.000Z')
  })

  it('works in a zone without clock changes and one far from UTC', () => {
    expect(iso(nextCalendarRun(cal([1], '09:00', 'Asia/Kolkata'), at('2026-10-01T00:00:00Z')))).toBe('2026-10-05T03:30:00.000Z')
    expect(iso(nextCalendarRun(cal([4], '23:45', 'Pacific/Auckland'), at('2026-10-01T00:00:00Z')))).toBe('2026-10-01T10:45:00.000Z')
  })

  it('validates and describes', () => {
    expect(() => cal([], '09:00')).toThrow()
    expect(() => cal([1, 1], '09:00')).toThrow()
    expect(() => cal([1], '24:00')).toThrow()
    expect(() => cal([1], '09:00', 'Mars/Olympus')).toThrow()
    expect(cal([5, 1], '09:00').days).toEqual([1, 5])
    expect(describeCalendar(cal([0, 1, 2, 3, 4, 5, 6], '09:00'))).toBe('Daily at 09:00')
    expect(describeCalendar(cal([5, 4, 3, 2, 1], '08:30'))).toBe('Weekdays at 08:30')
    expect(describeCalendar(cal([4, 1], '17:00'))).toBe('Mon, Thu at 17:00')
  })
})
