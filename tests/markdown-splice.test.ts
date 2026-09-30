import { describe, expect, it } from 'vitest'
import { matchBlocks, spliceMarkdown } from '../web/src/markdown/splice.ts'

// Blocks here are just their text; "serialise" marks what was rewritten.
const source = '# Title\n\n* one\n* two\n\n| a |b|\n|-|-|\n\n<!-- keep -->\n'
const ranges = [{ start: 0, end: 7 }, { start: 9, end: 20 }, { start: 22, end: 36 }, { start: 38, end: 51 }]
const original = ranges.map((r) => source.slice(r.start, r.end))
const splice = (current: string[]) => spliceMarkdown({ source, ranges, original, current, same: (a, b) => a === b, serialize: (b) => `${b}\n` })

describe('splicing edited Markdown', () => {
  it('writes an unchanged document back byte for byte', () => {
    expect(splice(original)).toBe(source)
  })
  it('rewrites only the edited block and keeps the others and their spacing', () => {
    expect(splice([original[0]!, '* one\n* three', original[2]!, original[3]!])).toBe('# Title\n\n* one\n* three\n\n| a |b|\n|-|-|\n\n<!-- keep -->\n')
  })
  it('keeps neighbours when a block is inserted or deleted', () => {
    expect(splice([original[0]!, 'New paragraph', ...original.slice(1)])).toBe('# Title\n\nNew paragraph\n\n* one\n* two\n\n| a |b|\n|-|-|\n\n<!-- keep -->\n')
    expect(splice([original[0]!, original[2]!, original[3]!])).toBe('# Title\n\n| a |b|\n|-|-|\n\n<!-- keep -->\n')
  })
  it('keeps leading text and ends a changed last block with one newline', () => {
    const lead = spliceMarkdown({ source: '\n\nA\n', ranges: [{ start: 2, end: 3 }], original: ['A'], current: ['A', 'B'], same: (a, b) => a === b, serialize: (b) => b })
    expect(lead).toBe('\n\nA\n\nB\n')
  })
  it('matches unchanged blocks as a longest common subsequence', () => {
    expect([...matchBlocks(['a', 'b', 'c'], ['a', 'x', 'c'], (p, q) => p === q)]).toEqual([[0, 0], [2, 2]])
  })
})

describe('spacing around an edited block', () => {
  it('keeps the indentation and gaps of the block it replaces and of its neighbours', () => {
    const src = '\n  # T\n\n  Para one.\n\n  ## Next\n'
    const r = [{ start: 3, end: 6 }, { start: 10, end: 19 }, { start: 23, end: 30 }]
    const orig = r.map((x) => src.slice(x.start, x.end))
    const out = spliceMarkdown({ source: src, ranges: r, original: orig, current: [orig[0]!, 'Para one, edited.', orig[2]!], same: (a, b) => a === b, serialize: (b) => b })
    expect(out).toBe('\n  # T\n\n  Para one, edited.\n\n  ## Next\n')
  })
})
