// Release notes are Markdown from the release feed: untrusted text. They are read into plain
// blocks and rendered by React (so nothing is ever HTML), and links keep only their words.

export interface Span { text: string; bold?: true; code?: true }
export type NotesBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: Span[] }
  | { kind: 'paragraph'; text: Span[] }
  | { kind: 'list'; items: Span[][] }

function spans(line: string): Span[] {
  const plain = line.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
  const out: Span[] = []
  for (const part of plain.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
    if (!part) continue
    if (/^\*\*[^*]+\*\*$/.test(part)) out.push({ text: part.slice(2, -2), bold: true })
    else if (/^`[^`]+`$/.test(part)) out.push({ text: part.slice(1, -1), code: true })
    else out.push({ text: part })
  }
  return out
}

export function notesBlocks(markdown: string): NotesBlock[] {
  const blocks: NotesBlock[] = []
  let paragraph: string[] = []
  let items: Span[][] = []
  const flush = (): void => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: spans(paragraph.join(' ')) })
    if (items.length) blocks.push({ kind: 'list', items })
    paragraph = []
    items = []
  }
  for (const raw of markdown.split('\n')) {
    const line = raw.trim()
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    const bullet = /^[-*+]\s+(.*)$/.exec(line)
    if (!line || /^(-{3,}|\*{3,}|_{3,})$/.test(line)) { flush(); continue }
    if (heading) { flush(); blocks.push({ kind: 'heading', level: Math.min(heading[1]!.length, 3) as 1 | 2 | 3, text: spans(heading[2]!) }); continue }
    if (bullet) { if (paragraph.length) flush(); items.push(spans(bullet[1]!)); continue }
    if (items.length) flush()
    paragraph.push(line)
  }
  flush()
  return blocks
}
