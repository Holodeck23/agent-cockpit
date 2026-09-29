import { useState, type ReactNode } from 'react'
import type { ThreadSummary } from '../api.ts'
import { filterConversations, type ListFilter } from '../conversation-meta.ts'
import { useSeen } from '../useSeen.ts'
import { ConversationCard } from './ConversationCard.tsx'
import { Bars, ChatIcon, PlusIcon, SearchIcon } from './icons.tsx'
import { ConversationsArt } from './illustrations.tsx'

interface ConversationListProps {
  threads: ThreadSummary[]
  selectedId: string | undefined
  onSelect: (id: string | undefined) => void
  /** Phone: conversations from every project, labelled with the project, and no New button. */
  projectName?: (path: string) => string
  canCreate?: boolean
}

const SHOW_COMPLETED_KEY = 'cockpit:show-completed'

function loadShowCompleted(): boolean {
  try {
    return localStorage.getItem(SHOW_COMPLETED_KEY) !== 'false'
  } catch {
    return true
  }
}

export function ConversationList({ threads, selectedId, onSelect, projectName, canCreate = true }: ConversationListProps) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ListFilter>('all')
  const [showCompleted, setShowCompleted] = useState(loadShowCompleted)
  const isUnread = useSeen(threads, selectedId)
  const { counts, rows } = filterConversations({ threads, query, showCompleted, isUnread }, filter)

  const toggleCompleted = (next: boolean): void => {
    setShowCompleted(next)
    try {
      localStorage.setItem(SHOW_COMPLETED_KEY, String(next))
    } catch {
      // not persisted
    }
  }

  const tab = (id: ListFilter, label: string, icon?: ReactNode) => (
    <button type="button" role="tab" aria-selected={filter === id} className="filter" onClick={() => setFilter(id)}>
      {icon}
      {label}
      <span className="filter-count">{counts[id]}</span>
    </button>
  )

  return (
    <nav className="list" aria-label="Conversations">
      <header className="list-head">
        <ConversationsArt className="list-art" />
        <h1>Conversations</h1>
        {canCreate ? (
          <button type="button" className="new-button" aria-label="New conversation" title="New conversation" onClick={() => onSelect(undefined)}>
            <PlusIcon />
          </button>
        ) : null}
      </header>
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
          <div className="list-empty">
            <span className="list-empty-icon">
              <ChatIcon />
            </span>
            <strong>{threads.length === 0 ? 'No conversations yet' : 'Nothing here'}</strong>
            <span>{threads.length === 0 ? 'Start something with your agent.' : 'Try another filter or search.'}</span>
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
