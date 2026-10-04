import { describe, expect, it } from 'vitest'
import { highlight, languageFor, MAX_HIGHLIGHT_CHARS } from '../web/src/syntax.ts'

describe('code editor syntax colours', () => {
  it('picks a language from the file name, and none for plain text', () => {
    expect(languageFor('src/app.tsx')).toBe('typescript')
    expect(languageFor('package.json')).toBe('json')
    expect(languageFor('docs/README.md')).toBe('markdown')
    expect(languageFor('Makefile')).toBe('makefile')
    expect(languageFor('notes.txt')).toBeUndefined()
    expect(languageFor('.env')).toBeUndefined()
  })

  it('returns runs whose text is exactly the input, with classes on the tokens', () => {
    const source = 'const a = "<b>hi</b>" // note\n'
    const runs = highlight(source, 'typescript')
    expect(runs.map((r) => r.text).join('')).toBe(source)
    expect(runs.find((r) => r.text === 'const')?.className).toContain('hljs-keyword')
    expect(runs.find((r) => r.text.includes('<b>'))?.className).toContain('hljs-string')
    expect(runs.find((r) => r.text.includes('// note'))?.className).toContain('hljs-comment')
  })

  it('leaves huge files and unknown languages as one plain run', () => {
    const big = 'x'.repeat(MAX_HIGHLIGHT_CHARS + 1)
    expect(highlight(big, 'typescript')).toEqual([{ text: big }])
    expect(highlight('abc', 'no-such-language')).toEqual([{ text: 'abc' }])
  })
})
