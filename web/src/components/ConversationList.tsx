import { useEffect, useState, type ReactNode } from 'react'
import { api } from '../api.ts'
import type { RowShows } from '../appearance.ts'
import type { ThreadSummary } from '../api.ts'
import { filterConversations, type ListFilter, emptyListState } from '../conversation-meta.ts'
import { useSeen } from '../useSeen.ts'
import { ConversationCard } from './ConversationCard.tsx'
import { Bars, ChatIcon, CheckIcon, PlusIcon, SearchIcon } from './icons.tsx'
import { ConversationsArt } from './illustrations.tsx'

interface ConversationListProps {
  threads: ThreadSummary[]
  selectedId: string | undefined
  onSelect: (id: string | undefined) => void
  /** Phone: conversations from every project, labelled with the project, and no New button. */
  projectName?: (path: string) => string
  canCreate?: boolean
  /** What each row shows besides the title (Appearance). */
  rowShows?: RowShows
  /** The workspace selector, between the title and the search (desktop, once a project has a worktree or is asked). */
  workspaceSlot?: ReactNode
}

const SHOW_COMPLETED_KEY = 'cockpit:show-completed'

function loadShowCompleted(): boolean {
  try {
    return localStorage.getItem(SHOW_COMPLETED_KEY) !== 'false'
  } catch {
    return true
  }
}

export function ConversationList({ threads, selectedId, onSelect, projectName, canCreate = true, rowShows, workspaceSlot }: ConversationListProps) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ListFilter>('all')
  const [showCompleted, setShowCompleted] = useState(loadShowCompleted)
  const isUnread = useSeen(threads, selectedId)
  // Full-text matches from the server, for the query they answer (A9).
  const [found, setFound] = useState<{ q: string; hits: ReadonlyMap<string, string> }>()
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) { setFound(undefined); return }
    let live = true
    const timer = setTimeout(() => {
      api.searchThreads(q).then(
        (hits) => { if (live) setFound({ q, hits: new Map(hits.map((h) => [h.id, h.excerpt])) }) },
        () => { if (live) setFound(undefined) },
      )
    }, 200)
    return () => { live = false; clearTimeout(timer) }
  }, [query])
  const textMatches = found && found.q === query.trim() ? found.hits : undefined
  const { counts, rows } = filterConversations({ threads, query, showCompleted, isUnread, textMatches: textMatches && new Set(textMatches.keys()) }, filter)
  const q = query.trim().toLowerCase()
  // A card found by its messages (not its title or preview) shows where the words are.
  const excerptOf = (t: ThreadSummary): string | undefined =>
    q && !t.meta.title.toLowerCase().includes(q) && !t.preview.toLowerCase().includes(q) ? textMatches?.get(t.meta.id) : undefined

  const toggleCompleted = (next: boolean): void => {
    setShowCompleted(next)
    try {
      localStorage.setItem(SHOW_COMPLETED_KEY, String(next))
    } catch {
      // not persisted
    }
  }

  // Each filter says why it is empty, and offers the way back (A10).
  const empty = emptyListState(filter, { total: threads.length, query })
  const tab = (id: ListFilter, label: string, icon?: ReactNode) => (
    <button type="button" role="tab" aria-selected={filter === id} className="filter" onClick={() => setFilter(id)}>
      {icon}
      {label}
      <span className="filter-count">{counts[id]}</span>
    </button>
  )

  return (
    <nav className={`list${workspaceSlot ? ' has-workspaces' : ''}`} aria-label="Conversations">
      <header className="list-head">
        <ConversationsArt className="list-art" />
        <h1>Conversations</h1>
        {canCreate ? (
          <button type="button" className="new-button" aria-label="New conversation" title="New conversation" onClick={() => onSelect(undefined)}>
            <PlusIcon />
          </button>
        ) : null}
      </header>
      {workspaceSlot}
      <label className="search">
        <SearchIcon />
        <input type="search" placeholder="Search conversations…" aria-label="Search conversations" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="filters" role="tablist" aria-label="Filter conversations">
        {tab('all', 'All')}
        {tab('needs', 'Needs you')}
        {tab('working', 'Working', <Bars live={counts.working > 0} />)}
        {tab('unread', 'Unread', <span className="unread-icon"><ChatIcon /></span>)}
      </div>
      <div className="cards">
        {rows.length === 0 ? (
          <div className="list-empty" role="status">
            <span className={`list-empty-icon${empty.done ? ' done' : ''}`}>
              {empty.done ? <CheckIcon /> : <ChatIcon />}
            </span>
            <strong>{empty.title}</strong>
            <span>{empty.detail}</span>
            {empty.back ? <button type="button" className="button-soft list-empty-back" onClick={() => setFilter('all')}>← View all conversations</button> : null}
          </div>
        ) : (
          rows.map((thread) => (
            <ConversationCard
              key={thread.meta.id}
              project={projectName?.(thread.meta.projectPath)}
              thread={thread}
              selected={thread.meta.id === selectedId}
              unread={isUnread(thread)}
              onSelect={onSelect}
              shows={rowShows}
              excerpt={excerptOf(thread)}
            />
          ))
        )}
      </div>
      <footer className="list-foot">
        <span>
          {rows.length} {rows.length === 1 ? 'conversation' : 'conversations'}
        </span>
        <label className="check">
          <input type="checkbox" checked={showCompleted} onChange={(e) => toggleCompleted(e.target.checked)} />
          Show completed
        </label>
      </footer>
    </nav>
  )
}
