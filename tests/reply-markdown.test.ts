import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ReplyMarkdown, safeUrl } from '../web/src/markdown/reply.tsx'

const html = (text: string): string => renderToStaticMarkup(createElement(ReplyMarkdown, { text }))

describe('agent replies as Markdown', () => {
  it('renders headings, lists, emphasis, code and tables', () => {
    const out = html('## Plan\n\n- **one**\n- `two`\n\n```ts\nconst a = 1 < 2\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done')
    expect(out).toContain('<h2>Plan</h2>')
    expect(out).toContain('<strong>one</strong>')
    expect(out).toContain('<code>two</code>')
    expect(out).toContain('const a = 1 &lt; 2')
    expect(out).toContain('<table>')
    expect(out).toMatch(/<input[^>]*type="checkbox"[^>]*disabled/)
  })
  it('shows raw HTML as text and never as elements', () => {
    const out = html('Hi <script>alert(1)</script> <img src=x onerror=alert(2)> <iframe src="https://evil.example"></iframe>\n\n<div onclick="x()">block</div>')
    expect(out).not.toMatch(/<(script|img|iframe|div)\b/i)
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(out).toContain('&lt;div onclick=&quot;x()&quot;&gt;block&lt;/div&gt;')
  })
  it('keeps only web links, opened outside the app', () => {
    const out = html('[ok](https://example.com/a) [js](javascript:alert(1)) [data](data:text/html,x) [file](file:///etc/passwd) [rel](../x) <https://auto.example>')
    expect(out).toContain('<a href="https://example.com/a" target="_blank" rel="noreferrer noopener" title="https://example.com/a">ok</a>')
    expect(out).toContain('href="https://auto.example"')
    expect(out).not.toMatch(/javascript:|data:text|file:\/\/|href="\.\.\/x"/)
    for (const word of ['js', 'data', 'file', 'rel']) expect(out).toContain(word)
  })
  it('shows where a link really goes when its text names another site', () => {
    const out = html('[https://github.com/you/repo](https://evil.example/login) [github.com](https://github.com/x) [docs](https://evil.example/)')
    expect(out).toContain('title="https://evil.example/login"')
    expect(out).toContain('<span class="link-real-host"> ↗ evil.example</span>')
    // Text that names the same site, or no site at all, gets no warning.
    expect(out.match(/link-real-host/g)).toHaveLength(1)
  })
  it('never fetches images: shows the alt text, linked when the address is a web one', () => {
    const out = html('![chart](https://tracker.example/p.png) ![local](./a.png)')
    expect(out).not.toContain('<img')
    expect(out).toContain('<a href="https://tracker.example/p.png" target="_blank" rel="noreferrer noopener" class="reply-image" title="https://tracker.example/p.png">chart</a>')
    expect(out).toContain('local')
  })
  it('allows only http and https addresses', () => {
    expect(safeUrl('https://a.example/x?y=1')).toBe('https://a.example/x?y=1')
    expect(safeUrl('http://localhost:5173/')).toBe('http://localhost:5173/')
    for (const bad of ['javascript:alert(1)', ' JAVASCRIPT:x', 'data:x', 'vbscript:x', 'file:///x', '/abs', 'rel/x', '//evil.example', 'mailto:a@b.c']) expect(safeUrl(bad), bad).toBe('')
  })
})
