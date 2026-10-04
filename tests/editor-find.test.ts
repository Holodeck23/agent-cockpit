import { describe, expect, it } from 'vitest'
import { findIn, replaceAllIn } from '../web/src/editor-find.ts'

describe('find and replace in the editor', () => {
  it('ignores case unless asked, and finds the query exactly as typed, spaces included', () => {
    expect(findIn('Beta beta BETA', 'beta')).toHaveLength(3)
    expect(findIn('Beta beta BETA', 'beta', true)).toEqual([[5, 9]])
    expect(findIn('a b', ' b')).toEqual([[1, 3]])
    expect(findIn('abc', '')).toEqual([])
  })

  it('replaces every match at once, leaving the rest exactly as it was', () => {
    const text = 'one fish, two fish\r\nred FISH'
    expect(replaceAllIn(text, findIn(text, 'fish'), 'cat')).toBe('one cat, two cat\r\nred cat')
    expect(replaceAllIn('aaa', findIn('aaa', 'a'), 'aa')).toBe('aaaaaa')
    expect(replaceAllIn('keep', [], 'x')).toBe('keep')
  })
})
