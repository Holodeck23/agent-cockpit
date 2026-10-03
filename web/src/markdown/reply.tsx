// Agent replies are untrusted text rendered as Markdown. React builds every element (nothing is
// ever set as HTML), raw HTML in a reply is shown as the text it is, links must be http(s) and
// open in the browser, and images are never fetched: they show as their alt text.
import type { ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

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

const components: Components = {
  a: ({ href, children }) => external(href, children),
  img: ({ src, alt }) => external(typeof src === 'string' ? src : undefined, alt || 'image', 'reply-image'),
}

const PLUGINS = [remarkGfm, htmlAsText]

export function ReplyMarkdown({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={PLUGINS} components={components} urlTransform={(url) => safeUrl(url) || undefined}>
      {text}
    </Markdown>
  )
}
