import { describe, expect, it } from 'vitest'
import { findRanges, snippet, stepIndex } from '../web/src/find.ts'

describe('findRanges', () => {
  it('finds every case-insensitive match, left to right, without overlaps', () => {
    expect(findRanges('Deploy to staging. deploy again', 'deploy')).toEqual([[0, 6], [19, 25]])
    expect(findRanges('aaaa', 'aa')).toEqual([[0, 2], [2, 4]])
  })

  it('ignores an empty or whitespace-only query and treats regex characters literally', () => {
    expect(findRanges('anything', '')).toEqual([])
    expect(findRanges('anything', '   ')).toEqual([])
    expect(findRanges('a.b axb', 'a.b')).toEqual([[0, 3]])
  })
})

describe('stepIndex', () => {
  it('wraps around in both directions and starts at the first match', () => {
    expect(stepIndex(-1, 3, 1)).toBe(0)
    expect(stepIndex(2, 3, 1)).toBe(0)
    expect(stepIndex(0, 3, -1)).toBe(2)
    expect(stepIndex(0, 0, 1)).toBe(-1)
  })
})

describe('find results list', () => {
  it('shows the match with some words either side', () => {
    expect(snippet('Short text with needle here', 16, 22)).toEqual({ before: 'Short text with ', match: 'needle', after: ' here' })
    const long = `${'a '.repeat(60)}needle${' b'.repeat(60)}`
    const s = snippet(long, 120, 126, 20)
    expect(s.match).toBe('needle')
    expect(s.before.startsWith('…')).toBe(true)
    expect(s.after.endsWith('…')).toBe(true)
    expect(s.before.length).toBeLessThanOrEqual(22)
  })
  it('flattens line breaks so a row stays one line', () => {
    expect(snippet('one\n\ntwo needle', 9, 15)).toEqual({ before: 'one two ', match: 'needle', after: '' })
  })
})
