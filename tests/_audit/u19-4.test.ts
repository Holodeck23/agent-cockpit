import { describe, expect, it } from 'vitest'
import { findRanges } from '../../web/src/find.ts'

// u19-4: findRanges lowercases the whole text and indexes into it, but toLowerCase() changes the
// length for a few characters (U+0130 becomes two UTF-16 units). FindBar applies the offsets to the
// ORIGINAL text node, so a match could end past node.length (Range.setEnd throws) or highlight the
// wrong characters. Every returned range must lie inside the text and cover the match.

describe('findRanges when lower-casing changes the text length', () => {
  const text = 'İstanbul is big'

  it('never returns a range past the end of the text', () => {
    expect(text.toLowerCase().length).not.toBe(text.length)
    for (const query of ['g', 'big', 'is big', 'stanbul', 'b']) {
      for (const [start, end] of findRanges(text, query)) {
        expect(start).toBeGreaterThanOrEqual(0)
        expect(end).toBeLessThanOrEqual(text.length)
      }
    }
  })

  it('points at the characters that were searched for', () => {
    expect(findRanges(text, 'g')).toEqual([[14, 15]])
    expect(findRanges(text, 'big')).toEqual([[12, 15]])
    for (const [start, end] of findRanges(text, 'is')) expect(text.slice(start, end)).toBe('is')
  })

  it('still ignores case when the length is stable', () => {
    expect(findRanges('Deploy to staging. DEPLOY again', 'deploy')).toEqual([[0, 6], [19, 25]])
  })
})
