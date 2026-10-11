import { describe, expect, it } from 'vitest'
import { addReference, hasReference, referencesIn, removeReference, tokenFor } from '../../web/src/draft-references.ts'

// u22-3: referencesIn() draws a chip for every reference the server will attach. @workflow: names
// have no trailing boundary ("Use @workflow:review." gives a "review" chip), and the chip's x calls
// removeReference(). removeReference/hasReference demanded whitespace or end of text after the
// token, so a chip for a workflow followed by punctuation could not be removed; and each match ate
// its leading space, so of two adjacent copies only the first went.
// CORRECT behaviour: removal matches exactly what referencesIn matched, and removes every copy.

describe('u22-3: a chip can always be removed', () => {
  it('removes a workflow reference that is followed by punctuation, keeping the punctuation', () => {
    const text = 'Please run @workflow:daily-review, then summarise.'
    expect(referencesIn(text).map((r) => r.reference)).toEqual(['daily-review'])
    const after = removeReference(text, '@workflow:daily-review')
    expect(referencesIn(after)).toEqual([])
    expect(after).toBe('Please run , then summarise.')
    expect(removeReference('Use @workflow:review.', '@workflow:review')).toBe('Use .')
  })

  it('leaves a longer workflow name that merely starts with the token', () => {
    expect(removeReference('@workflow:reviewer. @workflow:review-extra.', '@workflow:review')).toBe('@workflow:reviewer. @workflow:review-extra.')
    expect(hasReference('Use @workflow:reviewer.', '@workflow:review')).toBe(false)
    expect(hasReference('Use @workflow:review-extra.', '@workflow:review')).toBe(false)
  })

  it('knows a punctuated workflow reference is already in the draft, so adding it again changes nothing', () => {
    const text = 'Use @workflow:review.'
    expect(hasReference(text, '@workflow:review')).toBe(true)
    expect(addReference(text, '@workflow:review')).toBe(text)
  })

  it('removes every copy when they sit next to each other', () => {
    expect(removeReference('a @file:x @file:x b', '@file:x')).toBe('a b')
    expect(removeReference('a @file:x @file:x @file:x b', '@file:x')).toBe('a b')
    expect(removeReference('@file:x @file:x', '@file:x')).toBe('')
    expect(removeReference('a @workflow:w @workflow:w, b', '@workflow:w')).toBe('a , b')
  })

  it('keeps the indentation of the draft\'s first line', () => {
    expect(removeReference('    indented @file:x tail', '@file:x')).toBe('    indented tail')
    expect(removeReference('\tcode\n@file:x\nnext', '@file:x')).toBe('\tcode\n\nnext')
  })

  it('still keeps a file token that only starts with the removed one', () => {
    expect(removeReference('@file:x.ts and @file:x', '@file:x')).toBe('@file:x.ts and ')
    expect(removeReference('@file:x#L3 stays', '@file:x')).toBe('@file:x#L3 stays')
  })

  it('every chip referencesIn shows can be removed again', () => {
    const drafts = [
      'Please run @workflow:daily-review, then summarise.',
      'Use @workflow:review. Then @file:src%2Fa.ts, and @file:src%2Fa.ts.',
      '(@workflow:ship) and "@workflow:ship"',
      '@file:a.md @file:a.md @workflow:z; @workflow:z',
      'x @file:notes%2Fplan.md#L3-L7 @file:notes%2Fplan.md#L3-L7 y',
    ]
    for (const draft of drafts) {
      for (const r of referencesIn(draft)) {
        const after = removeReference(draft, tokenFor(r.kind, r.reference))
        expect(referencesIn(after).filter((x) => x.kind === r.kind && x.reference === r.reference), `${draft} -> ${after}`).toEqual([])
      }
    }
  })
})
