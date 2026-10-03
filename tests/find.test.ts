import { describe, expect, it } from 'vitest'
import { findRanges, stepIndex } from '../web/src/find.ts'

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
