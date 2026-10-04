import { useEffect, useMemo, useRef, useState } from 'react'
import { agentName } from '../transcript.ts'
import { buildActivity } from '../activity.ts'
import { compactingNow, openApprovals, runningHelpers } from '../../../server/threads/status.ts'
import { awaitingOf } from '../../../server/threads/turns.ts'
import { api, type ProcessInfo, type ThreadDetail } from '../api.ts'
import { STATUS_LABEL } from '../conversation-meta.ts'
import { buildTranscript } from '../transcript.ts'
import { markUnread } from '../useSeen.ts'
import { useStickToBottom } from '../useStickToBottom.ts'
import { ActivityPane, useActivityPrefs } from './ActivityPane.tsx'
import { AgentPicker, settingsFromChoice, type AgentChoice } from './AgentPicker.tsx'
import { Composer } from './Composer.tsx'
import { FindBar } from './FindBar.tsx'
import { ProcessChip } from './ProcessChip.tsx'
import { ActivityIcon, Bars, CheckIcon, ChevronDownIcon, StopIcon, ChevronLeftIcon } from './icons.tsx'
import { ThreadMenu } from './ThreadMenu.tsx'
import { TranscriptView } from './TranscriptView.tsx'
import { statusText, useNow } from './StatusPill.tsx'
import { latestTurn } from '../../../server/threads/status.ts'

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

export function ThreadView({ initialDraft, onDraftLoaded, onBrowseFiles, detail, streaming, processes, onError, instructionsRevision, phone = false, onBack }: ThreadViewProps) {
  const { meta, status, events, transcriptPath } = detail
  const running = status === 'working' || status === 'needs_input'
  // A turn that ended with a question or a blocker waits on you, like an open approval (U12).
  const shown = !running && awaitingOf(events) ? 'needs_input' : status
  const open = useMemo(() => new Set(running ? openApprovals(events) : []), [events, running])
  const helpers = useMemo(() => (running ? runningHelpers(events).length : 0), [events, running])
  const compacting = useMemo(() => running && compactingNow(events), [events, running])
  const turn = useMemo(() => latestTurn(events), [events])
  const now = useNow(shown === 'working')
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
  const [finding, setFinding] = useState(false)
  // A message taken back from the agent's queue returns to the draft (J1).
  const [restore, setRestore] = useState<{ readonly text: string; readonly restore: true }>()
  useEffect(() => { setFinding(false); setRestore(undefined) }, [meta.id])
  useEffect(() => {
    if (phone) return
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        setActivityOpen(!activityOpen)
      } else if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'f') {
        // ⌘F finds in this conversation; pressed again it refocuses the open bar.
        event.preventDefault()
        if (finding) document.querySelector<HTMLInputElement>('.find-bar input')?.focus()
        else setFinding(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phone, activityOpen, setActivityOpen, finding])

  const sentKey = useMemo(() => String(events.findLastIndex((e) => e.event.kind === 'user_text')), [events])
  const { hasNew, jumpToLatest } = useStickToBottom(scroller, meta.id, `${events.length}:${streaming.length}`, sentKey)

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
              {compacting ? 'Compacting' : statusText(shown, turn, now)}
            </span>
            {helpers > 0 ? <span className="helper-count" title="Helpers this agent started that are still at work">{helpers} helper{helpers === 1 ? '' : 's'} working</span> : null}
            {running ? (
              <button type="button" className="head-action" aria-label="Stop" title={helpers > 0 ? 'Stop the current turn and its helpers' : 'Stop the current turn'} onClick={() => guard(api.interrupt(meta.id))}>
                <StopIcon />
                Stop
              </button>
            ) : null}
            {phone ? null : (
              <button
                type="button"
                className="head-action"
                aria-label={meta.completed ? 'Reopen' : 'Mark complete'}
                aria-pressed={meta.completed}
                title={meta.completed ? 'Reopen this conversation' : 'Mark this conversation complete'}
                onClick={() => guard(api.setCompleted(meta.id, !meta.completed))}
              >
                <CheckIcon />
                {meta.completed ? 'Completed' : 'Complete'}
              </button>
            )}
            {phone ? null : <ProcessChip processes={processes} onStop={(id) => guard(api.stopProcess(id))} />}
          </div>
        </div>
        <div className="thread-actions">
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
              onFind={() => setFinding(true)}
              onMarkUnread={() => { markUnread(meta.id); onBack?.() }}
              onDelete={() => api.deleteThread(meta.id).then(() => onBack?.(), (e: unknown) => onError(e instanceof Error ? e.message : String(e)))}
              running={running}
            />
          </div>}
        </div>
      </header>
      <div className="events" ref={scroller}>
        {finding ? <FindBar root={scroller} contentKey={`${meta.id}:${events.length}`} onClose={() => setFinding(false)} /> : null}
        <TranscriptView
          items={conversationItems}
          openApprovals={open}
          running={running}
          streaming={streaming}
          streamingAuthor={meta.settings.agent}
          onApprove={(requestId, behavior) => guard(api.approve(meta.id, requestId, behavior))}
          onAnswer={(requestId, answers) => guard(api.answerQuestion(meta.id, requestId, answers))}
          onUnqueue={(queuedId) => guard(api.unqueue(meta.id, queuedId).then(({ text }) => setRestore({ text, restore: true })))}
          onSendNow={() => guard(api.interrupt(meta.id))}
          onRetry={(text) => guard(api.send(meta.id, text))}
          onDismiss={!running && awaitingOf(events) ? () => guard(api.dismissAwaiting(meta.id)) : undefined}
        />
        {meta.completed && !running ? (
          <div className="completed-bar" role="status">
            <CheckIcon />
            <span>Marked complete</span>
            {phone ? null : <button type="button" className="button-soft" onClick={() => guard(api.setCompleted(meta.id, false))}>Reopen</button>}
          </div>
        ) : null}
        {hasNew ? (
          <button type="button" className="jump-latest" onClick={jumpToLatest}>
            <ChevronDownIcon />
            Jump to latest
          </button>
        ) : null}
      </div>
      <Composer
        initialDraft={initialDraft}
        onDraftLoaded={onDraftLoaded}
        onBrowseFiles={phone ? undefined : onBrowseFiles}
        projectPath={phone ? undefined : meta.projectPath}
        threadId={meta.id}
        draftKey={meta.id}
        prefill={restore}
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
            onApply={(next) => guard(api.changeSettings(meta.id, settingsFromChoice(next, meta.settings)))}
          />
        )}
      />
      {showActivity ? (
        <ActivityPane key={meta.id} rows={activity} width={prefs.width} onResize={prefs.setWidth} onClose={() => setActivityOpen(false)} />
      ) : null}
    </main>
  )
}
