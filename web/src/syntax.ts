import { common, createLowlight } from 'lowlight'
import type { Root, RootContent } from 'hast'

export { languageFor } from './syntax-language.ts'

// Syntax colours for the code editor's Source view. The highlighter returns a tree (never HTML),
// flattened here into plain text runs with class names, so file text is only ever rendered as text.
// Loaded on demand with the editor's highlight layer, not in the main bundle.

const lowlight = createLowlight(common)

export interface Run { readonly text: string; readonly className?: string }

/** Past this size the editor shows plain text: colouring every keystroke would lag. */
export const MAX_HIGHLIGHT_CHARS = 120_000

/** The text as coloured runs. Joining every run's text gives back exactly the input. */
export function highlight(text: string, language: string): Run[] {
  if (text.length > MAX_HIGHLIGHT_CHARS || !lowlight.registered(language)) return [{ text }]
  const runs: Run[] = []
  const walk = (nodes: readonly RootContent[], classes: string): void => {
    for (const node of nodes) {
      if (node.type === 'text') runs.push(classes ? { text: node.value, className: classes } : { text: node.value })
      else if (node.type === 'element') {
        const own = Array.isArray(node.properties.className) ? node.properties.className.join(' ') : ''
        walk(node.children, [classes, own].filter(Boolean).join(' '))
      }
    }
  }
  const tree: Root = lowlight.highlight(language, text)
  walk(tree.children, '')
  return runs
}
