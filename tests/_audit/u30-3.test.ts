import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ReplyMarkdown } from '../../web/src/markdown/reply.tsx'

// u30-3: textOf() only joined strings, numbers and arrays, so a link whose text had any formatting
// ([**github.com/you**](https://evil.example/login)) read as '' and never got the real-host marker
// that the same words as plain text do.
// CORRECT behaviour: the words a reader sees decide the warning, formatted or not.

const html = (text: string): string => renderToStaticMarkup(createElement(ReplyMarkdown, { text }))

describe('the misleading-link warning', () => {
  it('still shows for plain text (control)', () => {
    expect(html('[github.com/you](https://evil.example/login)')).toContain('<span class="link-real-host"> ↗ evil.example</span>')
  })
  for (const [name, text] of [
    ['bold', '[**github.com/you**](https://evil.example/login)'],
    ['italic', '[_github.com/you_](https://evil.example/login)'],
    ['inline code', '[`github.com/you`](https://evil.example/login)'],
    ['formatting around part of the name', '[github.**com**/you](https://evil.example/login)'],
    ['nested', '[**_github.com/you_**](https://evil.example/login)'],
  ] as const) {
    it(`shows for ${name}`, () => {
      expect(html(text)).toContain('<span class="link-real-host"> ↗ evil.example</span>')
    })
  }
  it('stays quiet when formatted text names the same site or none', () => {
    const out = html('[**github.com**](https://github.com/x) [**docs**](https://evil.example/)')
    expect(out).not.toContain('link-real-host')
  })
})
