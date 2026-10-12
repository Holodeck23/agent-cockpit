import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { fileLink } from '../../web/src/markdown/file-links.ts'
import { ReplyContext, ReplyMarkdown } from '../../web/src/markdown/reply.tsx'

// u30-4: an inline code span became a file link whenever it looked like name.ext, so `console.log`,
// `process.env`, `this.state` and `Array.map` rendered as "Open ... in Files" buttons that lead to a
// not-found panel for a file that never existed.
// CORRECT behaviour: a bare name.ext with no directory and no line number is a file only when its
// extension is one files really have; code member access stays plain code. README.md still links.

const PROJECT = '/work/app'
const html = (text: string): string => renderToStaticMarkup(
  createElement(ReplyContext.Provider, { value: { projectPath: PROJECT, onOpenFile: () => {} } }, createElement(ReplyMarkdown, { text })))

describe('what a code span must look like to be a file', () => {
  it('leaves code member access alone', () => {
    for (const raw of ['console.log', 'process.env', 'this.state', 'Array.map', 'JSON.parse', 'Math.max', 'window.location', 'fs.promises']) {
      expect(fileLink(raw, PROJECT), raw).toBeUndefined()
      expect(html(`call \`${raw}\` here`), raw).not.toContain('data-path')
    }
  })
  it('still links files named bare, in a directory, or with a line', () => {
    expect(fileLink('README.md', PROJECT)).toEqual({ path: 'README.md' })
    expect(fileLink('package.json', PROJECT)).toEqual({ path: 'package.json' })
    expect(fileLink('./tsconfig.json', PROJECT)).toEqual({ path: 'tsconfig.json' })
    expect(fileLink('/work/app/vite.config.ts', PROJECT)).toEqual({ path: 'vite.config.ts' })
    expect(fileLink('src/notes.weird', PROJECT)).toEqual({ path: 'src/notes.weird' })
    expect(fileLink('build.log:12', PROJECT)).toEqual({ path: 'build.log', line: 12 })
    expect(html('open `README.md` and `src/app.ts`').match(/data-path=/g)).toHaveLength(2)
  })
})
