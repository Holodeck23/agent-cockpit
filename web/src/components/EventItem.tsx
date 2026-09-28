import type { ApprovalBehavior } from '../../../server/agents/types.ts'
import type { StoredEvent } from '../api.ts'

interface EventItemProps {
  stored: StoredEvent
  /** Approval ids still waiting for an answer. */
  openApprovals: ReadonlySet<string>
  onApprove: (requestId: string, behavior: ApprovalBehavior) => void
}

function summarizeInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const record = input as Record<string, unknown>
  const primary = record.command ?? record.file_path ?? record.path ?? record.pattern ?? record.url ?? record.description
  return typeof primary === 'string' ? primary : JSON.stringify(input).slice(0, 160)
}

export function EventItem({ stored, openApprovals, onApprove }: EventItemProps) {
  const { event } = stored
  switch (event.kind) {
    case 'user_text':
      return <div className="bubble user">{event.text}</div>
    case 'assistant_text':
      return <div className="bubble agent">{event.text}</div>
    case 'tool_use':
      return (
        <div className="tool">
          <span className="tool-name">{event.name}</span> <code>{summarizeInput(event.input)}</code>
        </div>
      )
    case 'tool_result':
      return event.isError ? <div className="tool tool-error">{event.content.slice(0, 300)}</div> : null
    case 'approval_request': {
      const open = openApprovals.has(event.requestId)
      return (
        <div className={`approval${open ? ' open' : ''}`}>
          <div>
            <strong>{event.toolName}</strong> wants to run <code>{summarizeInput(event.input)}</code>
          </div>
          {open ? (
            <div className="approval-actions">
              <button type="button" className="primary" onClick={() => onApprove(event.requestId, 'allow')}>
                Allow
              </button>
              <button type="button" onClick={() => onApprove(event.requestId, 'deny')}>
                Deny
              </button>
            </div>
          ) : null}
        </div>
      )
    }
    case 'approval_resolved':
      return <div className="meta-line">{event.behavior === 'allow' ? 'Allowed' : 'Denied'}</div>
    case 'result':
      return (
        <div className="meta-line">
          {event.ok ? 'Turn finished' : 'Turn failed'}
          {event.durationMs ? ` · ${(event.durationMs / 1000).toFixed(1)}s` : ''}
        </div>
      )
    case 'error':
      return <div className="tool tool-error">{event.message}</div>
    default:
      return null
  }
}
