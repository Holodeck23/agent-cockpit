import { describe, expect, it } from 'vitest'
import { updateNotice } from '../web/src/update-notice.ts'

describe('"Updated to" notice', () => {
  it('appears once after the version goes up', () => {
    expect(updateNotice('0.1.4', '0.1.5')).toBe('Updated to Cockpit 0.1.5')
    expect(updateNotice('0.1.9', '0.1.10')).toBe('Updated to Cockpit 0.1.10')
  })
  it('stays away on a first launch, the same version, a downgrade or a garbled record', () => {
    expect(updateNotice(undefined, '0.1.5')).toBeUndefined()
    expect(updateNotice('0.1.5', '0.1.5')).toBeUndefined()
    expect(updateNotice('0.1.6', '0.1.5')).toBeUndefined()
    expect(updateNotice('nonsense', '0.1.5')).toBeUndefined()
  })
})
