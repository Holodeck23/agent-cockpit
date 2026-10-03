import { describe, expect, it } from 'vitest'
import { nearBottom } from '../web/src/useStickToBottom.ts'

describe('nearBottom', () => {
  it('counts a reader within the slack of the end as at the bottom', () => {
    expect(nearBottom({ scrollTop: 600, clientHeight: 400, scrollHeight: 1000 })).toBe(true)
    expect(nearBottom({ scrollTop: 570, clientHeight: 400, scrollHeight: 1000 })).toBe(true)
  })

  it('a reader who scrolled up is not at the bottom', () => {
    expect(nearBottom({ scrollTop: 300, clientHeight: 400, scrollHeight: 1000 })).toBe(false)
  })

  it('content shorter than the view is always at the bottom', () => {
    expect(nearBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 300 })).toBe(true)
  })
})
