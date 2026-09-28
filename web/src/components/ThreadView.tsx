import { useEffect, useMemo, useRef } from 'react'
import { openApprovals } from '../../../server/threads/status.ts'
import { api, type ThreadDetail } from '../api.ts'
import { STATUS_LABEL } from '../conversation-meta.ts'
import { native } from '../native.ts'
import { buildTranscript } from '../transcript.ts'
import { AgentPicker, settingsFromChoice, type AgentChoice } from './AgentPicker.tsx'
import { Composer } from './Composer.tsx'
import { Bars, CheckIcon, FileIcon, StopIcon } from './icons.tsx'
import { ThreadMenu } from './ThreadMenu.tsx'
import { TranscriptView } from './TranscriptView.tsx'

interface ThreadViewProps {
  detail: ThreadDetail
  streaming: string
  onError: (message: string) => void
}

/** "…/threads/1a2b3c4d/messages.md": enough to recognise, short enough to fit. */
function shortPath(path: string): string {
  const parts = path.split('/')
  const id = parts.at(-2) ?? ''
  return `…/threads/${id.slice(0, 8)}/${parts.at(-1) ?? ''}`
}

export function ThreadView({ detail, streaming, onError }: ThreadViewProps) {
  const { meta, status, events, transcriptPath } = detail
  const running = status === 'working' || status === 'needs_input'
  const open = useMemo(() => new Set(running ? openApprovals(events) : []), [events, running])
  const items = useMemo(() => buildTranscript(events, meta.settings.agent), [events, meta.settings.agent])
  const usage = useMemo(() => {
    const found = [...events].reverse().find((e) => e.event.kind === 'usage')?.event
    return found?.kind === 'usage' ? found : undefined
  }, [events])
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [events.length, streaming])

  const guard = (action: Promise<unknown>): void => {
    action.catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
  }

  const choice: AgentChoice = {
    agent: meta.settings.agent,
    model: meta.settings.model ?? '',
    effort: meta.settings.effort ?? '',
    permissionMode: meta.settings.permissionMode,
  }

  return (
    <main className="thread">
      <header className="thread-head">
        <div className="thread-heading">
          <h1>{meta.title}</h1>
          <p className="thread-status">
            <span className={`status-text status-${status}`}>
              {status === 'working' ? <Bars live /> : null}
              {STATUS_LABEL[status]}
            </span>
            {native ? (
              <button type="button" className="transcript-link" title={`Show ${transcriptPath} in Finder`} onClick={() => native?.revealTranscript(transcriptPath)}>
                <FileIcon />
                {shortPath(transcriptPath)}
              </button>
            ) : (
              <span className="transcript-link" title={transcriptPath}>
                <FileIcon />
                {shortPath(transcriptPath)}
              </span>
            )}
          </p>
        </div>
        <div className="thread-actions">
          <div className="segment">
            <button type="button" aria-label="Stop" title="Stop the current turn" disabled={!running} onClick={() => guard(api.interrupt(meta.id))}>
              <StopIcon />
            </button>
            <button
              type="button"
              aria-label={meta.completed ? 'Reopen' : 'Mark complete'}
              aria-pressed={meta.completed}
              title={meta.completed ? 'Reopen' : 'Mark complete'}
              onClick={() => guard(api.setCompleted(meta.id, !meta.completed))}
            >
              <CheckIcon />
            </button>
          </div>
          <div className="segment">
            <ThreadMenu
              transcriptPath={transcriptPath}
              usage={usage}
              completed={meta.completed}
              onToggleCompleted={() => guard(api.setCompleted(meta.id, !meta.completed))}
            />
          </div>
        </div>
      </header>
      <div className="events" ref={scroller}>
        <TranscriptView
          items={items}
          openApprovals={open}
          running={running}
          streaming={streaming}
          streamingAuthor={meta.settings.agent}
          onApprove={(requestId, behavior) => guard(api.approve(meta.id, requestId, behavior))}
        />
      </div>
      <Composer
        draftKey={meta.id}
        placeholder={running ? 'Add to the current turn…' : 'Add a follow-up…'}
        onSubmit={(text) => api.send(meta.id, text).then(() => undefined)}
        picker={
          <AgentPicker
            key={`${meta.id}-${JSON.stringify(choice)}`}
            value={choice}
            lockedReason={running ? 'Stop the current turn before switching.' : undefined}
            onSwitch={(next) => guard(api.switchAgent(meta.id, settingsFromChoice(next, meta.settings)))}
          />
        }
      />
    </main>
  )
}
