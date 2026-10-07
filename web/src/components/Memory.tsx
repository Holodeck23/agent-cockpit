import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, type MemoryEntry, type Project, type ThreadSummary } from '../api.ts'
import { MemoryIcon } from './icons.tsx'

interface MemoryProps {
  project: Project | undefined
  /** For naming the conversation an entry came from. */
  threads: readonly ThreadSummary[]
  onError: (message: string) => void
  onOpenThread: (id: string) => void
}

const MAX = 1000
const day = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** What Cockpit remembers across conversations: this project's notes and your everywhere preferences. */
export function Memory({ project, threads, onError, onOpenThread }: MemoryProps) {
  const [loadError, setLoadError] = useState('')
  const [entries, setEntries] = useState<MemoryEntry[]>()
  const [scope, setScope] = useState<'project' | 'everywhere'>('project')
  const [view, setView] = useState<'all' | 'project' | 'everywhere'>('all')
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string }>()
  const [confirmClear, setConfirmClear] = useState(false)
  const projectPath = project?.path
  const reload = useCallback((): void => {
    if (projectPath) api.listMemory(projectPath).then(
      (rows) => { setEntries(rows); setLoadError('') },
      (e: unknown) => { setEntries(undefined); setLoadError(message(e)) },
    )
  }, [projectPath, onError])
  useEffect(reload, [reload])
  const run = (action: () => Promise<unknown>): void => { action().then(reload, (e: unknown) => { onError(message(e)); reload() }) }

  if (!project) return <main className="workflow-empty"><MemoryIcon /><h1>Memory</h1><p>Open a project to see what Cockpit remembers.</p></main>
  if (loadError) return <main className="memory"><h1>Memory unavailable</h1><p role="alert">{loadError}</p><button type="button" className="button-soft" onClick={reload}>Try again</button></main>
  const add = (event: FormEvent): void => {
    event.preventDefault()
    run(async () => { await api.addMemory(project.path, scope, draft); setDraft('') })
  }
  const origin = (entry: MemoryEntry): string => {
    if (entry.source.kind === 'you') return 'from you'
    const { threadId } = entry.source
    const title = threads.find((t) => t.meta.id === threadId)?.meta.title
    return title ? `from “${title}”` : 'from a conversation'
  }
  const section = (which: 'project' | 'everywhere', heading: string, empty: string) => {
    const rows = entries?.filter((e) => e.scope === which) ?? []
    return (
      <section className="memory-section" aria-label={heading}>
        <h2>{heading} <span>{rows.length}</span></h2>
        {entries && rows.length === 0 ? <p className="memory-empty">{empty}</p> : null}
        <ul>
          {rows.map((entry) => (
            <li key={entry.id} className={`memory-entry${editing?.id === entry.id ? ' editing' : ''}`}>
              {editing?.id === entry.id ? (
                <form onSubmit={(e) => { e.preventDefault(); run(async () => { await api.updateMemory(entry.id, editing.text); setEditing(undefined) }) }}>
                  <textarea aria-label="Edit memory" maxLength={MAX} rows={2} value={editing.text} autoFocus onChange={(e) => setEditing({ id: entry.id, text: e.target.value })} />
                  <div className="memory-actions">
                    <button type="submit" className="button-primary" disabled={!editing.text.trim()}>Save</button>
                    <button type="button" className="button-soft" onClick={() => setEditing(undefined)}>Cancel</button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="memory-entry-head"><p>{entry.text}</p>
                    <span className="memory-scope-pill">{entry.scope === 'project' ? 'This project' : 'Everywhere'}</span>
                  </div>
                  <div className="memory-meta">
                    <span>{day(entry.updatedAt)} · {entry.source.kind === 'conversation' && threads.some((t) => t.meta.id === (entry.source as { threadId: string }).threadId)
                      ? <button type="button" className="memory-link" onClick={() => onOpenThread((entry.source as { threadId: string }).threadId)}>{origin(entry)}</button>
                      : origin(entry)}</span>
                    <span className="memory-actions">
                      <button type="button" className="button-soft" aria-label={`Edit “${entry.text.slice(0, 40)}”`} onClick={() => setEditing({ id: entry.id, text: entry.text })}>Edit</button>
                      <button type="button" className="button-soft" aria-label={`Delete “${entry.text.slice(0, 40)}”`} onClick={() => run(() => api.deleteMemory(entry.id))}>Delete</button>
                    </span>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>
    )
  }

  return (
    <main className="memory">
      <header>
        <span className="workflow-kicker">{project.name}</span>
        <h1>Memory</h1>
        <p>Short notes that carry from one conversation to the next. Agents search them only when a task needs what was decided before, and ask you before adding one. Notes can go out of date: agents are told to check them, and you can edit or delete any of them here.</p>
      </header>
      <form className="memory-add" onSubmit={add}>
        <textarea aria-label="New memory" placeholder="For example: Deploys go to staging first; production needs a tagged release." maxLength={MAX} rows={2}
          value={draft} onChange={(e) => setDraft(e.target.value)} />
        <div className="memory-actions">
          <div className="segmented" role="radiogroup" aria-label="Keep it for">
            <button type="button" role="radio" aria-checked={scope === 'project'} onClick={() => setScope('project')}>This project</button>
            <button type="button" role="radio" aria-checked={scope === 'everywhere'} onClick={() => setScope('everywhere')}>Everywhere</button>
          </div>
          <button type="submit" className="button-primary" disabled={!draft.trim()}>Remember</button>
        </div>
      </form>
      <div className="memory-filters" role="tablist" aria-label="Filter memory">
        {([['all', 'All', entries?.length ?? 0], ['project', 'This project', entries?.filter((e) => e.scope === 'project').length ?? 0],
          ['everywhere', 'Everywhere', entries?.filter((e) => e.scope === 'everywhere').length ?? 0]] as const).map(([id, label, count]) => (
          <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)}>{label} <span>{count}</span></button>
        ))}
      </div>
      {view !== 'everywhere' ? section('project', 'This project', 'Nothing remembered for this project yet.') : null}
      {view !== 'project' ? section('everywhere', 'Everywhere', 'No preferences yet. Notes kept everywhere reach every project.') : null}
      <footer className="memory-foot">
        {confirmClear ? (
          <span className="memory-confirm" role="alertdialog" aria-label="Clear this project's memory">
            Forget everything remembered for {project.name}? Everywhere notes stay.
            <button type="button" className="button-soft" onClick={() => setConfirmClear(false)}>Cancel</button>
            <button type="button" className="button-danger" onClick={() => { setConfirmClear(false); run(() => api.clearMemory(project.path)) }}>Clear</button>
          </span>
        ) : (
          <button type="button" className="button-quiet-danger" disabled={!entries?.some((e) => e.scope === 'project')} onClick={() => setConfirmClear(true)}>Clear this project’s memory…</button>
        )}
        <span>Kept by Cockpit on this Mac, never in the project folder.</span>
      </footer>
    </main>
  )
}
