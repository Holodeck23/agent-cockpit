import { useCallback, useEffect, useState } from 'react'
import { api, type ChangedFile, type Changes, type NoRepository, type RunChanges } from '../api.ts'
import { baseLine, RUN_CHANGE_WORD, stagingWord, statusLetter, statusWord } from '../changes.ts'
import { DiffPane } from './DiffPane.tsx'

// J4: Changes, read-only. Working changes is everything uncommitted in the folder, whoever made
// it; This run compares the folder before and after one run. Neither is "what the agent did".
// Refreshes when opened, on Refresh, and when the conversation's run ends; never on a timer.

type Tab = 'working' | 'run'
type Load<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; data: T }

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const time = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export function ChangesView({ projectPath, threadId, runId, refreshKey, onOpenFile, onClose }: {
  projectPath: string
  threadId: string
  /** The run a result card opened this for; without one only Working changes is offered. */
  runId?: string
  /** Changes when the conversation's run ends, which refreshes the view. */
  refreshKey: string
  onOpenFile: (target: { path: string; line: number }) => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<Tab>(runId ? 'run' : 'working')
  const [changes, setChanges] = useState<Load<Changes | NoRepository>>({ state: 'loading' })
  const [run, setRun] = useState<Load<RunChanges>>({ state: 'loading' })
  const [selected, setSelected] = useState<string>()
  const [reloads, setReloads] = useState(0)
  const refresh = useCallback(() => setReloads((n) => n + 1), [])
  useEffect(() => { setTab(runId ? 'run' : 'working') }, [runId])

  useEffect(() => {
    let live = true
    setChanges((c) => (c.state === 'ready' ? c : { state: 'loading' }))
    api.gitChanges(projectPath).then((data) => { if (live) setChanges({ state: 'ready', data }) }, (e: unknown) => { if (live) setChanges({ state: 'error', message: message(e) }) })
    return () => { live = false }
  }, [projectPath, reloads, refreshKey])
  useEffect(() => {
    if (!runId) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    // A run that just ended is still being observed for a moment: ask again, briefly and boundedly.
    const load = (tries: number): void => {
      api.gitRun(threadId, runId).then((data) => {
        if (!live) return
        setRun({ state: 'ready', data })
        if (data.state === 'running' && tries > 0) timer = setTimeout(() => load(tries - 1), 1000)
      }, (e: unknown) => { if (live) setRun({ state: 'error', message: message(e) }) })
    }
    load(30)
    return () => { live = false; if (timer) clearTimeout(timer) }
  }, [threadId, runId, reloads, refreshKey])

  const files = changes.state === 'ready' && changes.data.repo ? changes.data.files : []
  // A selection that is no longer among the changes falls back to the first file.
  const current = files.find((f) => f.path === selected) ?? files[0]

  return (
    <section className="changes" aria-label="Changes">
      <header className="changes-head">
        <div className="changes-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'working'} onClick={() => setTab('working')}>Working changes</button>
          {runId ? <button type="button" role="tab" aria-selected={tab === 'run'} onClick={() => setTab('run')}>This run</button> : null}
        </div>
        <button type="button" className="button-soft" onClick={refresh}>Refresh</button>
        <button type="button" className="button-soft" onClick={onClose}>Close</button>
      </header>
      {tab === 'run' ? (
        <RunPanel run={run} onShowFile={(path) => { setSelected(path); setTab('working') }} />
      ) : changes.state === 'loading' ? (
        <p className="changes-note">Reading changes…</p>
      ) : changes.state === 'error' ? (
        <p className="changes-note changes-error" role="alert">{changes.message}</p>
      ) : !changes.data.repo ? (
        <div className="changes-note" role="status">
          <strong>Git changes unavailable</strong>
          <p>This folder is not a Git repository, so there is no list of changed files. Conversations, files and previews still work.</p>
        </div>
      ) : (
        <>
          <div className="changes-meta">
            <span>{baseLine(changes.data)}</span>
            <span>Read at {time(changes.data.observedAt)}</span>
          </div>
          <p className="changes-scope">Everything uncommitted in this folder, including changes made before this conversation or by other conversations.</p>
          {changes.data.conflicted ? <p className="changes-warn" role="status">{changes.data.conflicted} file{changes.data.conflicted === 1 ? ' has' : 's have'} a merge conflict. Resolve it in your editor or terminal; Cockpit only shows it.</p> : null}
          {files.length === 0 ? (
            <p className="changes-note">No uncommitted changes.</p>
          ) : (
            <div className="changes-body">
              <div className="changes-files">
                {changes.data.truncated ? <p className="changes-warn">Showing {files.length} of {changes.data.total} changed paths.</p> : null}
                <ul aria-label="Changed files">
                  {files.map((f) => <FileItem key={f.path} file={f} selected={f.path === current?.path} onSelect={() => setSelected(f.path)} />)}
                </ul>
              </div>
              {current ? <DiffPane key={`${current.path}:${reloads}:${refreshKey}`} projectPath={projectPath} file={current} onOpenFile={onOpenFile} onRefresh={refresh} /> : null}
            </div>
          )}
        </>
      )}
    </section>
  )
}

function FileItem({ file, selected, onSelect }: { file: ChangedFile; selected: boolean; onSelect: () => void }) {
  const staging = stagingWord(file)
  const extra = file.submodule ? 'Submodule' : file.symlink ? 'Link' : file.binary ? 'Binary' : undefined
  return (
    <li>
      <button type="button" className={`changes-file${selected ? ' selected' : ''}`} aria-current={selected || undefined} onClick={onSelect} title={statusWord(file)}>
        <span className={`changes-status status-${file.status}`} aria-label={statusWord(file)}>{statusLetter(file)}</span>
        <span className="changes-path">{file.oldPath ? <><span className="changes-old">{file.oldPath}</span> → </> : null}{file.path}</span>
        <span className="changes-counts">
          {extra ? <span className="changes-tag">{extra}</span> : null}
          {staging ? <span className="changes-tag">{staging}</span> : null}
          {file.additions !== undefined ? <span className="changes-add">+{file.additions}</span> : null}
          {file.deletions !== undefined ? <span className="changes-del">−{file.deletions}</span> : null}
        </span>
      </button>
    </li>
  )
}

function RunPanel({ run, onShowFile }: { run: Load<RunChanges>; onShowFile: (path: string) => void }) {
  if (run.state === 'loading') return <p className="changes-note">Reading this run’s observations…</p>
  if (run.state === 'error') return <p className="changes-note changes-error" role="alert">{run.message}</p>
  const view = run.data
  if (view.state === 'unrecorded') return <p className="changes-note">Cockpit has no before/after record for this run (it ran before Cockpit kept them, or the folder could not be read). Working changes still shows the folder as it is now.</p>
  if (view.state === 'running') return <p className="changes-note">This run is still working, or has just ended and is being compared.</p>
  if (view.state === 'incomplete') return <p className="changes-note">This run has a “before” record but no “after”: Cockpit stopped, or the folder could not be read, before it finished. Working changes shows the folder as it is now.</p>
  const comparison = view.comparison!
  const shown = comparison.files.filter((f) => f.change !== 'unchanged')
  const untouched = comparison.files.length - shown.length
  return (
    <div className="changes-run">
      <div className="changes-meta">
        <span>Before {time(view.before!.observedAt)} · after {time(view.after!.observedAt)}</span>
        {comparison.headMoved ? <span>HEAD {view.before!.head?.slice(0, 8) ?? 'none'} → {view.after!.head?.slice(0, 8) ?? 'none'}</span> : null}
      </div>
      <p className="changes-scope">What changed in this folder while the run was working. Cockpit can’t tell who made each change.</p>
      {comparison.uncertain.length ? (
        <ul className="changes-uncertain" aria-label="Why this may not be exact">
          {comparison.uncertain.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      ) : null}
      {shown.length === 0 ? <p className="changes-note">No file in this folder changed during this run.</p> : (
        <ul aria-label="Changed during this run">
          {shown.map((f) => (
            <li key={f.path}>
              <button type="button" className="changes-file" onClick={() => onShowFile(f.path)} disabled={f.change === 'cleaned'} title={f.change === 'cleaned' ? 'Not changed now' : 'Show its current diff'}>
                <span className="changes-path">{f.path}</span>
                <span className="changes-counts"><span className={`changes-tag run-${f.change}`}>{RUN_CHANGE_WORD[f.change]}</span></span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {view.preexisting ? <p className="changes-scope">{view.preexisting} file{view.preexisting === 1 ? ' was' : 's were'} already changed when the run started{untouched ? `; ${untouched} of them stayed as they were` : ''}.</p> : null}
    </div>
  )
}
