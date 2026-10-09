import { describe, expect, it } from 'vitest'
import { CONTRACT, CORE_DECAY, DECAY, LAMPS, LEFT_END, RIGHT_END, STEP, TAIL, coreLevels, levels } from '../web/src/scanner-model.ts'

const head = (v: readonly number[]): number => v.indexOf(Math.max(...v))
const litCount = (v: readonly number[]): number => v.filter((x) => x >= 0.05).length

describe('D12 scanner model', () => {
  it('moves the head (its core) one lamp per step, both ways', () => {
    for (let i = 0; i < LAMPS; i++) {
      expect(head(coreLevels(i * STEP + 0.01))).toBe(i)
      expect(head(coreLevels(LEFT_END - i * STEP + 0.01))).toBe(i)
    }
  })
  it('puts the tail behind the head', () => {
    const right = levels(20)
    const h = head(right)
    expect(litCount(right.slice(h + 1))).toBeLessThanOrEqual(2) // only the 40 ms lead-in of the next lamps
    expect(litCount(right.slice(0, h))).toBeGreaterThanOrEqual(10)
    const left = levels(70)
    expect(litCount(left.slice(0, head(left)))).toBeLessThanOrEqual(2)
  })
  it('draws the tail into the end lamp at each end, then grows it again', () => {
    const steps = (from: number) => [0, 1, 2, 3, 4].map((k) => litCount(levels(from + (k * CONTRACT) / 5)))
    for (const end of [RIGHT_END, LEFT_END]) {
      const inward = steps(end)
      expect(inward.every((v, i) => i === 0 || v < inward[i - 1]!)).toBe(true)
      expect(litCount(levels(end + CONTRACT + 0.01))).toBeLessThanOrEqual(2) // the end lamp, and the next one handing over
      expect(litCount(levels(end + CONTRACT + 3))).toBeGreaterThan(litCount(levels(end + CONTRACT + 0.5)))
    }
  })
  it('has a glowing core at the head, short beside the streak', () => {
    const core = coreLevels(20)
    expect(Math.max(...core)).toBeGreaterThan(0.95)
    expect(core.indexOf(Math.max(...core))).toBe(32)
    expect(core.filter((v) => v >= 0.1).length).toBeLessThanOrEqual(10)
    expect(CORE_DECAY).toBeLessThan(DECAY / 2)
    expect(Math.max(...levels(20))).toBeLessThanOrEqual(0.6)
  })
  it('has a tail that fits the decay', () => {
    expect(TAIL).toBeGreaterThan(15)
    expect(TAIL * STEP).toBeLessThan(DECAY)
  })
})
