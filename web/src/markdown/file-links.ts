import { linkInProse } from './prose-links.ts'

// `path:line` references in agent replies. Only relative paths inside the project (or absolute
// ones under it) with a real file extension count, so version numbers and prose stay text.

export interface FileTarget { readonly path: string; readonly line?: number; readonly endLine?: number }

const SPEC = /^([^\s:#]+)(?::(\d+)(?:-(\d+)|:\d+)?|#L(\d+)(?:-L?(\d+))?)?$/
const PATH = /^[\w@+-][\w.@+/-]*$/
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/
// A bare name.ext (no directory, no line) is as often code (`console.log`, `this.state`) as a file,
// so it counts only with an extension that files really have.
const FILE_EXTENSIONS = new Set(('md mdx txt json jsonc yaml yml toml ini cfg conf lock ts tsx mts cts js jsx mjs cjs css scss less html htm xml svg ' +
  'py rb go rs java kt swift c h cpp hpp cs php sh bash zsh sql graphql proto vue svelte csv tsv png jpg jpeg gif webp pdf plist gradle tf ipynb patch diff').split(' '))

export function fileLink(raw: string, projectPath: string | undefined): FileTarget | undefined {
  if (!projectPath) return undefined
  const match = SPEC.exec(raw.trim())
  if (!match) return undefined
  let path = match[1]!
  if (path.startsWith('/')) {
    const root = `${projectPath.replace(/\/+$/, '')}/`
    if (!path.startsWith(root)) return undefined
    path = path.slice(root.length)
  }
  path = path.replace(/^\.\//, '')
  if (!PATH.test(path) || !EXTENSION.test(path)) return undefined
  if (path.split('/').some((part) => part === '' || part === '.' || part === '..')) return undefined
  const numbered = match[2] !== undefined || match[4] !== undefined
  if (!numbered && !path.includes('/') && !FILE_EXTENSIONS.has(path.slice(path.lastIndexOf('.') + 1).toLowerCase())) return undefined
  const line = Number(match[2] ?? match[4] ?? NaN)
  const end = Number(match[3] ?? match[5] ?? NaN)
  if (numbered) {
    if (!(line >= 1)) return undefined
    return end > line ? { path, line, endLine: end } : { path, line }
  }
  return { path }
}

// In prose a reference needs its line number, so a file merely named stays plain text.
const IN_PROSE = /(?<![\w/.@-])((?:\/|\.\/)?[\w@+-][\w.@+/-]*\.[A-Za-z][A-Za-z0-9]{0,9}:\d+(?:-\d+)?)(?!\w)/g

/** remark plugin: `path:line` written in prose becomes a link node, checked again when rendered. */
export function linkFilesInProse(projectPath: string | undefined) {
  return linkInProse(IN_PROSE, (m) => (projectPath && fileLink(m[1]!, projectPath) ? { url: m[1]!, text: m[1]! } : undefined))
}
