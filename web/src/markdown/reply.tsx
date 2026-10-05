// Agent replies are untrusted text rendered as Markdown. React builds every element (nothing is
// ever set as HTML), raw HTML in a reply is shown as the text it is, links must be http(s) and
// open in the browser, and images are never fetched: they show as their alt text.
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { commitOf, COMMIT_SCHEME, isCommitHash, linkCommitsInProse } from './commit-links.ts'
import { fileLink, linkFilesInProse, type FileTarget } from './file-links.ts'

/** What clicking a commit did: opened its page, copied it (no web page), or it isn't a commit here. */
export type CommitOutcome = 'opened' | 'copied' | 'missing'
const OUTCOME: Record<CommitOutcome, string> = { opened: '', copied: 'Copied (no web page for this repository)', missing: 'Not a commit in this project' }

/** Where a reply's `path:line` references point and what opening one does. */
export const ReplyContext = createContext<{ projectPath?: string; onOpenFile?: (target: FileTarget) => void; onOpenCommit?: (hash: string) => Promise<CommitOutcome> }>({})

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

const textOf = (node: ReactNode): string =>
  typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(textOf).join('') : ''
const hostOf = (url: string): string => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' } }

/**
 * Electron shows no status bar, so a link's destination is in its tooltip; and when its text names
 * a different site than it goes to ([github.com/you](https://evil.example)), the real one is shown.
 */
export function misleadingHost(text: string, href: string): string | undefined {
  const named = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/:?#]|$)/i.exec(text.trim())?.[1]?.toLowerCase().replace(/^www\./, '')
  const real = hostOf(href)
  return named && real && named !== real ? real : undefined
}

const external = (href: string | undefined, children: ReactNode, className?: string): ReactNode => {
  if (!href) return <span className={className}>{children}</span>
  const real = misleadingHost(textOf(children), href)
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={className} title={href}>
      {children}{real ? <span className="link-real-host"> ↗ {real}</span> : null}
    </a>
  )
}

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

function CommitButton({ hash, children }: { hash: string; children: ReactNode }) {
  const { onOpenCommit } = useContext(ReplyContext)
  const [note, setNote] = useState('')
  const click = (): void => {
    void onOpenCommit?.(hash).then((outcome) => {
      setNote(OUTCOME[outcome])
      if (outcome !== 'opened') setTimeout(() => setNote(''), 2500)
    })
  }
  return (
    <>
      <button type="button" className="file-link commit-link" data-commit={hash} title={`Open commit ${hash}`} onClick={click}>{children}</button>
      {note ? <span className="commit-note" role="status"> {note}</span> : null}
    </>
  )
}

function buildComponents(projectPath: string | undefined): Components {
  return {
    a: ({ href, children }) => {
      if (href && safeUrl(href)) return external(href, children)
      const hash = href && projectPath ? commitOf(href) : undefined
      if (hash) return <CommitButton hash={hash}>{children}</CommitButton>
      const target = href ? fileLink(href, projectPath) : undefined
      return target ? <FileButton target={target}>{children}</FileButton> : <span>{children}</span>
    },
    img: ({ src, alt }) => external(typeof src === 'string' ? safeUrl(src) || undefined : undefined, alt || 'image', 'reply-image'),
    // A code span that is exactly a file reference opens it. Block code ends in a newline and never does.
    code: ({ className, children }) => {
      const text = typeof children === 'string' ? children : ''
      const target = !className && text && !text.includes('\n') ? fileLink(text, projectPath) : undefined
      const code = <code className={className}>{children}</code>
      if (target) return <FileButton target={target}>{code}</FileButton>
      return projectPath && !className && isCommitHash(text) ? <CommitButton hash={text}>{code}</CommitButton> : code
    },
  }
}

export function ReplyMarkdown({ text }: { text: string }) {
  const { projectPath } = useContext(ReplyContext)
  const components = useMemo(() => buildComponents(projectPath), [projectPath])
  const plugins = useMemo(() => [remarkGfm, htmlAsText, linkFilesInProse(projectPath), ...(projectPath ? [linkCommitsInProse] : [])], [projectPath])
  // Web addresses pass; a file reference passes to the link renderer, which checks it again.
  const urlTransform = (url: string): string | undefined =>
    safeUrl(url) || (fileLink(url, projectPath) || (url.startsWith(COMMIT_SCHEME) && commitOf(url)) ? url : undefined)
  return (
    <Markdown remarkPlugins={plugins} components={components} urlTransform={urlTransform}>
      {text}
    </Markdown>
  )
}
