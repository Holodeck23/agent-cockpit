import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { api, type BaseFile, type ChangedFile, type FileDiff } from '../api.ts'
import { lineStillMatches, lineTarget, omittedText, shortRevision } from '../changes.ts'

// One file's bounded diff (J4). A right-side line opens the current file in Files at that line,
// once its text is confirmed still there; a removed line opens the base revision read-only.

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; diff: FileDiff }

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function DiffPane({ projectPath, workspaceId, file, onOpenFile, onRefresh }: {
  projectPath: string
  workspaceId?: string
  file: ChangedFile
  onOpenFile: (target: { path: string; line: number }) => void
  onRefresh: () => void
}) {
  const [state, setState] = useState<State>({ kind: 'loading' })
  // Set when a clicked line is no longer what the diff showed: the file changed since it was read.
  const [stale, setStale] = useState(false)
  const [history, setHistory] = useState<{ file: BaseFile; line: number }>()
  useEffect(() => {
    let live = true
    api.gitDiff(projectPath, file.path, workspaceId).then((diff) => { if (live) setState({ kind: 'ready', diff }) }, (e: unknown) => { if (live) setState({ kind: 'error', message: message(e) }) })
    return () => { live = false }
  }, [projectPath, workspaceId, file.path])

  if (state.kind === 'loading') return <div className="diff-pane"><p className="changes-note">Reading the diff…</p></div>
  if (state.kind === 'error') {
    return (
      <div className="diff-pane">
        <p className="changes-note changes-error" role="alert">{state.message.includes('has not changed') ? 'This file changed since the list was read.' : state.message}</p>
        <button type="button" className="button-soft" onClick={onRefresh}>Refresh</button>
      </div>
    )
  }
  const { diff } = state
  const omitted = omittedText(diff)

  const onLine = async (event: MouseEvent<HTMLDivElement>): Promise<void> => {
    const index = Number((event.target as HTMLElement).closest<HTMLElement>('[data-line]')?.dataset.line)
    const line = Number.isInteger(index) ? diff.lines[index] : undefined
    const target = line ? lineTarget(diff, line) : undefined
    if (!target) return
    if (target.kind === 'historical') {
      try { setHistory({ file: await api.gitBase(projectPath, target.path, workspaceId), line: target.line }) } catch (e) { setState({ kind: 'error', message: message(e) }) }
      return
    }
    // Verified against the file as it is now, so the editor never lands on an unrelated line.
    const read = await api.readFile(projectPath, target.path, workspaceId).catch(() => undefined)
    if (!read || !lineStillMatches(read.text, target.line, target.text)) { setStale(true); return }
    onOpenFile({ path: target.path, line: target.line })
  }

  return (
    <div className="diff-pane">
      <div className="diff-title">
        <strong>{diff.path}</strong>
        <span>{diff.base === 'empty' ? 'against an empty base' : `against HEAD ${shortRevision(diff.head ?? 'empty')}`}</span>
      </div>
      {stale ? (
        <div className="changes-warn" role="alert">
          This file changed since it was read, so that line may have moved.
          <button type="button" className="button-soft" onClick={onRefresh}>Refresh</button>
        </div>
      ) : null}
      {diff.status === 'conflicted' ? <p className="changes-warn">Conflicted: the text below includes the conflict markers in the file now.</p> : null}
      {omitted ? <p className="changes-note">{omitted}</p> : null}
      {diff.lines.length ? (
        <div className="diff-lines" role="table" aria-label={`Diff of ${diff.path}`} onClick={(e) => void onLine(e)}>
          {diff.lines.map((line, i) => (
            <div key={i} role="row" data-line={i} className={`diff-line diff-${line.kind}`}
              title={line.kind === 'del' ? `Open line ${line.old} as it was at ${shortRevision(diff.head ?? 'empty')}` : line.kind === 'hunk' ? undefined : diff.status === 'deleted' ? undefined : `Open line ${line.new} in Files`}>
              <span className="diff-num" aria-hidden="true">{line.old ?? ''}</span>
              <span className="diff-num" aria-hidden="true">{line.new ?? ''}</span>
              <span className="diff-sign" aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : line.kind === 'hunk' ? '' : ' '}</span>
              <code className="diff-text">{line.text}</code>
            </div>
          ))}
        </div>
      ) : null}
      {diff.truncated ? <p className="changes-warn">The diff is longer than Cockpit shows here; the rest is left out.</p> : null}
      {history ? <HistoricalView file={history.file} line={history.line} onClose={() => setHistory(undefined)} /> : null}
    </div>
  )
}

/** The base revision's copy of a file, read-only and labelled with that revision. */
function HistoricalView({ file, line, onClose }: { file: BaseFile; line: number; onClose: () => void }) {
  const target = useRef<HTMLDivElement>(null)
  useEffect(() => { target.current?.scrollIntoView({ block: 'center' }) }, [file, line])
  const label = `${file.path} at ${shortRevision(file.revision)} (read-only)`
  return (
    <div className="diff-history" role="region" aria-label={label}>
      <div className="diff-title">
        <strong>{label}</strong>
        <button type="button" className="button-soft" onClick={onClose}>Close</button>
      </div>
      {file.text === undefined ? (
        <p className="changes-note">{file.omitted === 'too-large' ? 'Too large to show here.' : file.omitted === 'binary' ? 'A binary file.' : 'Not in the base revision.'}</p>
      ) : (
        <div className="diff-lines">
          {file.text.replace(/\n$/, '').split('\n').map((text, i) => (
            <div key={i} ref={i + 1 === line ? target : undefined} className={`diff-line diff-ctx${i + 1 === line ? ' diff-target' : ''}`}>
              <span className="diff-num">{i + 1}</span>
              <code className="diff-text">{text}</code>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
