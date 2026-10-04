import { lazy, Suspense, useDeferredValue, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { fileName, isDirty, lineCount, lineRange, spaceOf, wordCount, type OpenFile } from '../file-text.ts'
import { languageFor } from '../syntax-language.ts'
import { usePopover } from '../usePopover.ts'
import { ChevronDownIcon, FileIcon, SidebarIcon } from './icons.tsx'

interface FileEditorProps {
  files: readonly OpenFile[]
  active?: string
  error: string
  onSelect: (path: string) => void
  onClose: (path: string) => void
  /** Closes every tab but `keep` (or all); tabs with unsaved changes stay. Returns how many stayed. */
  onCloseMany: (keep?: string) => number
  onChange: (path: string, draft: string) => void
  /** `draft` is the text to save when an editor has just flushed it. */
  onSave: (path: string, draft?: string) => void
  onReload: (path: string) => void
  onOverwrite: (path: string) => void
  onSaveCopy: (path: string) => void
  onAttach: (path: string) => void
  /** Select these lines once the file is active (from a reply's path:line link). */
  jump?: Jump
  /** The file explorer beside the editor, which can be hidden for more room. */
  explorer: { readonly hidden: boolean; toggle(): void }
}

export interface Jump { readonly path: string; readonly line: number; readonly endLine?: number; readonly nonce: number }

// Guessed words must not land in files; the editor holds exactly what was typed.
const PLAIN_TEXT: Record<string, string> = { writingsuggestions: 'false', autoCorrect: 'off', autoCapitalize: 'off' }
const nameOf = fileName
const isMarkdown = (path: string): boolean => /\.(md|markdown)$/i.test(path)
// The rich editor is loaded only when a Markdown file is shown as a document.
const DocumentView = lazy(() => import('./DocumentView.tsx'))
// Syntax colours load the highlighter on demand too.
const HighlightRuns = lazy(() => import('./HighlightRuns.tsx'))
const VIEW_KEY = 'cockpit:markdown-view'
type MarkdownView = 'document' | 'source'
function loadView(): MarkdownView {
  try { return localStorage.getItem(VIEW_KEY) === 'source' ? 'source' : 'document' } catch { return 'document' }
}

export function FileEditor({ files, active, error, onSelect, onClose, onCloseMany, onChange, onSave, onReload, onOverwrite, onSaveCopy, onAttach, jump, explorer }: FileEditorProps) {
  const [confirming, setConfirming] = useState<string>()
  const [view, setView] = useState<MarkdownView>(loadView)
  // Files the Document view declined, with its reason; they stay in Source.
  const [declined, setDeclined] = useState<Readonly<Record<string, string>>>({})
  const chooseView = (next: MarkdownView): void => {
    setView(next)
    try { localStorage.setItem(VIEW_KEY, next) } catch { /* not remembered */ }
  }
  const file = files.find((f) => f.path === active)
  // Line numbers live in Source, so a jump into Markdown shows Source (without changing the saved choice).
  const jumping = jump && file && jump.path === file.path ? jump : undefined
  useEffect(() => { if (jumping && isMarkdown(jumping.path)) setView('source') }, [jumping])
  const dirty = file ? isDirty(file) : false
  const inDocuments = file ? spaceOf(file.path).space === 'documents' : false
  const [kept, setKept] = useState<string>()
  const closeMany = (keep?: string): void => {
    const stayed = onCloseMany(keep)
    setKept(stayed ? `${stayed} ${stayed === 1 ? 'tab has' : 'tabs have'} unsaved changes and stayed open.` : undefined)
  }

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
      <div className="file-tabs">
        <button type="button" className="file-tabs-button file-explorer-toggle" aria-pressed={!explorer.hidden}
          aria-label={explorer.hidden ? 'Show files' : 'Hide files'} title={explorer.hidden ? 'Show files' : 'Hide files'} onClick={explorer.toggle}><SidebarIcon /></button>
        <div className="file-tab-list" role="tablist" aria-label="Open files">
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
        {files.length > 0 ? <OpenTabsMenu files={files} active={active} onSelect={onSelect} onCloseMany={closeMany} /> : null}
      </div>
      {kept ? <div className="workflow-notice file-banner" role="status"><span>{kept}</span><button type="button" className="button-soft" onClick={() => setKept(undefined)}>OK</button></div> : null}
      {error ? <div className="workflow-notice" role="alert">{error}</div> : null}
      {file ? (
        <>
          <header>
            <div>
              <h2>{inDocuments ? <><span className="file-space">Your documents /</span> {nameOf(file.path)}</> : file.path}</h2>
              {file.eol === '\r\n' ? <span>Windows line endings</span> : null}
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
              {inDocuments ? null : <button type="button" className="button-primary" onClick={() => onAttach(file.path)}>Add to conversation</button>}
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
            {inDocuments ? 'Kept by Cockpit outside the repository, so agents do not see it unless you paste the text into a message.'
              : dirty ? 'Add to conversation sends the saved version; save first to include your changes.' : 'The file is read again when you send the message.'}
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
            <SourceText key={file.path} path={file.path} text={file.draft} readOnly={!file.eol} jump={jumping} onChange={(text) => onChange(file.path, text)} onKeyDown={onKeyDown} />
          )}
          <footer className="file-status" aria-label="File status">
            <span className={dirty ? 'file-status-dirty' : ''}>{file.conflict ? 'Changed on disk' : dirty ? 'Unsaved changes' : 'Saved'}</span>
            <span>{wordCount(file.draft).toLocaleString()} {wordCount(file.draft) === 1 ? 'word' : 'words'}</span>
            <span>{lineCount(file.draft).toLocaleString()} {lineCount(file.draft) === 1 ? 'line' : 'lines'}</span>
          </footer>
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

/** Source view: the text with line numbers beside it. Lines don't wrap, so the numbers stay level. */
function SourceText({ path, text, readOnly, jump, onChange, onKeyDown }: {
  path: string; text: string; readOnly: boolean; jump?: Jump; onChange: (text: string) => void; onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}) {
  const gutter = useRef<HTMLPreElement>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const colours = useRef<HTMLPreElement>(null)
  const language = languageFor(path)
  // Colouring trails typing slightly on large files; the textarea itself never waits.
  const shown = useDeferredValue(text)
  // Select the referenced lines and bring them a third of the way down the view.
  useEffect(() => {
    const el = area.current
    if (!el || !jump) return
    const { start, end } = lineRange(el.value, jump.line, jump.endLine)
    el.focus()
    el.setSelectionRange(start, end)
    const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight) || 22
    el.scrollTop = Math.max(0, (jump.line - 1) * lineHeight - el.clientHeight / 3)
    // Only a new jump applies; editing afterwards must not pull the view back.
  }, [jump?.nonce])
  const numbers = Array.from({ length: lineCount(text) }, (_, i) => i + 1).join('\n')
  return (
    <div className="file-source">
      <pre className="file-gutter" ref={gutter} aria-hidden>{numbers}</pre>
      <div className={`file-code${language ? ' highlighted' : ''}`}>
        {/* The textarea's text is transparent over this layer, so selection, undo and typing stay native. */}
        {language ? (
          <pre className="file-highlight" ref={colours} aria-hidden data-language={language}>
            <Suspense fallback={shown}><HighlightRuns text={shown} language={language} /></Suspense>{'\n'}
          </pre>
        ) : null}
        <textarea ref={area} className="file-text" aria-label="File contents" value={text} readOnly={readOnly} spellCheck={false} wrap="off" {...PLAIN_TEXT}
          onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown}
          onScroll={(e) => {
            const { scrollTop, scrollLeft } = e.currentTarget
            if (gutter.current) gutter.current.scrollTop = scrollTop
            if (colours.current) { colours.current.scrollTop = scrollTop; colours.current.scrollLeft = scrollLeft }
          }} />
      </div>
    </div>
  )
}

/** The ▾ at the end of the tab strip: every open tab, Close other tabs, Close all tabs. */
function OpenTabsMenu({ files, active, onSelect, onCloseMany }: {
  files: readonly OpenFile[]; active?: string; onSelect: (path: string) => void; onCloseMany: (keep?: string) => void
}) {
  const { open, setOpen, ref } = usePopover<HTMLDivElement>()
  const pick = (run: () => void): void => { setOpen(false); run() }
  return (
    <div className="file-tabs-menu" ref={ref}>
      <button type="button" className="file-tabs-button" aria-label="Open tabs" aria-expanded={open} onClick={() => setOpen(!open)}><ChevronDownIcon /></button>
      {open ? (
        <div className="menu" role="menu" aria-label="Open tabs">
          {files.map((f) => (
            <button key={f.path} type="button" role="menuitemradio" aria-checked={f.path === active} className="menu-item" title={f.path} onClick={() => pick(() => onSelect(f.path))}>
              <span>{nameOf(f.path)}</span>{isDirty(f) ? <span className="file-dirty" aria-label="unsaved">●</span> : null}
            </button>
          ))}
          <hr />
          <button type="button" role="menuitem" className="menu-item" disabled={!active || files.length < 2} onClick={() => pick(() => onCloseMany(active))}>Close other tabs</button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => pick(() => onCloseMany())}>Close all tabs</button>
        </div>
      ) : null}
    </div>
  )
}
