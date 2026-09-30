import { lazy, Suspense, useState, type KeyboardEvent } from 'react'
import { isDirty, type OpenFile } from '../file-text.ts'
import { FileIcon } from './icons.tsx'

interface FileEditorProps {
  files: readonly OpenFile[]
  active?: string
  error: string
  onSelect: (path: string) => void
  onClose: (path: string) => void
  onChange: (path: string, draft: string) => void
  /** `draft` is the text to save when an editor has just flushed it. */
  onSave: (path: string, draft?: string) => void
  onReload: (path: string) => void
  onOverwrite: (path: string) => void
  onSaveCopy: (path: string) => void
  onAttach: (path: string) => void
}

// Guessed words must not land in files; the editor holds exactly what was typed.
const PLAIN_TEXT: Record<string, string> = { writingsuggestions: 'false', autoCorrect: 'off', autoCapitalize: 'off' }
const nameOf = (path: string): string => path.split('/').pop() ?? path
const isMarkdown = (path: string): boolean => /\.(md|markdown)$/i.test(path)
// The rich editor is loaded only when a Markdown file is shown as a document.
const DocumentView = lazy(() => import('./DocumentView.tsx'))
const VIEW_KEY = 'cockpit:markdown-view'
type MarkdownView = 'document' | 'source'
function loadView(): MarkdownView {
  try { return localStorage.getItem(VIEW_KEY) === 'source' ? 'source' : 'document' } catch { return 'document' }
}

export function FileEditor({ files, active, error, onSelect, onClose, onChange, onSave, onReload, onOverwrite, onSaveCopy, onAttach }: FileEditorProps) {
  const [confirming, setConfirming] = useState<string>()
  const [view, setView] = useState<MarkdownView>(loadView)
  // Files the Document view declined, with its reason; they stay in Source.
  const [declined, setDeclined] = useState<Readonly<Record<string, string>>>({})
  const chooseView = (next: MarkdownView): void => {
    setView(next)
    try { localStorage.setItem(VIEW_KEY, next) } catch { /* not remembered */ }
  }
  const file = files.find((f) => f.path === active)
  const dirty = file ? isDirty(file) : false

  const requestClose = (target: OpenFile): void => {
    if (isDirty(target)) { onSelect(target.path); setConfirming(target.path) } else onClose(target.path)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      if (file && dirty && file.eol && !file.conflict) onSave(file.path)
    }
  }

  return (
    <main className="file-preview file-editor">
      {files.length > 0 ? (
        <div className="file-tabs" role="tablist" aria-label="Open files">
          {files.map((f) => (
            <div key={f.path} className={`file-tab${f.path === active ? ' active' : ''}`}>
              <button type="button" role="tab" aria-selected={f.path === active} title={f.path} onClick={() => onSelect(f.path)}>
                {nameOf(f.path)}
                {isDirty(f) ? <span className="file-dirty" aria-label="unsaved">●</span> : null}
              </button>
              <button type="button" className="file-tab-close" aria-label={`Close ${nameOf(f.path)}`} onClick={() => requestClose(f)}>×</button>
            </div>
          ))}
        </div>
      ) : null}
      {error ? <div className="workflow-notice" role="alert">{error}</div> : null}
      {file ? (
        <>
          <header>
            <div>
              <h2>{file.path}</h2>
              <span>{dirty ? 'Unsaved changes' : 'Saved'}{file.eol === '\r\n' ? ' · Windows line endings' : ''}</span>
            </div>
            <div className="file-actions">
              {isMarkdown(file.path) ? (
                <div className="file-views" role="group" aria-label="View">
                  <button type="button" aria-pressed={view === 'document' && !declined[file.path]} disabled={Boolean(declined[file.path])} onClick={() => chooseView('document')}>Document</button>
                  <button type="button" aria-pressed={view === 'source' || Boolean(declined[file.path])} onClick={() => chooseView('source')}>Source</button>
                </div>
              ) : null}
              {dirty ? <button type="button" className="button-soft" onClick={() => onReload(file.path)}>Revert</button> : null}
              <button type="button" className="button-soft" disabled={!dirty || !file.eol || file.conflict} onClick={() => onSave(file.path)}>Save</button>
              <button type="button" className="button-primary" onClick={() => onAttach(file.path)}>Add to conversation</button>
            </div>
          </header>
          {confirming === file.path ? (
            <div className="workflow-notice file-banner" role="alert">
              <span>{nameOf(file.path)} has unsaved changes.</span>
              <button type="button" className="button-soft" onClick={() => { setConfirming(undefined); onClose(file.path) }}>Discard changes</button>
              <button type="button" className="button-soft" onClick={() => setConfirming(undefined)}>Keep editing</button>
            </div>
          ) : null}
          {file.conflict ? (
            <div className="workflow-notice file-banner" role="alert">
              <span>This file changed on disk since you opened it. Your draft is kept until you choose.</span>
              <button type="button" className="button-soft" onClick={() => onSaveCopy(file.path)}>Save mine as a copy</button>
              <button type="button" className="button-soft" onClick={() => onReload(file.path)}>Reload from disk</button>
              <button type="button" className="button-soft" onClick={() => onOverwrite(file.path)}>Overwrite with mine</button>
            </div>
          ) : null}
          {!file.eol ? <p className="file-help">This file mixes line endings, so it is read-only here to keep them intact.</p> : null}
          <p className="file-help">
            {dirty ? 'Add to conversation sends the saved version; save first to include your changes.' : 'The file is read again when you send the message.'}
          </p>
          {declined[file.path] ? <p className="file-help">{declined[file.path]}</p> : null}
          {isMarkdown(file.path) && view === 'document' && !declined[file.path] ? (
            <div className="doc-host">
              <Suspense fallback={<p role="status">Loading document view…</p>}>
                <DocumentView key={file.path} draft={file.draft} readOnly={!file.eol}
                  onChange={(draft) => onChange(file.path, draft)}
                  onSave={(draft) => { if (file.eol && !file.conflict) onSave(file.path, draft) }}
                  onUnavailable={(reason) => setDeclined((all) => ({ ...all, [file.path]: reason }))} />
              </Suspense>
            </div>
          ) : (
            <textarea className="file-text" aria-label="File contents" value={file.draft} readOnly={!file.eol} spellCheck={false} {...PLAIN_TEXT}
              onChange={(e) => onChange(file.path, e.target.value)} onKeyDown={onKeyDown} />
          )}
        </>
      ) : !error ? (
        <div className="workflow-empty">
          <FileIcon />
          <h2>Keep the relevant file close.</h2>
          <p>Open a text file to edit it here, or add it to your conversation draft.</p>
        </div>
      ) : null}
    </main>
  )
}
