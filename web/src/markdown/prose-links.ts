// Turns matches in a reply's plain text into link nodes (never inside existing links or code).
// The link's url is checked again by the renderer, so a plugin can only propose a link.

export interface MdNode { type: string; value?: string; url?: string; children?: MdNode[] }

/** `pick` returns the url and the matched text to link (a part of the match), or undefined to skip. */
export function linkInProse(pattern: RegExp, pick: (match: RegExpMatchArray) => { url: string; text: string } | undefined) {
  return () => (tree: MdNode): void => {
    const walk = (node: MdNode): void => {
      if (!node.children || node.type === 'link' || node.type === 'linkReference') return
      node.children = node.children.flatMap((child): MdNode[] => {
        if (child.type !== 'text' || !child.value) { walk(child); return [child] }
        const value = child.value
        const out: MdNode[] = []
        let at = 0
        for (const m of value.matchAll(pattern)) {
          const link = pick(m)
          if (!link) continue
          const start = m.index + m[0].indexOf(link.text)
          if (start > at) out.push({ type: 'text', value: value.slice(at, start) })
          out.push({ type: 'link', url: link.url, children: [{ type: 'text', value: link.text }] })
          at = start + link.text.length
        }
        if (!out.length) return [child]
        if (at < value.length) out.push({ type: 'text', value: value.slice(at) })
        return out
      })
    }
    walk(tree)
  }
}
