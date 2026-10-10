import type { ThreadSummary } from '../api.ts'
import { DEFAULT_APPEARANCE, rowMeta, type RowShows } from '../appearance.ts'
import { agentLabel, dayLabel, shownStatus } from '../conversation-meta.ts'
import { ChatIcon } from './icons.tsx'
import { StatusPill } from './StatusPill.tsx'

interface ConversationCardProps {
  thread: ThreadSummary
  selected: boolean
  unread: boolean
  onSelect: (id: string) => void
  /** Shown when the list mixes projects (the phone). */
  project?: string
  /** What the row shows besides the title (Appearance). */
  shows?: RowShows
  /** While searching: where the words are in its messages, shown instead of the preview. */
  excerpt?: string
}

export function ConversationCard({ thread, selected, unread, onSelect, project, shows = DEFAULT_APPEARANCE.rows, excerpt }: ConversationCardProps) {
  const classes = ['card', selected ? 'selected' : '', thread.meta.completed ? 'completed' : '', unread ? 'unread' : '']
  return (
    <button
      type="button"
      className={classes.filter(Boolean).join(' ')}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect(thread.meta.id)}
    >
      <span className="card-title">
        {unread ? <span className="unread-dot" aria-label="Unread" /> : null}
        {thread.meta.title}
      </span>
      {excerpt ? <span className="card-preview card-excerpt">{excerpt}</span> : shows.preview && thread.preview ? <span className="card-preview">{thread.preview}</span> : null}
      <span className="card-foot">
        <span className="card-meta">
          {rowMeta({ project, agent: agentLabel(thread.meta.settings.agent), date: dayLabel(thread.lastActivityAt) }, shows)}
        </span>
        <span className="card-count" aria-label={`${thread.messageCount} messages`}>
          <ChatIcon />
          {thread.messageCount}
        </span>
        <StatusPill status={shownStatus(thread)} turn={thread.turn} />
      </span>
    </button>
  )
}
