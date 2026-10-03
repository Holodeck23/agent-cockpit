import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { findRanges, stepIndex } from '../find.ts'
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
    if (!parent || parent.closest('.find-bar, button') || parent.getClientRects().length === 0) continue
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
    </div>
  )
}
