// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { textRanges } from '../web/src/components/EditorFindBar.tsx'

describe('painting editor matches', () => {
  it('maps text offsets to ranges across coloured spans, including a match split between two', () => {
    const pre = document.createElement('pre')
    pre.innerHTML = '<span>const</span> total = <span>"a</span><span>b"</span>'
    const text = pre.textContent!
    const at = (word: string): [number, number] => [text.indexOf(word), text.indexOf(word) + word.length]
    const ranges = textRanges(pre, [at('const'), at('total'), at('"ab"')])
    expect(ranges.map((r) => r.toString())).toEqual(['const', 'total', '"ab"'])
  })

  it('returns nothing for no matches', () => {
    expect(textRanges(document.createElement('pre'), [])).toEqual([])
  })
})
