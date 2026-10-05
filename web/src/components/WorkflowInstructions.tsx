import { lazy, Suspense, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { MAX_ATTACHED_FILES } from '../../../server/files/references.ts'
import { referencesIn, tokenFor } from '../draft-references.ts'
import type { FindMode } from './FileEditor.tsx'
import { useMentionMenu } from './MentionMenu.tsx'

// A workflow's instructions (F12): written as a document (Markdown, with a toolbar) or as
// source text, the same way Files edits Markdown. In both, typing @ lists this project's files
// and workflows; in the document, ⌘F finds and replaces (F9).

const DocumentView = lazy(() => import('./DocumentView.tsx'))
const VIEW_KEY = 'cockpit:workflow-view'
type View = 'document' | 'source'
const loadView = (): View => { try { return localStorage.getItem(VIEW_KEY) === 'source' ? 'source' : 'document' } catch { return 'document' } }
const PLACEHOLDER = 'Review this project’s recent changes. Report bugs with file locations and suggested fixes.'

interface Props {
  projectPath: string
  value: string
  onChange: (value: string) => void
  /** ⌘S: save the workflow; `latest` is the document's text at that moment, when the document has it. */
  onSave: (latest?: string) => void
  autoFocus: boolean
  disabled: boolean
}

export function WorkflowInstructions({ projectPath, value, onChange, onSave, autoFocus, disabled }: Props) {
  const [view, setView] = useState<View>(loadView)
  const [declined, setDeclined] = useState<string>()
  const [find, setFind] = useState<FindMode>()
  const choose = (next: View): void => {
    setView(next)
    try { localStorage.setItem(VIEW_KEY, next) } catch { /* not remembered */ }
  }
  const references = referencesIn(value)
  const attached = new Set(references.map((r) => tokenFor(r.kind, r.reference)))
  const filesFull = references.filter((r) => r.kind === 'file').reduce((n, r) => n + r.count, 0) >= MAX_ATTACHED_FILES
  const showing: View = declined ? 'source' : view

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (!(event.metaKey || event.ctrlKey) || event.defaultPrevented) return
    if (event.key.toLowerCase() === 's') { event.preventDefault(); onSave() }
    else if ((event.key.toLowerCase() === 'f' || event.code === 'KeyF') && showing === 'document') { event.preventDefault(); setFind(event.altKey ? 'replace' : 'find') }
  }

  return (
    <div className="workflow-instructions" onKeyDown={onKeyDown}>
      <div className="workflow-instructions-head">
        <span className="workflow-label" id="instructions-label">Instructions</span>
        <div className="file-views" role="group" aria-label="Instructions view">
          <button type="button" aria-pressed={showing === 'document'} disabled={Boolean(declined)} onClick={() => choose('document')}>Document</button>
          <button type="button" aria-pressed={showing === 'source'} onClick={() => choose('source')}>Source</button>
        </div>
      </div>
      {declined ? <p className="file-help">{declined}</p> : null}
      {showing === 'document' ? (
        <div className="doc-host workflow-doc" aria-labelledby="instructions-label">
          <Suspense fallback={<p role="status">Loading editor…</p>}>
            <DocumentView draft={value} readOnly={disabled} onChange={onChange} onSave={(latest) => { onChange(latest); onSave(latest) }}
              onUnavailable={(reason) => setDeclined(reason)} find={find} onCloseFind={() => setFind(undefined)}
              mentions={{ projectPath, attached, filesFull }} autoFocus={autoFocus} />
          </Suspense>
        </div>
      ) : (
        <SourceInstructions projectPath={projectPath} value={value} onChange={onChange} autoFocus={autoFocus} disabled={disabled}
          attached={attached} filesFull={filesFull} />
      )}
    </div>
  )
}

function SourceInstructions({ projectPath, value, onChange, autoFocus, disabled, attached, filesFull }: {
  projectPath: string; value: string; onChange: (value: string) => void; autoFocus: boolean; disabled: boolean
  attached: ReadonlySet<string>; filesFull: boolean
}) {
  const box = useRef<HTMLTextAreaElement>(null)
  const [caret, setCaret] = useState<number>()
  const pendingCaret = useRef<number | undefined>(undefined)
  useLayoutEffect(() => {
    const at = pendingCaret.current
    if (at === undefined || !box.current) return
    pendingCaret.current = undefined
    box.current.setSelectionRange(at, at)
    setCaret(at)
  }, [value])
  const mentions = useMentionMenu({
    projectPath, text: value, caret, attached, filesFull,
    onComplete: (next, at) => { pendingCaret.current = at; onChange(next) },
  })
  return (
    <div className="workflow-source">
      {mentions.menu}
      <textarea ref={box} aria-labelledby="instructions-label" required maxLength={40_000} rows={9} value={value} autoFocus={autoFocus} disabled={disabled}
        placeholder={PLACEHOLDER}
        onChange={(e) => { onChange(e.target.value); setCaret(e.target.selectionStart) }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onFocus={(e) => setCaret(e.currentTarget.selectionStart)}
        onBlur={() => setCaret(undefined)}
        onKeyDown={(e) => { mentions.onKeyDown(e) }} />
    </div>
  )
}
