// Agent replies are untrusted text rendered as Markdown. React builds every element (nothing is
// ever set as HTML), raw HTML in a reply is shown as the text it is, links must be http(s) and
// open in the browser, and images are never fetched: they show as their alt text.
import { createContext, useContext, useMemo, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { fileLink, linkFilesInProse, type FileTarget } from './file-links.ts'

/** Where a reply's `path:line` references point and what opening one does. */
export const ReplyContext = createContext<{ projectPath?: string; onOpenFile?: (target: FileTarget) => void }>({})

/** The address if it is an absolute http(s) URL, else ''. */
export function safeUrl(url: string): string {
  const trimmed = url.trim()
  if (!/^https?:\/\//i.test(trimmed)) return ''
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : ''
  } catch {
    return ''
  }
}

interface MdNode { type: string; children?: MdNode[] }

/** remark plugin: raw HTML nodes become plain text, so they display but never render. */
function htmlAsText() {
  const walk = (node: MdNode): void => {
    if (node.type === 'html') node.type = 'text'
    node.children?.forEach(walk)
  }
  return (tree: MdNode): void => walk(tree)
}

const external = (href: string | undefined, children: ReactNode, className?: string): ReactNode =>
  href ? <a href={href} target="_blank" rel="noreferrer noopener" className={className}>{children}</a> : <span className={className}>{children}</span>

function FileButton({ target, children }: { target: FileTarget; children: ReactNode }) {
  const { onOpenFile } = useContext(ReplyContext)
  const where = target.line ? ` at line ${target.line}${target.endLine ? `–${target.endLine}` : ''}` : ''
  return (
    <button type="button" className="file-link" data-path={target.path} data-line={target.line} data-end-line={target.endLine}
      title={`Open ${target.path}${where} in Files`} onClick={() => onOpenFile?.(target)}>
      {children}
    </button>
  )
}

function buildComponents(projectPath: string | undefined): Components {
  return {
    a: ({ href, children }) => {
      if (href && safeUrl(href)) return external(href, children)
      const target = href ? fileLink(href, projectPath) : undefined
      return target ? <FileButton target={target}>{children}</FileButton> : <span>{children}</span>
    },
    img: ({ src, alt }) => external(typeof src === 'string' ? safeUrl(src) || undefined : undefined, alt || 'image', 'reply-image'),
    // A code span that is exactly a file reference opens it. Block code ends in a newline and never does.
    code: ({ className, children }) => {
      const text = typeof children === 'string' ? children : ''
      const target = !className && text && !text.includes('\n') ? fileLink(text, projectPath) : undefined
      const code = <code className={className}>{children}</code>
      return target ? <FileButton target={target}>{code}</FileButton> : code
    },
  }
}

export function ReplyMarkdown({ text }: { text: string }) {
  const { projectPath } = useContext(ReplyContext)
  const components = useMemo(() => buildComponents(projectPath), [projectPath])
  const plugins = useMemo(() => [remarkGfm, htmlAsText, linkFilesInProse(projectPath)], [projectPath])
  // Web addresses pass; a file reference passes to the link renderer, which checks it again.
  const urlTransform = (url: string): string | undefined => safeUrl(url) || (fileLink(url, projectPath) ? url : undefined)
  return (
    <Markdown remarkPlugins={plugins} components={components} urlTransform={urlTransform}>
      {text}
    </Markdown>
  )
}
