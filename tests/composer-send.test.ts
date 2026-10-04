import { describe, expect, it } from 'vitest'
import { draftAfterSend } from '../web/src/components/Composer.tsx'

describe('draftAfterSend', () => {
  it('clears the box once the sent text has gone', () => {
    expect(draftAfterSend('keep me ', 'keep me')).toBe('')
  })
  it('keeps what you typed while the message was still sending', () => {
    expect(draftAfterSend('take me back', 'keep me')).toBe('take me back')
  })
})
