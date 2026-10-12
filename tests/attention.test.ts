import { describe, expect, it, vi } from 'vitest'
import { requestNativeAttention } from '../electron/attention.ts'

describe('native waiting-on-you attention', () => {
  it('bounces the Dock and flashes a live window for every fresh decision', () => {
    const bounce = vi.fn()
    const flashFrame = vi.fn()
    requestNativeAttention({ bounce }, { isDestroyed: () => false, flashFrame })
    expect(bounce).toHaveBeenCalledWith('critical')
    expect(flashFrame).toHaveBeenCalledWith(true)
  })

  it('does not touch a destroyed window', () => {
    const flashFrame = vi.fn()
    requestNativeAttention(undefined, { isDestroyed: () => true, flashFrame })
    expect(flashFrame).not.toHaveBeenCalled()
  })
})
