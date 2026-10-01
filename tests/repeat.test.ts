import { describe, expect, it } from 'vitest'
import { canSchedule, repeatFrom, repeatInput } from '../web/src/repeat.ts'

describe('repeat choice', () => {
  it('reads stored schedules back into the picker', () => {
    expect(repeatFrom(undefined, 'Europe/Vienna')).toMatchObject({ kind: 'never', timeZone: 'Europe/Vienna' })
    expect(repeatFrom({ intervalMinutes: 30, calendar: null })).toMatchObject({ kind: 'interval', minutes: '30' })
    const cal = (days: number[]) => ({ intervalMinutes: null, calendar: { days, time: '08:15', timeZone: 'Asia/Tokyo' } })
    expect(repeatFrom(cal([0, 1, 2, 3, 4, 5, 6]))).toMatchObject({ kind: 'daily', time: '08:15', timeZone: 'Asia/Tokyo' })
    expect(repeatFrom(cal([5, 4, 3, 2, 1]))).toMatchObject({ kind: 'weekdays' })
    expect(repeatFrom(cal([6, 0]))).toMatchObject({ kind: 'weekly', days: [0, 6] })
  })

  it('writes exactly one kind of schedule', () => {
    const base = repeatFrom(undefined, 'Europe/Vienna')
    expect(repeatInput(base)).toEqual({ intervalMinutes: null, calendar: null })
    expect(repeatInput({ ...base, kind: 'interval', minutes: '45' })).toEqual({ intervalMinutes: 45, calendar: null })
    expect(repeatInput({ ...base, kind: 'weekdays', time: '07:00' })).toEqual({ intervalMinutes: null,
      calendar: { days: [1, 2, 3, 4, 5], time: '07:00', timeZone: 'Europe/Vienna' } })
    expect(repeatInput({ ...base, kind: 'weekly', days: [3], time: '18:00' }).calendar?.days).toEqual([3])
  })

  it('only offers to schedule a complete choice', () => {
    const base = repeatFrom(undefined, 'UTC')
    expect(canSchedule(base)).toBe(false)
    expect(canSchedule({ ...base, kind: 'interval', minutes: '4' })).toBe(false)
    expect(canSchedule({ ...base, kind: 'interval', minutes: '5' })).toBe(true)
    expect(canSchedule({ ...base, kind: 'daily', time: '' })).toBe(false)
    expect(canSchedule({ ...base, kind: 'weekly', days: [] })).toBe(false)
    expect(canSchedule({ ...base, kind: 'weekly', days: [2] })).toBe(true)
  })
})
