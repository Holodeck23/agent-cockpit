import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { findRanges, snippet, stepIndex } from '../find.ts'
import { ChevronDownIcon, ChevronUpIcon } from './icons.tsx'

const ALL = 'cockpit-find'
const CURRENT = 'cockpit-find-current'

// The CSS Custom Highlight API paints matches without touching the transcript's DOM.
const highlights = (): HighlightRegistry | undefined => (typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : undefined)

function clearHighlights(): void {
  highlights()?.delete(ALL)
  highlights()?.delete(CURRENT)
}

/** Every visible match under `root`, in document order. Text inside closed disclosures is skipped. */
function collect(root: HTMLElement, query: string): Range[] {
  const ranges: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement
    // Controls are skipped; file and commit links in replies are part of the text.
    if (!parent || parent.closest('.find-bar, button:not(.file-link)') || parent.getClientRects().length === 0) continue
    for (const [start, end] of findRanges(node.textContent ?? '', query)) {
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, end)
      ranges.push(range)
    }
  }
  return ranges
}

interface FindBarProps {
  /** The scrolling conversation; matches are searched inside it. */
  root: RefObject<HTMLElement | null>
  /** Changes when the conversation's content changes, so matches are found again. */
  contentKey: string
  onClose: () => void
}

const ROWS = 50
interface Group { first: number; count: number; author: string; before: string; match: string; after: string }

/** Matches grouped by the message (or note) they are in, in order, with an excerpt of the first. */
function groupsOf(ranges: readonly Range[]): Group[] {
  const groups: Group[] = []
  let owner: Element | null | undefined
  ranges.forEach((range, index) => {
    const el = range.startContainer.parentElement?.closest('.message, .note, .step, .decision, .approval') ?? null
    if (el && el === owner) { groups[groups.length - 1]!.count += 1; return }
    owner = el
    const text = el?.textContent ?? range.startContainer.textContent ?? ''
    const lead = document.createRange()
    if (el) { lead.setStart(el, 0); lead.setEnd(range.startContainer, range.startOffset) }
    const at = el ? lead.toString().length : range.startOffset
    const author = el?.querySelector('.author-name')?.textContent?.trim() ?? ''
    groups.push({ first: index, count: 1, author, ...snippet(text, at, at + range.toString().length) })
  })
  return groups
}

/** ⌘F in a conversation: highlighted matches, Enter / Shift+Enter (or the arrows) to step, Esc to close. */
export function FindBar({ root, contentKey, onClose }: FindBarProps) {
  const [query, setQuery] = useState('')
  const [ranges, setRanges] = useState<Range[]>([])
  const [current, setCurrent] = useState(-1)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
    return clearHighlights
  }, [])

  // Re-find on a new query or new content; keep the position when the same match count remains.
  useLayoutEffect(() => {
    const el = root.current
    const found = el ? collect(el, query) : []
    setRanges(found)
    setCurrent((at) => (found.length === 0 ? -1 : at >= 0 && at < found.length ? at : 0))
  }, [query, contentKey, root])

  useEffect(() => {
    const registry = highlights()
    if (!registry) return
    if (ranges.length === 0) { clearHighlights(); return }
    registry.set(ALL, new Highlight(...ranges))
    const active = ranges[current]
    if (active) {
      registry.set(CURRENT, new Highlight(active))
      active.startContainer.parentElement?.scrollIntoView({ block: 'center' })
    } else registry.delete(CURRENT)
  }, [ranges, current])

  const step = (direction: 1 | -1): void => setCurrent((at) => stepIndex(at, ranges.length, direction))
  // Which messages match: a list under the bar to jump between them (shown for two or more).
  const groups = useMemo(() => groupsOf(ranges), [ranges])
  const activeGroup = groups.findLastIndex((g) => g.first <= current)

  return (
    <div className="find-bar" role="search">
      <input
        ref={input}
        type="search"
        aria-label="Find in conversation"
        placeholder="Find in conversation"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1) }
          else if (e.key === 'Escape') { e.preventDefault(); onClose() }
        }}
      />
      <span className="find-count" aria-live="polite">
        {query.trim() ? (ranges.length ? `${current + 1} of ${ranges.length}` : 'No matches') : ''}
      </span>
      <button type="button" aria-label="Previous match" disabled={ranges.length === 0} onClick={() => step(-1)}><ChevronUpIcon /></button>
      <button type="button" aria-label="Next match" disabled={ranges.length === 0} onClick={() => step(1)}><ChevronDownIcon /></button>
      <button type="button" className="find-close" aria-label="Close find" onClick={onClose}>×</button>
      {groups.length > 1 ? (
        <ul className="find-results" aria-label="Matching messages">
          {groups.slice(0, ROWS).map((g, i) => (
            <li key={g.first}>
              <button type="button" aria-current={i === activeGroup || undefined} onClick={() => { setCurrent(g.first); input.current?.focus() }}>
                {g.author ? <span className="find-result-author">{g.author}</span> : null}
                <span className="find-result-text">{g.before}<mark>{g.match}</mark>{g.after}</span>
                {g.count > 1 ? <span className="find-result-count">{g.count}</span> : null}
              </button>
            </li>
          ))}
          {groups.length > ROWS ? <li className="find-results-more">{groups.length - ROWS} more messages match; keep typing to narrow it.</li> : null}
        </ul>
      ) : null}
    </div>
  )
}
