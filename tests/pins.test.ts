import { describe, expect, it } from 'vitest'
import { dropPin, renamePin, togglePin } from '../web/src/pins.ts'

describe('pinned project files', () => {
  it('pin at the end, unpin in place, follow a rename and drop a trashed file', () => {
    expect(togglePin(['a.ts'], 'b.ts')).toEqual(['a.ts', 'b.ts'])
    expect(togglePin(['a.ts', 'b.ts', 'c.ts'], 'b.ts')).toEqual(['a.ts', 'c.ts'])
    expect(renamePin(['a.ts', 'b.ts'], 'a.ts', 'z.ts')).toEqual(['z.ts', 'b.ts'])
    expect(dropPin(['a.ts', 'b.ts'], 'a.ts')).toEqual(['b.ts'])
    expect(dropPin(['a.ts'], 'missing')).toEqual(['a.ts'])
  })
})
