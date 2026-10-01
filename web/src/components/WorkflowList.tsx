import { describeCalendar } from '../../../server/workflows/calendar.ts'
import { useMemo, useState } from 'react'
import type { Project, Workflow } from '../api.ts'
import { displayTitle, filterWorkflows, groupByCollection, type WorkflowView } from '../workflow-list.ts'
import { WORKFLOW_STARTERS, type WorkflowStarter } from '../workflow-starters.ts'
import { PlusIcon, SearchIcon, WorkflowIcon } from './icons.tsx'

interface WorkflowListProps {
  project: Project
  rows: readonly Workflow[]
  loaded: boolean
  selected: string | undefined
  busy: boolean
  onSelect: (id: string) => void
  onCreate: () => void
  onAddStarter: (starter: WorkflowStarter) => void
}

const VIEWS: ReadonlyArray<{ id: WorkflowView; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'manual', label: 'Manual' },
]

export function WorkflowList({ project, rows, loaded, selected, busy, onSelect, onCreate, onAddStarter }: WorkflowListProps) {
  const [query, setQuery] = useState('')
  const [view, setView] = useState<WorkflowView>('all')
  const [startersOpen, setStartersOpen] = useState(false)
  const groups = useMemo(() => groupByCollection(filterWorkflows(rows, query, view)), [rows, query, view])
  const count = (id: WorkflowView): number => filterWorkflows(rows, '', id).length
  const shown = groups.reduce((n, g) => n + g.rows.length, 0)
  const taken = useMemo(() => new Set(rows.map((w) => w.name)), [rows])

  return (
    <nav className="workflow-list" aria-label="Saved workflows">
      <header>
        <div><span className="workflow-kicker">{project.name}</span><h1>Workflows</h1></div>
        <button type="button" className="new-button" aria-label="New workflow" disabled={busy} onClick={onCreate}><PlusIcon /></button>
      </header>
      <p className="workflow-intro">Save a job once. Run it when you need it.</p>
      <label className="workflow-search">
        <SearchIcon />
        <input type="search" aria-label="Search workflows" placeholder="Search workflows…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="workflow-views" role="tablist" aria-label="Show">
        {VIEWS.map((v) => (
          <button key={v.id} type="button" role="tab" aria-selected={view === v.id} onClick={() => setView(v.id)}>
            {v.label} <span>{count(v.id)}</span>
          </button>
        ))}
      </div>
      {!loaded ? <p role="status">Loading workflows…</p> : null}
      {loaded && rows.length === 0 ? (
        <div className="workflow-list-empty"><WorkflowIcon /><strong>No workflows yet</strong><span>Start from one of the starters below, or write your own.</span></div>
      ) : null}
      {loaded && rows.length > 0 && shown === 0 ? <p className="workflow-none" role="status">No workflows match.</p> : null}
      {groups.map((group) => (
        <section key={group.collection ?? '(none)'} className="workflow-group" aria-label={group.collection ?? 'Other workflows'}>
          {group.collection || groups.length > 1 ? <h2 className="workflow-group-title">{group.collection ?? 'Other'}</h2> : null}
          {group.rows.map((w) => (
            <button type="button" key={w.id} className={`workflow-row ${selected === w.id ? 'selected' : ''}`}
              aria-current={selected === w.id ? 'true' : undefined} disabled={busy} onClick={() => onSelect(w.id)}>
              <strong>{displayTitle(w)}</strong>
              <code className="workflow-slug">@workflow:{w.name}</code>
              <span>{w.prompt.slice(0, 100)}</span>
              <small className={w.lastError ? 'workflow-error' : ''}>{w.lastError ? 'Needs attention' : w.enabled ? (w.calendar ? describeCalendar(w.calendar) : `Every ${w.intervalMinutes} min`) : 'Manual / paused'}</small>
            </button>
          ))}
        </section>
      ))}
      <section className="workflow-starters" aria-label="Starters">
        <button type="button" className="workflow-starters-toggle" aria-expanded={startersOpen} onClick={() => setStartersOpen(!startersOpen)}>
          Starters <span>{WORKFLOW_STARTERS.length}</span>
        </button>
        {startersOpen ? (
          <ul>
            {WORKFLOW_STARTERS.map((starter) => {
              const added = taken.has(starter.name)
              return (
                <li key={starter.name} className="workflow-starter">
                  <div>
                    <strong>{starter.title}</strong>
                    <span>{starter.summary}</span>
                  </div>
                  <button type="button" disabled={busy} aria-label={`Add ${starter.title}`} onClick={() => onAddStarter(starter)}>
                    {added ? 'Add another' : 'Add'}
                  </button>
                </li>
              )
            })}
            <li className="workflow-starter-note">Added starters are saved paused, never run or scheduled until you choose to.</li>
          </ul>
        ) : null}
      </section>
      <footer>Schedules run while Cockpit is open. Missed runs resume once, without a backlog.</footer>
    </nav>
  )
}
