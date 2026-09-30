import { describe, expect, it } from 'vitest'
import { formatWhen, resetLabel, statusLabel, usageLine } from '../web/src/usage.ts'

const now = new Date(2026, 8, 30, 15, 0).getTime()
const at = (day: number, hour: number, minute = 0): number => new Date(2026, 8, day, hour, minute).getTime()
const time = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

describe('formatWhen', () => {
  it('names the day whenever it is not today', () => {
    expect(formatWhen(at(30, 19, 35), now)).toBe(time(at(30, 19, 35)))
    expect(formatWhen(at(31, 1), now)).toBe(`tomorrow ${time(at(31, 1))}`)
    expect(formatWhen(at(33, 1), now)).toMatch(new RegExp(`, ${time(at(33, 1))}$`))
    expect(formatWhen(at(33, 1), now)).not.toBe(time(at(33, 1)))
  })
})

describe('usage wording', () => {
  it('prefers a reported percentage, but a rejection always reads as the limit', () => {
    expect(statusLabel({ limitType: 'five_hour', status: 'allowed', usedPercent: 24 })).toBe('24% used')
    expect(statusLabel({ limitType: 'five_hour', status: 'rejected', usedPercent: 100 })).toBe('Limit reached')
    expect(statusLabel({ limitType: 'five_hour', status: 'allowed' })).toBe('Within your limit')
    expect(statusLabel({ limitType: 'five_hour', status: 'surprising' })).toBe('surprising')
  })

  it('says when a reset has already passed instead of implying the limit still holds', () => {
    expect(resetLabel(at(30, 13) / 1000, now)).toBe(`reset at ${time(at(30, 13))}; no newer report`)
    expect(resetLabel(undefined, now)).toBeUndefined()
    expect(usageLine({ limitType: 'five_hour', status: 'rejected', resetsAt: at(30, 17) / 1000 }, now))
      .toBe(`5-hour usage: Limit reached, resets ${time(at(30, 17))}`)
  })
})
