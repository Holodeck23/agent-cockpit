// `path:line` references in agent replies. Only relative paths inside the project (or absolute
// ones under it) with a real file extension count, so version numbers and prose stay text.

export interface FileTarget { readonly path: string; readonly line?: number; readonly endLine?: number }

const SPEC = /^([^\s:#]+)(?::(\d+)(?:-(\d+)|:\d+)?|#L(\d+)(?:-L?(\d+))?)?$/
const PATH = /^[\w@+-][\w.@+/-]*$/
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/

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
  const line = Number(match[2] ?? match[4] ?? NaN)
  const end = Number(match[3] ?? match[5] ?? NaN)
  if (match[2] !== undefined || match[4] !== undefined) {
    if (!(line >= 1)) return undefined
    return end > line ? { path, line, endLine: end } : { path, line }
  }
  return { path }
}

// In prose a reference needs its line number, so a file merely named stays plain text.
const IN_PROSE = /(?<![\w/.@-])((?:\/|\.\/)?[\w@+-][\w.@+/-]*\.[A-Za-z][A-Za-z0-9]{0,9}:\d+(?:-\d+)?)(?!\w)/g

interface MdNode { type: string; value?: string; url?: string; children?: MdNode[] }

/** remark plugin: `path:line` written in prose becomes a link node, checked again when rendered. */
export function linkFilesInProse(projectPath: string | undefined) {
  return () => (tree: MdNode): void => {
    if (!projectPath) return
    const walk = (node: MdNode): void => {
      if (!node.children || node.type === 'link' || node.type === 'linkReference') return
      node.children = node.children.flatMap((child): MdNode[] => {
        if (child.type !== 'text' || !child.value) { walk(child); return [child] }
        const out: MdNode[] = []
        let at = 0
        for (const m of child.value.matchAll(IN_PROSE)) {
          if (!fileLink(m[1]!, projectPath)) continue
          if (m.index > at) out.push({ type: 'text', value: child.value.slice(at, m.index) })
          out.push({ type: 'link', url: m[1]!, children: [{ type: 'text', value: m[1]! }] })
          at = m.index + m[0].length
        }
        if (!out.length) return [child]
        if (at < child.value.length) out.push({ type: 'text', value: child.value.slice(at) })
        return out
      })
    }
    walk(tree)
  }
}
