import { describe, expect, it } from 'vitest'
import { oneAtATime, withinTime } from '../electron/one-at-a-time.ts'

describe('preview captures one at a time, each within a time limit', () => {
  it('runs calls in order and never two at once', async () => {
    let active = 0
    let most = 0
    const order: number[] = []
    const run = oneAtATime(async (n: number) => {
      active++; most = Math.max(most, active)
      await new Promise((r) => setTimeout(r, 10))
      order.push(n); active--
      return n
    })
    expect(await Promise.all([run(1), run(2), run(3)])).toEqual([1, 2, 3])
    expect(order).toEqual([1, 2, 3])
    expect(most).toBe(1)
  })

  it('lets the next capture run after one that never finishes loading', async () => {
    let stopped = false
    const capture = oneAtATime((hang: boolean) =>
      withinTime(hang ? new Promise<string>(() => undefined) : Promise.resolve('shot'), 50, 'did not load in time', () => { stopped = true }))
    const hung = capture(true)
    const next = capture(false)
    await expect(hung).rejects.toThrow('did not load in time')
    expect(stopped).toBe(true)
    await expect(next).resolves.toBe('shot')
  })

  it('passes a failure through, and a late rejection after the limit is not unhandled', async () => {
    await expect(withinTime(Promise.reject(new Error('refused')), 50, 'late')).rejects.toThrow('refused')
    const late = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('after')), 80))
    await expect(withinTime(late, 20, 'too slow')).rejects.toThrow('too slow')
    await new Promise((r) => setTimeout(r, 100))
  })
})
