import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { fileLink } from '../../web/src/markdown/file-links.ts'
import { ReplyContext, ReplyMarkdown } from '../../web/src/markdown/reply.tsx'

// review of u30-4: the bare name.ext allowlist lived inside fileLink(), which every caller shares, so an
// explicit Markdown link ([go.mod](go.mod), [the log](build.log)) stopped opening in Files too, although
// the agent said in so many words that it names a file, and common real files (go.mod, go.sum, *.kts, *.dart,
// *.lua) stopped linking from code spans.
// CORRECT behaviour: the allowlist guards the code-span case only (where `console.log` is ambiguous);
// a Markdown link's target is a file whatever its extension.

const PROJECT = '/work/app'
const html = (text: string): string => renderToStaticMarkup(
  createElement(ReplyContext.Provider, { value: { projectPath: PROJECT, onOpenFile: () => {} } }, createElement(ReplyMarkdown, { text })))
const paths = (markup: string): string[] => [...markup.matchAll(/data-path="([^"]*)"/g)].map((m) => m[1]!)

describe('an explicit Markdown link to a file', () => {
  it('opens the file whatever its extension', () => {
    const markup = html('See [go.mod](go.mod) and [the log](build.log) and [app](app.kts) and [env](app.env) and [main](main.m)')
    expect(paths(markup)).toEqual(['go.mod', 'build.log', 'app.kts', 'app.env', 'main.m'])
    expect(markup).toContain('the log')
  })
  it('keeps the link text', () => {
    expect(html('[the log](build.log)')).toMatch(/<button[^>]*data-path="build\.log"[^>]*>the log<\/button>/)
  })
  it('is a file link for the resolver too', () => {
    expect(fileLink('build.log', PROJECT, 'link')).toEqual({ path: 'build.log' })
    expect(fileLink('main.m', PROJECT, 'link')).toEqual({ path: 'main.m' })
    expect(fileLink('app.env', PROJECT, 'link')).toEqual({ path: 'app.env' })
  })
  it('is still no file when it is not a path inside the project', () => {
    expect(fileLink('../secrets.log', PROJECT, 'link')).toBeUndefined()
    expect(fileLink('/etc/hosts.log', PROJECT, 'link')).toBeUndefined()
    expect(fileLink('noextension', PROJECT, 'link')).toBeUndefined()
    expect(paths(html('[x](../secrets.log)'))).toEqual([])
  })
})

describe('a bare name in a code span', () => {
  it('links go.mod and go.sum and the files of more languages', () => {
    for (const raw of ['go.mod', 'go.sum', 'app.kts', 'main.dart', 'init.lua', 'Build.scala', 'mix.exs']) {
      expect(fileLink(raw, PROJECT), raw).toEqual({ path: raw })
    }
    expect(paths(html('Edit `go.mod` then `go.sum`'))).toEqual(['go.mod', 'go.sum'])
  })
  it('still leaves code alone (control)', () => {
    for (const raw of ['console.log', 'process.env', 'this.state', 'Array.map', 'df.sum', 'schema.properties', 'x.mod']) {
      expect(fileLink(raw, PROJECT), raw).toBeUndefined()
      expect(paths(html(`call \`${raw}\` here`)), raw).toEqual([])
    }
  })
  it('still links a log with a line, or in a directory (control)', () => {
    expect(fileLink('build.log:12', PROJECT)).toEqual({ path: 'build.log', line: 12 })
    expect(fileLink('logs/build.log', PROJECT)).toEqual({ path: 'logs/build.log' })
  })
})
