import { useEffect, useMemo, useRef } from 'react'
import { openApprovals } from '../../../server/threads/status.ts'
import { api, type ThreadDetail } from '../api.ts'
import { AgentSwitcher } from './AgentSwitcher.tsx'
import { Composer } from './Composer.tsx'
import { EventItem } from './EventItem.tsx'
import { StatusChip } from './StatusChip.tsx'

interface ThreadViewProps {
  detail: ThreadDetail
  streaming: string
  onError: (message: string) => void
}

export function ThreadView({ detail, streaming, onError }: ThreadViewProps) {
  const { meta, status, events } = detail
  const running = status === 'working' || status === 'needs_input'
  const open = useMemo(() => new Set(running ? openApprovals(events) : []), [events, running])
  const bottom = useRef<HTMLDivElement>(null)
  const usage = [...events].reverse().find((e) => e.event.kind === 'usage')?.event

  useEffect(() => {
    void bottom.current?.scrollIntoView({ block: 'end' })
  }, [events.length, streaming])

  const guard = (action: Promise<unknown>): void => {
    action.catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
  }

  return (
    <main className="thread">
      <header className="thread-head">
        <div>
          <h1>{meta.title}</h1>
          <p className="thread-sub">
            {meta.settings.agent} · {meta.settings.model ?? 'default model'} · {meta.settings.permissionMode} ·{' '}
            <span title={meta.projectPath}>{meta.projectPath}</span>
          </p>
        </div>
        <div className="thread-actions">
          {usage?.kind === 'usage' ? (
            <span className="usage" title={usage.resetsAt ? `resets ${new Date(usage.resetsAt * 1000).toLocaleTimeString()}` : undefined}>
              5h limit: {usage.status}
            </span>
          ) : null}
          <AgentSwitcher key={`${meta.id}-${meta.settings.agent}-${meta.settings.model ?? ''}`} meta={meta} disabled={running} onError={onError} />
          <StatusChip status={status} />
          {running ? (
            <button type="button" onClick={() => guard(api.interrupt(meta.id))}>
              Stop
            </button>
          ) : (
            <button type="button" onClick={() => guard(api.setCompleted(meta.id, !meta.completed))}>
              {meta.completed ? 'Reopen' : 'Mark complete'}
            </button>
          )}
        </div>
      </header>
      <div className="events">
        {events.map((stored, index) => (
          <EventItem
            key={`${stored.ts}-${index}`}
            stored={stored}
            openApprovals={open}
            onApprove={(requestId, behavior) => guard(api.approve(meta.id, requestId, behavior))}
          />
        ))}
        {streaming ? <div className="bubble agent streaming">{streaming}</div> : null}
        <div ref={bottom} />
      </div>
      <Composer
        draftKey={meta.id}
        placeholder={running ? 'Add to the current turn…' : 'Reply…'}
        onSubmit={(text) => api.send(meta.id, text).then(() => undefined)}
      />
    </main>
  )
}
