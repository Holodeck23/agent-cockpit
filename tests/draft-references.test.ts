import { describe, expect, it } from 'vitest'
import { addReference, completeMention, fileReference, hasReference, mentionAt, referencesIn, removeReference, tokenFor } from '../web/src/draft-references.ts'

describe('references in a composer draft', () => {
  it('lists each reference once with how often it appears', () => {
    const text = 'Check @file:src%2Fa%20b.ts and @workflow:review then @file:src%2Fa%20b.ts'
    expect(referencesIn(text)).toEqual([
      { kind: 'file', reference: 'src%2Fa%20b.ts', label: 'src/a b.ts', count: 2 },
      { kind: 'workflow', reference: 'review', label: 'review', count: 1 },
    ])
    expect(referencesIn('mail me at a@file:x.ts')).toEqual([])
  })
  it('adds a reference once and removes every copy, leaving the words', () => {
    const token = tokenFor('file', fileReference('notes/plan.md'))
    expect(token).toBe('@file:notes%2Fplan.md')
    const once = addReference('Read', token)
    expect(once).toBe('Read @file:notes%2Fplan.md ')
    expect(addReference(once, token)).toBe(once)
    expect(hasReference(`${once}@file:notes%2Fplan.mdx`, token)).toBe(true)
    expect(removeReference(`${once}and ${token} now`, token)).toBe('Read and now')
    expect(removeReference('@workflow:review first', '@workflow:review')).toBe('first')
    expect(removeReference('@workflow:reviewer stays', '@workflow:review')).toBe('@workflow:reviewer stays')
  })
})

describe('typing @ in the composer', () => {
  it('finds the word being typed after an @ at the caret', () => {
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionAt('Read @src/ap', 12)).toEqual({ start: 5, query: 'src/ap' })
    expect(mentionAt('Read @src/ap now', 12)).toEqual({ start: 5, query: 'src/ap' })
    expect(mentionAt('line\n@rev', 9)).toEqual({ start: 5, query: 'rev' })
  })
  it('stays quiet for mail addresses, finished words and tokens already written', () => {
    expect(mentionAt('mail me@home', 12)).toBeUndefined()
    expect(mentionAt('Read @src now', 13)).toBeUndefined()
    expect(mentionAt('See @file:README.md', 19)).toBeUndefined()
    expect(mentionAt('Plain text', 10)).toBeUndefined()
    expect(mentionAt(`@${'x'.repeat(81)}`, 82)).toBeUndefined()
  })
  it('swaps the typed @word for the reference and puts the caret after it', () => {
    expect(completeMention('Read @rea', { start: 5, query: 'rea' }, '@file:README.md'))
      .toEqual({ text: 'Read @file:README.md ', caret: 21 })
    expect(completeMention('Read @rea and more', { start: 5, query: 'rea' }, '@workflow:review'))
      .toEqual({ text: 'Read @workflow:review and more', caret: 22 })
    expect(completeMention('@x.ts,then', { start: 0, query: 'x.ts,then' }, '@file:x.ts'))
      .toEqual({ text: '@file:x.ts ', caret: 11 })
  })
})
