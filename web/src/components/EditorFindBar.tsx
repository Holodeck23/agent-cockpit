import { useEffect, useRef, useState } from 'react'
import { stepIndex } from '../find.ts'
import { ChevronDownIcon, ChevronRightIcon, ChevronUpIcon } from './icons.tsx'

/** What the find bar needs from an editor: the Source textarea and the Document view each provide one. */
export interface FindAdapter {
  /** Finds the query in the editor's current text; returns how many matches. */
  search(query: string, matchCase: boolean): number
  /** Paints every match, and `current` more strongly (-1 for none). */
  paint(current: number): void
  /** Scrolls match `index` into view without moving the keyboard focus. */
  reveal(index: number): void
  /** Replaces one match through the editor's own undo history. */
  replace(index: number, replacement: string): void
  /** Replaces every match as one undoable step; returns how many. */
  replaceAll(replacement: string): number
  /** Removes the painted matches. */
  clear(): void
}

export const FIND_ALL = 'cockpit-editor-find'
export const FIND_CURRENT = 'cockpit-editor-find-current'

/** Paints ranges with the CSS Custom Highlight API: no change to the editor's own DOM. */
export function paintRanges(ranges: readonly Range[], current: number): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return
  CSS.highlights.set(FIND_ALL, new Highlight(...ranges))
  const at = ranges[current]
  if (at) CSS.highlights.set(FIND_CURRENT, new Highlight(at))
  else CSS.highlights.delete(FIND_CURRENT)
}
export function clearPaint(): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return
  CSS.highlights.delete(FIND_ALL)
  CSS.highlights.delete(FIND_CURRENT)
}

/** DOM ranges for [start, end) text offsets inside `root`'s text nodes (in order). */
export function textRanges(root: Node, offsets: ReadonlyArray<readonly [number, number]>): Range[] {
  const ranges: Range[] = []
  if (offsets.length === 0) return ranges
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let base = 0
  let i = 0
  let startNode: Node | undefined
  let startOffset = 0
  for (let node = walker.nextNode(); node && i < offsets.length; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0
    while (i < offsets.length) {
      const [start, end] = offsets[i]!
      if (!startNode) {
        if (start >= base + length) break
        startNode = node
        startOffset = start - base
      }
      if (end > base + length) break
      const range = document.createRange()
      range.setStart(startNode, startOffset)
      range.setEnd(node, end - base)
      ranges.push(range)
      startNode = undefined
      i += 1
    }
    base += length
  }
  return ranges
}

interface EditorFindBarProps {
  adapter: FindAdapter
  /** Changes whenever the editor's text changes, so matches are found again. */
  contentKey: string
  /** Open with the Replace row showing (⌥⌘F). */
  withReplace: boolean
  readOnly: boolean
  onClose: () => void
}

/** ⌘F in the editor: find, step with Enter / Shift+Enter, replace one or all; Esc closes. */
export function EditorFindBar({ adapter, contentKey, withReplace, readOnly, onClose }: EditorFindBarProps) {
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [showReplace, setShowReplace] = useState(withReplace)
  const [count, setCount] = useState(0)
  const [current, setCurrent] = useState(-1)
  const findInput = useRef<HTMLInputElement>(null)
  const adapterRef = useRef(adapter)
  adapterRef.current = adapter

  useEffect(() => { setShowReplace((shown) => shown || withReplace) }, [withReplace])
  useEffect(() => {
    findInput.current?.focus()
    findInput.current?.select()
    return () => adapterRef.current.clear()
  }, [])

  // Find again when the query or the text changes; stay near the same match.
  useEffect(() => {
    const found = adapterRef.current.search(query, matchCase)
    setCount(found)
    setCurrent((at) => (found === 0 ? -1 : at < 0 ? 0 : Math.min(at, found - 1)))
  }, [query, matchCase, contentKey])

  useEffect(() => {
    adapterRef.current.paint(current)
    if (current >= 0) adapterRef.current.reveal(current)
  }, [current, count, contentKey])

  const step = (direction: 1 | -1): void => setCurrent((at) => stepIndex(at, count, direction))
  const replaceOne = (): void => {
    if (current < 0 || readOnly) return
    adapterRef.current.replace(current, replacement)
  }
  const replaceAll = (): void => {
    if (count === 0 || readOnly) return
    adapterRef.current.replaceAll(replacement)
  }

  return (
    <div className="editor-find" role="search" aria-label="Find in file" onKeyDown={(e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
    }}>
      <div className="editor-find-row">
        <button type="button" className="editor-find-toggle" aria-label={showReplace ? 'Hide replace' : 'Show replace'} aria-expanded={showReplace}
          onClick={() => setShowReplace(!showReplace)}>{showReplace ? <ChevronDownIcon /> : <ChevronRightIcon />}</button>
        <input ref={findInput} type="search" aria-label="Find" placeholder="Find" value={query} spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1) } }} />
        <span className="find-count" role="status">{query ? (count === 0 ? 'No matches' : `${current + 1} of ${count}`) : ''}</span>
        <button type="button" className={`editor-find-case${matchCase ? ' on' : ''}`} aria-pressed={matchCase} aria-label="Match case" title="Match case" onClick={() => setMatchCase(!matchCase)}>Aa</button>
        <button type="button" aria-label="Previous match" disabled={count === 0} onClick={() => step(-1)}><ChevronUpIcon /></button>
        <button type="button" aria-label="Next match" disabled={count === 0} onClick={() => step(1)}><ChevronDownIcon /></button>
        <button type="button" aria-label="Close find" onClick={onClose}>×</button>
      </div>
      {showReplace ? (
        <div className="editor-find-row">
          <span className="editor-find-spacer" />
          <input type="text" aria-label="Replace with" placeholder={readOnly ? 'Read-only file' : 'Replace with'} value={replacement} disabled={readOnly} spellCheck={false}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); replaceOne() } }} />
          <button type="button" className="editor-find-text" disabled={readOnly || current < 0} onClick={replaceOne}>Replace</button>
          <button type="button" className="editor-find-text" disabled={readOnly || count === 0} onClick={replaceAll}>Replace all</button>
        </div>
      ) : null}
    </div>
  )
}
