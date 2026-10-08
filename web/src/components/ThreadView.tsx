import { useEffect, useMemo, useRef, useState } from 'react'
import { agentName } from '../transcript.ts'
import { buildActivity } from '../activity.ts'
import { compactingNow, isBusy, openApprovals, runningHelpers } from '../../../server/threads/status.ts'
import { awaitingOf } from '../../../server/threads/turns.ts'
import { api, type MessageImage, type ProcessInfo, type StoredImage, type ThreadDetail } from '../api.ts'
import { phoneWorkspaceId, workingWorkspaces, type ThreadWorkspace } from '../workspaces.ts'
import { isWorking, STATUS_LABEL } from '../conversation-meta.ts'
import { buildTranscript, followUpSuggestions } from '../transcript.ts'
import { markUnread } from '../useSeen.ts'
import { useStickToBottom } from '../useStickToBottom.ts'
import { ActivityPane, useActivityPrefs } from './ActivityPane.tsx'
import { AgentPicker, settingsFromChoice, type AgentChoice } from './AgentPicker.tsx'
import { ChangesView } from './ChangesView.tsx'
import { Composer } from './Composer.tsx'
import { FindBar } from './FindBar.tsx'
import { ProcessChip } from './ProcessChip.tsx'
import { PhoneApps } from './PhoneApps.tsx'
import { ActivityIcon, Bars, BranchIcon, CheckIcon, ChevronDownIcon, StopIcon, ChevronLeftIcon, SidebarIcon } from './icons.tsx'
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
  /** Desktop list toggle beside the conversation title. */
  onToggleList?: () => void
  listHidden?: boolean
  /** Opens a file in Files at a line (desktop; Changes uses it for a right-side line). */
  onOpenFile?: (target: { path: string; line: number }) => void
  /** The selected workspace and where a send goes (desktop). */
  workspace?: ThreadWorkspace
  /** Text streaming per workspace (W12-15). */
  streams?: Readonly<Record<string, string>>
}

export function ThreadView({ initialDraft, onDraftLoaded, onBrowseFiles, detail, streaming, processes, onError, instructionsRevision, phone = false, onBack, onToggleList, listHidden = false, onOpenFile, workspace, streams }: ThreadViewProps) {
  const { meta, status, events, transcriptPath } = detail
  const running = isBusy(status)
  // Which of the conversation's workspaces have an agent at work right now (W12-15).
  const inSeveral = !phone && Object.keys(meta.bindings ?? {}).length > 0
  const workingIn = inSeveral ? workingWorkspaces(events, running) : []
  const twoRunning = workingIn.length > 1
  const focused = workspace?.selectedId
  const focusedWorking = focused !== undefined && workingIn.includes(focused)
  const focusedRunning = inSeveral && focused !== undefined ? focusedWorking : running
  // A turn that ended with a question or a blocker waits on you, like an open approval (U12).
  const shown = !running && awaitingOf(events) ? 'needs_input' : status
  const open = useMemo(() => new Set(running ? openApprovals(events) : []), [events, running])
  const helpers = useMemo(() => (running ? runningHelpers(events).length : 0), [events, running])
  const compacting = useMemo(() => running && compactingNow(events), [events, running])
  const turn = useMemo(() => latestTurn(events), [events])
  const now = useNow(isWorking(shown))
  const items = useMemo(() => buildTranscript(events, meta.settings.agent), [events, meta.settings.agent])
  // J2: a click puts the text in the box to edit; sending uses whatever the picker says then.
  const followUps = useMemo(() => followUpSuggestions(events), [events])
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
  const [restore, setRestore] = useState<{ readonly text: string; readonly restore?: true; readonly images?: readonly StoredImage[] }>()
  // J4: Changes replaces the transcript while open; from a run's note it starts on This run.
  const [changesFor, setChangesFor] = useState<{ runId?: string }>()
  useEffect(() => { setFinding(false); setRestore(undefined); setChangesFor(undefined) }, [meta.id])
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

  // Use my Chrome: Claude's first Chrome call is still waiting for Chrome (at most 30 s, chrome-watch.ts).
  const connectingChrome = useMemo(() => {
    const last = events.findLast((e) => e.event.kind === 'chrome_connection')?.event
    return last?.kind === 'chrome_connection' && last.phase === 'connecting'
  }, [events])
  const sentKey = useMemo(() => String(events.findLastIndex((e) => e.event.kind === 'user_text')), [events])
  const { hasNew, jumpToLatest } = useStickToBottom(scroller, meta.id, `${events.length}:${streaming.length}`, sentKey)

  const guard = (action: Promise<unknown>): void => {
    action.catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
  }

  // A send names its workspace once the project has a worktree; the phone names the conversation's own once it has run in two.
  const sendTo = phone ? { ok: true as const, workspaceId: phoneWorkspaceId(meta) } : workspace?.target ?? { ok: true as const }
  const send = (text: string, images: readonly MessageImage[]): Promise<unknown> =>
    sendTo.ok ? api.send(meta.id, text, images, sendTo.workspaceId) : Promise.reject(new Error(sendTo.reason))

  const choice: AgentChoice = {
    agent: meta.settings.agent,
    model: meta.settings.model ?? '',
    effort: meta.settings.effort ?? '',
    permissionMode: meta.settings.permissionMode,
    ...(meta.settings.useChrome ? { chrome: true } : {}),
  }

  return (
    <main className={`thread${showActivity ? ' with-activity' : ''}`}>
      <header className="thread-head">
        {onBack ? (
          <button type="button" className="back-button" aria-label="Back to conversations" onClick={onBack}>
            <ChevronLeftIcon />
          </button>
        ) : null}
        {!phone && onToggleList ? (
          <button type="button" className="thread-list-toggle" aria-label={listHidden ? 'Show conversation list' : 'Hide conversation list'}
            aria-pressed={!listHidden} title={listHidden ? 'Show conversation list' : 'Hide conversation list'} onClick={onToggleList}>
            <SidebarIcon />
          </button>
        ) : null}
        <div className="thread-heading">
          <h1>{meta.title}</h1>
          <div className="thread-status">
            <span className={`status-text status-${shown}`}>
              {shown === 'working' ? <Bars live /> : shown === 'starting' ? <span className="starting-dot" aria-hidden="true" /> : null}
              {compacting ? 'Compacting' : statusText(shown, turn, now)}
            </span>
            {!phone && workspace?.showLabel ? <span className="workspace-chip" title="The workspace this conversation works in now"><BranchIcon />{workspace.currentLabel}</span> : null}
            {helpers > 0 ? <span className="helper-count" title="Helpers this agent started that are still at work">{helpers} helper{helpers === 1 ? '' : 's'} working</span> : null}
            {running && twoRunning && workspace ? (
              // Two workspaces at work: Stop the one you are looking at, or Stop all (W12-15).
              <>
                {focusedWorking ? (
                  <button type="button" className="head-action" aria-label={`Stop ${workspace.nameOf(focused!)}`} title={`Stop the turn in ${workspace.nameOf(focused!)}; the other keeps working`} onClick={() => guard(api.interrupt(meta.id, focused))}>
                    <StopIcon />
                    Stop {workspace.nameOf(focused!)}
                  </button>
                ) : null}
                <button type="button" className="head-action" aria-label="Stop all" title="Stop every agent working in this conversation" onClick={() => guard(api.interrupt(meta.id))}>
                  <StopIcon />
                  Stop all
                </button>
              </>
            ) : running ? (
              <button type="button" className="head-action" aria-label="Stop" title={helpers > 0 ? 'Stop the current turn and its helpers' : 'Stop the current turn'} onClick={() => guard(api.interrupt(meta.id))}>
                <StopIcon />
                Stop
              </button>
            ) : null}
            {phone ? null : (
              <span className="status-separator" aria-hidden="true">›</span>
            )}
            {phone ? null : (
              <button
                type="button"
                className="head-action"
                aria-label={meta.completed ? 'Reopen' : 'Mark complete'}
                aria-pressed={meta.completed}
                // J11: nothing to complete while the agent is still at it.
                disabled={running && !meta.completed}
                title={meta.completed ? 'Reopen this conversation' : running ? 'Available when the turn ends' : 'Mark this conversation complete'}
                onClick={() => guard(api.setCompleted(meta.id, !meta.completed))}
              >
                <CheckIcon />
                {meta.completed ? 'Completed' : 'Complete'}
              </button>
            )}
            {phone ? null : (
              <button type="button" className="head-action" aria-pressed={Boolean(changesFor)} title="Uncommitted changes in this folder" onClick={() => setChangesFor(changesFor ? undefined : {})}>
                Changes
              </button>
            )}
            {phone ? <PhoneApps processes={processes} /> : <ProcessChip processes={processes} onStop={(id) => guard(api.stopProcess(id))} />}
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
              ownedProcesses={processes.filter((p) => p.status !== 'exited' && p.owner?.kind === 'conversation' && p.owner.threadId === meta.id)}
              onDelete={(choice) => api.deleteThread(meta.id, choice).then(() => onBack?.(), (e: unknown) => onError(e instanceof Error ? e.message : String(e)))}
              running={running}
            />
          </div>}
        </div>
      </header>
      {changesFor && !phone ? (
        <ChangesView key={workspace?.scope ?? 'main'} projectPath={meta.projectPath} workspaceId={workspace?.scope} threadId={meta.id} runId={changesFor.runId} refreshKey={running ? 'running' : `idle:${events.length}`}
          onOpenFile={(target) => onOpenFile?.(target)} onClose={() => setChangesFor(undefined)} />
      ) : null}
      <div className="events" ref={scroller} hidden={Boolean(changesFor && !phone)}>
        {finding ? <FindBar root={scroller} contentKey={`${meta.id}:${events.length}`} onClose={() => setFinding(false)} /> : null}
        <TranscriptView
          threadId={meta.id}
          items={conversationItems}
          openApprovals={open}
          running={running}
          streaming={streaming}
          streamingAuthor={meta.settings.agent}
          onApprove={(requestId, behavior) => guard(api.approve(meta.id, requestId, behavior))}
          onAnswer={(requestId, answers) => guard(api.answerQuestion(meta.id, requestId, answers))}
          onUnqueue={(queuedId) => guard(api.unqueue(meta.id, queuedId).then(({ text, images }) => setRestore({ text, restore: true, images })))}
          onSendNow={() => guard(api.interrupt(meta.id, twoRunning ? focused : undefined))}
          workspaceName={inSeveral ? workspace?.nameOf : undefined}
          streams={streams}
          onRetry={(text, images) => guard(send(text, images.map(({ file, name }) => ({ stored: file, ...(name ? { name } : {}) }))))}
          onDismiss={!running && awaitingOf(events) ? () => guard(api.dismissAwaiting(meta.id)) : undefined}
          onOpenChanges={phone ? undefined : (runId) => setChangesFor({ runId })}
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
      {running && connectingChrome ? (
        <div className="chrome-connecting" role="status">
          <span className="starting-dot" aria-hidden="true" />
          <span>Connecting to your Chrome… Cockpit stops waiting after 30 seconds.</span>
          <button type="button" className="button-soft" onClick={() => guard(api.interrupt(meta.id))}>Cancel</button>
        </div>
      ) : null}
      {!running && !meta.completed && followUps.length > 0 ? (
        <div className="follow-ups" role="group" aria-label="Suggested follow-ups">
          <div className="follow-ups-row">
            {followUps.map((text) => (
              <button key={text} type="button" className="follow-up" title="Put this in the message box to edit, then send"
                onClick={() => setRestore({ text })}>{text}</button>
            ))}
          </div>
        </div>
      ) : null}
      <Composer
        initialDraft={initialDraft}
        onDraftLoaded={onDraftLoaded}
        onBrowseFiles={phone ? undefined : onBrowseFiles}
        projectPath={phone ? undefined : meta.projectPath}
        workspaceId={workspace?.scope}
        workspaceFolder={workspace?.folder}
        blocked={sendTo.ok ? undefined : sendTo.reason}
        note={workspace?.moves ? `Your next message continues this conversation in ${workspace.moves.to}. It last worked in ${workspace.moves.from}.` : undefined}
        destination={workspace?.moves?.to ?? workspace?.currentLabel ?? 'Main checkout'}
        confirmDestination={workspace?.moves?.to}
        threadId={meta.id}
        // Each workspace of a conversation keeps its own draft and image chips; the main checkout's stays the conversation's own key.
        draftKey={workspace?.scope ? `${meta.id}@${workspace.scope}` : meta.id}
        prefill={restore}
        branchRefreshKey={`${meta.id}:${status}`}
        // With two workspaces, the box speaks for the one you are looking at.
        placeholder={focusedRunning ? 'Add to the current turn…' : 'Add a follow-up…'}
        working={isWorking(status) && focusedRunning}
        onSubmit={(text, images) => send(text, images).then(() => undefined)}
        picker={phone ? (
          <span className="agent-static">{agentName(meta.settings.agent)}{meta.settings.model ? ` · ${meta.settings.model}` : ''}</span>
        ) : (
          <AgentPicker
            key={`${meta.id}-${JSON.stringify(choice)}`}
            value={choice}
            lockedReason={running ? 'Stop the current turn before switching.' : undefined}
            projectPath={meta.projectPath}
            onSwitch={(next, handoff) => api.switchAgent(meta.id, settingsFromChoice(next, meta.settings), handoff)}
            previewHandoff={() => api.handoffPreview(meta.id)}
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
