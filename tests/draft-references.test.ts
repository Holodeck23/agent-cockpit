import { describe, expect, it } from 'vitest'
import { addReference, fileReference, hasReference, referencesIn, removeReference, tokenFor } from '../web/src/draft-references.ts'

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
