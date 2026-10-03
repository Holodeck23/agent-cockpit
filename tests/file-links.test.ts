import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { lineRange } from '../web/src/file-text.ts'
import { fileLink } from '../web/src/markdown/file-links.ts'
import { ReplyContext, ReplyMarkdown } from '../web/src/markdown/reply.tsx'

const PROJECT = '/work/app'
const html = (text: string): string => renderToStaticMarkup(
  createElement(ReplyContext.Provider, { value: { projectPath: PROJECT, onOpenFile: () => {} } }, createElement(ReplyMarkdown, { text })))

describe('file references in replies', () => {
  it('reads path, line and range in the forms agents write', () => {
    expect(fileLink('src/app.ts:42', PROJECT)).toEqual({ path: 'src/app.ts', line: 42 })
    expect(fileLink('src/app.ts:10-20', PROJECT)).toEqual({ path: 'src/app.ts', line: 10, endLine: 20 })
    expect(fileLink('src/app.ts:42:7', PROJECT)).toEqual({ path: 'src/app.ts', line: 42 })
    expect(fileLink('src/app.ts#L42', PROJECT)).toEqual({ path: 'src/app.ts', line: 42 })
    expect(fileLink('src/app.ts#L10-L20', PROJECT)).toEqual({ path: 'src/app.ts', line: 10, endLine: 20 })
    expect(fileLink('./README.md', PROJECT)).toEqual({ path: 'README.md' })
    expect(fileLink('/work/app/server/x.ts:3', PROJECT)).toEqual({ path: 'server/x.ts', line: 3 })
  })
  it('leaves alone what is not a file in this project', () => {
    for (const raw of ['/etc/passwd', '/work/apple/x.ts', '../outside.ts', 'src/../../x.ts', 'https://a.example/x.ts', 'v1.2', 'e.g.', 'Makefile', 'src/app.ts:0', 'a b.ts', '']) {
      expect(fileLink(raw, PROJECT), raw).toBeUndefined()
    }
    expect(fileLink('src/app.ts:12', undefined)).toBeUndefined()
  })
  it('links a code span, a relative Markdown link and path:line in prose', () => {
    const out = html('See `src/app.ts:42`, [the parser](server/parse.ts#L7) and web/main.tsx:3 here, but not 1.5 or `npm test`.')
    expect(out).toContain('data-path="src/app.ts" data-line="42"')
    expect(out).toContain('data-path="server/parse.ts" data-line="7"')
    expect(out).toContain('data-path="web/main.tsx" data-line="3"')
    expect(out.match(/data-path=/g)).toHaveLength(3)
    expect(out).toContain('<code>npm test</code>')
  })
  it('keeps prose paths without a line, and paths inside code blocks, as plain text', () => {
    const out = html('Edit README.md first.\n\n```\nsrc/app.ts:42\n```')
    expect(out).not.toContain('data-path')
  })
  it('without a project, nothing becomes a file link', () => {
    expect(renderToStaticMarkup(createElement(ReplyMarkdown, { text: 'See `src/app.ts:42`' }))).not.toContain('data-path')
  })
})

describe('jumping to lines', () => {
  const text = 'one\ntwo\nthree\nfour'
  it('selects the whole line or range', () => {
    expect(lineRange(text, 2)).toEqual({ start: 4, end: 7 })
    expect(lineRange(text, 2, 3)).toEqual({ start: 4, end: 13 })
    expect(lineRange(text, 4)).toEqual({ start: 14, end: 18 })
  })
  it('clamps past the end of the file', () => {
    expect(lineRange(text, 99)).toEqual({ start: 14, end: 18 })
    expect(lineRange(text, 3, 99)).toEqual({ start: 8, end: 18 })
  })
})
