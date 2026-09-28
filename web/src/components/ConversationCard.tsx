import type { ThreadSummary } from '../api.ts'
import { agentLabel, dayLabel, tagFor, toneFor } from '../conversation-meta.ts'
import { ChatIcon } from './icons.tsx'
import { StatusPill } from './StatusPill.tsx'

interface ConversationCardProps {
  thread: ThreadSummary
  selected: boolean
  unread: boolean
  onSelect: (id: string) => void
}

export function ConversationCard({ thread, selected, unread, onSelect }: ConversationCardProps) {
  const tag = tagFor(thread.meta.title)
  const classes = ['card', selected ? 'selected' : '', thread.meta.completed ? 'completed' : '', unread ? 'unread' : '']
  return (
    <button
      type="button"
      className={classes.filter(Boolean).join(' ')}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect(thread.meta.id)}
    >
      <span className="card-top">
        <span className={`tag tag-${toneFor(tag)}`}>{tag}</span>
        <span className="card-count" aria-label={`${thread.messageCount} messages`}>
          {unread ? <span className="unread-dot" aria-label="Unread" /> : null}
          <ChatIcon />
          {thread.messageCount}
        </span>
      </span>
      <span className="card-title">{thread.meta.title}</span>
      <span className="card-foot">
        <span className="card-meta">
          {agentLabel(thread.meta.settings.agent)} · {dayLabel(thread.lastActivityAt)}
        </span>
        <StatusPill status={thread.status} />
      </span>
    </button>
  )
}
