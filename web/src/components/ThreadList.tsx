import type { ThreadSummary } from '../api.ts'
import { StatusChip } from './StatusChip.tsx'

interface ThreadListProps {
  threads: ThreadSummary[]
  selectedId: string | undefined
  onSelect: (id: string | undefined) => void
}

function projectName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

export function ThreadList({ threads, selectedId, onSelect }: ThreadListProps) {
  const needsYou = threads.filter((t) => t.status === 'needs_input').length
  const working = threads.filter((t) => t.status === 'working').length
  const groups = Map.groupBy(threads, (t) => t.meta.projectPath)

  return (
    <nav className="sidebar" aria-label="Threads">
      <div className="sidebar-head">
        <strong className="brand">cockpit</strong>
        <button type="button" className="primary" onClick={() => onSelect(undefined)}>
          New thread
        </button>
      </div>
      <p className="tally">
        {working} working · {needsYou} need you · {threads.length} total
      </p>
      {[...groups.entries()].map(([path, items]) => (
        <section key={path} className="project">
          <h2 title={path}>{projectName(path)}</h2>
          <ul>
            {items.map((t) => (
              <li key={t.meta.id}>
                <button
                  type="button"
                  className={`thread-row${t.meta.id === selectedId ? ' selected' : ''}${t.meta.completed ? ' completed' : ''}`}
                  onClick={() => onSelect(t.meta.id)}
                >
                  <span className="thread-title">{t.meta.title}</span>
                  <StatusChip status={t.status} />
                  <span className="thread-preview">{t.preview}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  )
}
