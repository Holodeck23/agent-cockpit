import { useEffect, useRef, useState } from 'react'
import { defaultValueCtx, Editor, editorViewCtx, editorViewOptionsCtx, rootCtx } from '@milkdown/kit/core'
import { history } from '@milkdown/kit/plugin/history'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { baselineOf, markdownOf, splitFrontMatter, type Baseline } from '../markdown/document.ts'
import { taskToggle } from '../markdown/task-toggle.ts'
import { DocumentToolbar } from './DocumentToolbar.tsx'
import { TextSelection } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { findIn } from '../editor-find.ts'
import { clearPaint, EditorFindBar, paintRanges, type FindAdapter } from './EditorFindBar.tsx'
import '../styles/document.css'

// The rich Document view of a Markdown file. It edits the same draft as the Source view:
// every change is written back through the splice (see markdown/document.ts), so what was
// not edited keeps its exact text. Loaded on demand; the editor is not in the main bundle.

interface DocumentViewProps {
  draft: string
  readOnly: boolean
  onChange: (draft: string) => void
  /** Cmd+S: the view flushes its latest text first and passes it here. */
  onSave: (draft: string) => void
  /** The file cannot be shown here without risking its Markdown; the caller shows Source. */
  onUnavailable: (reason: string) => void
  /** The find bar is open (⌘F), with Replace (⌥⌘F). */
  find?: 'find' | 'replace'
  onCloseFind?: () => void
}

interface DocMatch { readonly from: number; readonly to: number }

/** Matches inside each paragraph or heading of the document, as editor positions. Never across blocks. */
function docMatches(view: EditorView, query: string, matchCase: boolean): DocMatch[] {
  const found: DocMatch[] = []
  view.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    // A leaf inside a block (a hard break, an image) stands in as one character, so offsets stay positions.
    let text = ''
    node.forEach((child) => { text += child.isText ? child.text ?? '' : '\uFFFC'.repeat(child.nodeSize) })
    for (const [start, end] of findIn(text, query, matchCase)) found.push({ from: pos + 1 + start, to: pos + 1 + end })
    return false
  })
  return found
}

function domRange(view: EditorView, match: DocMatch): Range | undefined {
  try {
    const start = view.domAtPos(match.from)
    const end = view.domAtPos(match.to)
    const range = document.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)
    return range
  } catch {
    return undefined
  }
}

export default function DocumentView({ draft, readOnly, onChange, onSave, onUnavailable, find, onCloseFind }: DocumentViewProps) {
  const host = useRef<HTMLDivElement>(null)
  const [editor, setEditor] = useState<Editor>()
  const [problem, setProblem] = useState<string>()
  const baseline = useRef<Baseline | undefined>(undefined)
  const emitted = useRef<string | undefined>(draft)
  const current = useRef<{ editor: Editor; write: () => string | undefined } | undefined>(undefined)
  const callbacks = useRef({ onChange, onSave, onUnavailable })
  callbacks.current = { onChange, onSave, onUnavailable }

  // A draft that did not come from this view (open, reload, conflict copy) rebuilds it.
  const external = draft !== emitted.current
  const [generation, setGeneration] = useState(0)
  useEffect(() => { if (external) setGeneration((n) => n + 1) }, [external, draft])

  useEffect(() => {
    const root = host.current
    if (!root) return
    let alive = true
    let made: Editor | undefined
    const source = draft
    emitted.current = source
    /** Reports the document's Markdown now; returns it, or undefined when it cannot be written. */
    const write = (): string | undefined => {
      if (!made || !baseline.current) return undefined
      const result = made.action((ctx) => markdownOf(ctx, baseline.current!, ctx.get(editorViewCtx).state.doc))
      if (!result.ok) { setProblem(result.reason); return undefined }
      setProblem(undefined)
      if (result.markdown !== emitted.current) { emitted.current = result.markdown; callbacks.current.onChange(result.markdown) }
      return result.markdown
    }
    void Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root)
        // Parsed once as the initial state, so it is not an undoable step.
        ctx.set(defaultValueCtx, splitFrontMatter(source).body)
        ctx.update(editorViewOptionsCtx, (options) => ({ ...options, editable: () => !readOnly }))
        ctx.get(listenerCtx).updated(() => { if (alive) write() })
      })
      .use(commonmark).use(gfm).use(history).use(listener).use(taskToggle)
      .create()
      .then((created) => {
        made = created
        if (!alive) { void created.destroy(); return }
        const result = created.action((ctx) => baselineOf(ctx, source))
        if (!result.ok) { callbacks.current.onUnavailable(result.reason); return }
        baseline.current = result.baseline
        current.current = { editor: created, write }
        setEditor(created)
      })
    return () => {
      alive = false
      current.current = undefined
      baseline.current = undefined
      setEditor(undefined)
      void made?.destroy()
    }
    // Rebuilt only for a new generation or read-only change; `draft` is read at that moment.
  }, [generation, readOnly])

  // Leaving the view keeps keystrokes the listener has not reported yet. Only on unmount:
  // a rebuild after a reload must not write the old text back over the new one.
  useEffect(() => () => { current.current?.write() }, [])

  const matches = useRef<DocMatch[]>([])
  const viewOf = (): EditorView | undefined => current.current?.editor.action((ctx) => ctx.get(editorViewCtx))
  const adapter: FindAdapter = {
    search: (query, matchCase) => { const view = viewOf(); matches.current = view ? docMatches(view, query, matchCase) : []; return matches.current.length },
    paint: (index) => {
      const view = viewOf()
      if (view) paintRanges(matches.current.map((m) => domRange(view, m)).filter((r): r is Range => r !== undefined), index)
    },
    reveal: (index) => {
      const view = viewOf()
      const at = matches.current[index]
      if (!view || !at) return
      // Moves the editor's selection to the match and scrolls to it; the find box keeps the keyboard.
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at.from, at.to)).scrollIntoView())
    },
    replace: (index, replacement) => {
      const view = viewOf()
      const at = matches.current[index]
      if (view && at) view.dispatch(view.state.tr.insertText(replacement, at.from, at.to))
    },
    replaceAll: (replacement) => {
      const view = viewOf()
      if (!view || matches.current.length === 0) return 0
      // One transaction, last match first so earlier positions stay valid: one ⌘Z undoes it.
      const tr = view.state.tr
      for (const at of [...matches.current].reverse()) tr.insertText(replacement, at.from, at.to)
      view.dispatch(tr)
      return matches.current.length
    },
    clear: clearPaint,
  }

  return (
    <div className="doc-view">
      {find && editor ? <EditorFindBar adapter={adapter} contentKey={draft} withReplace={find === 'replace'} readOnly={readOnly} onClose={() => { onCloseFind?.(); viewOf()?.focus() }} /> : null}
      {editor && !readOnly ? <DocumentToolbar editor={editor} /> : null}
      {baseline.current?.frontMatter ? <p className="file-help">Front matter is kept as it is. Edit it in Source.</p> : null}
      {problem ? <div className="workflow-notice" role="alert">{problem}</div> : null}
      <div className="doc-surface" ref={host} aria-label="Document" onKeyDown={(event) => {
        if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return
        event.preventDefault()
        // Save exactly what is on screen, including edits the listener has not reported yet.
        const latest = current.current?.write()
        if (latest !== undefined) callbacks.current.onSave(latest)
      }} />
    </div>
  )
}
