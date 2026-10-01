import { useEffect, useMemo, useRef } from 'react'
import { agentName } from '../transcript.ts'
import { buildActivity } from '../activity.ts'
import { openApprovals } from '../../../server/threads/status.ts'
import { awaitingOf } from '../../../server/threads/turns.ts'
import { api, type ProcessInfo, type ThreadDetail } from '../api.ts'
import { STATUS_LABEL } from '../conversation-meta.ts'
import { native } from '../native.ts'
import { buildTranscript } from '../transcript.ts'
import { markUnread } from '../useSeen.ts'
import { ActivityPane, useActivityPrefs } from './ActivityPane.tsx'
import { AgentPicker, settingsFromChoice, type AgentChoice } from './AgentPicker.tsx'
import { Composer } from './Composer.tsx'
import { ProcessChip } from './ProcessChip.tsx'
import { ActivityIcon, Bars, CheckIcon, FileIcon, StopIcon, ChevronLeftIcon } from './icons.tsx'
import { ThreadMenu } from './ThreadMenu.tsx'
import { TranscriptView } from './TranscriptView.tsx'

interface ThreadViewProps {
  initialDraft?: string
  onDraftLoaded?: () => void
  onBrowseFiles?: () => void
  detail: ThreadDetail
  streaming: string
  /** This project's processes, for the status-line chip. */
  processes: ProcessInfo[]
  onError: (message: string) => void
  /** The project's current instructions revision, to compare with this session's. */
  instructionsRevision?: number
  /** Phone: reply, approve and stop only; a back button returns to the list. */
  phone?: boolean
  onBack?: () => void
}

/** "…/threads/1a2b3c4d/messages.md": enough to recognise, short enough to fit. */
function shortPath(path: string): string {
  const parts = path.split('/')
  const id = parts.at(-2) ?? ''
  return `…/threads/${id.slice(0, 8)}/${parts.at(-1) ?? ''}`
}

export function ThreadView({ initialDraft, onDraftLoaded, onBrowseFiles, detail, streaming, processes, onError, instructionsRevision, phone = false, onBack }: ThreadViewProps) {
  const { meta, status, events, transcriptPath } = detail
  const running = status === 'working' || status === 'needs_input'
  // A turn that ended with a question or a blocker waits on you, like an open approval (U12).
  const shown = !running && awaitingOf(events) ? 'needs_input' : status
  const open = useMemo(() => new Set(running ? openApprovals(events) : []), [events, running])
  const items = useMemo(() => buildTranscript(events, meta.settings.agent), [events, meta.settings.agent])
  const activity = useMemo(() => buildActivity(events, running), [events, running])
  const prefs = useActivityPrefs()
  const showActivity = !phone && prefs.open
  // With the pane open, tool steps live there and the conversation keeps what was said and decided.
  const conversationItems = useMemo(() => (showActivity ? items.filter((item) => item.type !== 'step') : items), [items, showActivity])
  const usage = useMemo(() => {
    const found = [...events].reverse().find((e) => e.event.kind === 'usage')?.event
    return found?.kind === 'usage' ? found : undefined
  }, [events])
  const scroller = useRef<HTMLDivElement>(null)

  const { open: activityOpen, setOpen: setActivityOpen } = prefs
  useEffect(() => {
    if (phone) return
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        setActivityOpen(!activityOpen)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phone, activityOpen, setActivityOpen])

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
    <main className={`thread${showActivity ? ' with-activity' : ''}`}>
      <header className="thread-head">
        {onBack ? (
          <button type="button" className="back-button" aria-label="Back to conversations" onClick={onBack}>
            <ChevronLeftIcon />
          </button>
        ) : null}
        <div className="thread-heading">
          <h1>{meta.title}</h1>
          <div className="thread-status">
            <span className={`status-text status-${shown}`}>
              {shown === 'working' ? <Bars live /> : null}
              {STATUS_LABEL[shown]}
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
            {phone ? null : <ProcessChip processes={processes} onStop={(id) => guard(api.stopProcess(id))} />}
          </div>
        </div>
        <div className="thread-actions">
          <div className="segment">
            <button type="button" aria-label="Stop" title="Stop the current turn" disabled={!running} onClick={() => guard(api.interrupt(meta.id))}>
              <StopIcon />
            </button>
            {phone ? null : <button
              type="button"
              aria-label={meta.completed ? 'Reopen' : 'Mark complete'}
              aria-pressed={meta.completed}
              title={meta.completed ? 'Reopen' : 'Mark complete'}
              onClick={() => guard(api.setCompleted(meta.id, !meta.completed))}
            >
              <CheckIcon />
            </button>}
          </div>
          {phone ? null : <div className="segment">
            <button
              type="button"
              className="activity-toggle"
              aria-label="Activity"
              aria-expanded={showActivity}
              title={`${showActivity ? 'Hide' : 'Show'} activity (⌘⇧A)`}
              onClick={() => setActivityOpen(!showActivity)}
            >
              <ActivityIcon />
              {activity.length > 0 ? <span className="activity-badge">{activity.length}</span> : null}
            </button>
            <ThreadMenu
              transcriptPath={transcriptPath}
              usage={usage}
              completed={meta.completed}
              instructions={{ session: meta.instructionsRevision, current: instructionsRevision, sessionText: meta.instructionsText }}
              onToggleCompleted={() => guard(api.setCompleted(meta.id, !meta.completed))}
              onMarkUnread={() => { markUnread(meta.id); onBack?.() }}
              onDelete={() => api.deleteThread(meta.id).then(() => onBack?.(), (e: unknown) => onError(e instanceof Error ? e.message : String(e)))}
              running={running}
            />
          </div>}
        </div>
      </header>
      <div className="events" ref={scroller}>
        <TranscriptView
          items={conversationItems}
          openApprovals={open}
          running={running}
          streaming={streaming}
          streamingAuthor={meta.settings.agent}
          onApprove={(requestId, behavior) => guard(api.approve(meta.id, requestId, behavior))}
        />
        {meta.completed && !running ? (
          <div className="completed-bar" role="status">
            <CheckIcon />
            <span>Marked complete</span>
            {phone ? null : <button type="button" className="button-soft" onClick={() => guard(api.setCompleted(meta.id, false))}>Reopen</button>}
          </div>
        ) : null}
      </div>
      <Composer
        initialDraft={initialDraft}
        onDraftLoaded={onDraftLoaded}
        onBrowseFiles={phone ? undefined : onBrowseFiles}
        projectPath={phone ? undefined : meta.projectPath}
        draftKey={meta.id}
        branchRefreshKey={`${meta.id}:${status}`}
        placeholder={running ? 'Add to the current turn…' : 'Add a follow-up…'}
        onSubmit={(text) => api.send(meta.id, text).then(() => undefined)}
        picker={phone ? (
          <span className="agent-static">{agentName(meta.settings.agent)}{meta.settings.model ? ` · ${meta.settings.model}` : ''}</span>
        ) : (
          <AgentPicker
            key={`${meta.id}-${JSON.stringify(choice)}`}
            value={choice}
            lockedReason={running ? 'Stop the current turn before switching.' : undefined}
            onSwitch={(next) => guard(api.switchAgent(meta.id, settingsFromChoice(next, meta.settings)))}
          />
        )}
      />
      {showActivity ? (
        <ActivityPane key={meta.id} rows={activity} width={prefs.width} onResize={prefs.setWidth} onClose={() => setActivityOpen(false)} />
      ) : null}
    </main>
  )
}
