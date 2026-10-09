import { describe, expect, it } from 'vitest'
import { CONTRACT, LAMPS, LEFT_END, RIGHT_END, STEP, TAIL, levels } from '../web/src/scanner-model.ts'

const head = (v: readonly number[]): number => v.indexOf(Math.max(...v))
const litCount = (v: readonly number[]): number => v.filter((x) => x >= 0.05).length

describe('D12 scanner model', () => {
  it('moves the head one lamp per step, both ways', () => {
    // (The end lamp burns at 1.0 against the head's 0.9, so it outshines the next lamp for one step after a reversal.)
    for (let i = 0; i < LAMPS; i++) {
      if (i !== 1) expect(head(levels(i * STEP + 0.01))).toBe(i)
      if (i !== LAMPS - 2) expect(head(levels(LEFT_END - i * STEP + 0.01))).toBe(i)
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
  it('has a tail that fits the decay', () => {
    expect(TAIL).toBeGreaterThan(10)
    expect(TAIL * STEP).toBeLessThan(12.5)
  })
})
