import { useContext, useEffect, useState } from 'react'
import type { AgentId, ApprovalBehavior } from '../../../server/agents/types.ts'
import { decisionSummary, groupDecisions, resolvedLabel } from '../decisions.ts'
import { agentName, elapsed, type TranscriptItem } from '../transcript.ts'
import { AgentGlyph } from './AgentGlyph.tsx'
import { CopyButton } from './CopyButton.tsx'
import { Bars, FileIcon, WorkflowIcon } from './icons.tsx'
import { TroubleshootingLink } from './TroubleshootingLink.tsx'
import { ReplyContext, ReplyMarkdown } from '../markdown/reply.tsx'
import { Peek } from './Peek.tsx'
import { QuestionCard } from './QuestionCard.tsx'
import { ConversationImages } from './ConversationImage.tsx'
import { api } from '../api.ts'
import { linesOf, peekText } from '../file-text.ts'
import { labelTarget } from '../../../server/files/references.ts'
import { ResultCard } from './ResultCard.tsx'

interface TranscriptViewProps {
  /** The conversation, for its images' addresses. */
  threadId: string
  items: TranscriptItem[]
  /** Approval ids that can still be answered (a turn is running). */
  openApprovals: ReadonlySet<string>
  running: boolean
  streaming: string
  streamingAuthor: AgentId
  onApprove: (requestId: string, behavior: ApprovalBehavior) => void
  onAnswer: (requestId: string, answers: Record<string, string> | undefined) => void
  /** Takes a waiting message back to the draft (J1). */
  onUnqueue?: (queuedId: string) => void
  /** Stops the current turn so waiting messages run now (J1). */
  onSendNow?: () => void
  /** Sends a failed turn's message again (J10). */
  onRetry?: (text: string, images: readonly { file: string; name?: string }[]) => void
  /** Present while the last turn's question or blocker still waits on you. */
  onDismiss?: () => void
  /** Opens Changes for a finished run (desktop only). */
  onOpenChanges?: (runId: string) => void
  /** Names a workspace, once the conversation has run in more than one (W12-15): messages and live text say where. */
  workspaceName?: (workspaceId: string) => string
  /** Text streaming per workspace, when two agents can reply at once. */
  streams?: Readonly<Record<string, string>>
}

/** 34052 → "34k"; small counts stay exact. */
const tokens = (n: number): string => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

const HELPER_LABEL = { running: 'Helper working', done: 'Helper finished', failed: 'Helper failed', stopped: 'Helper stopped' } as const

const time = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** Re-renders every second while `active`, for the running step's timer. */
function useTick(active: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

function Author({ author, ts, where }: { author: 'you' | AgentId; ts?: string; where?: string }) {
  return (
    <div className="author">
      <AgentGlyph author={author} />
      <span className="author-name">{author === 'you' ? 'You' : agentName(author)}</span>
      {where ? <span className="author-where" title="The workspace this ran in">{where}</span> : null}
      {ts ? <time className="author-time">{time(ts)}</time> : null}
    </div>
  )
}

const lineCount = (text: string): number => text.split('\n').length

export function TranscriptView({ threadId, items, openApprovals, running, streaming, streamingAuthor, onApprove, onAnswer, onUnqueue, onSendNow, onRetry, onDismiss, onOpenChanges, workspaceName, streams }: TranscriptViewProps) {
  const shown = groupDecisions(items, openApprovals)
  const replies = useContext(ReplyContext)
  const waitingIndex = onDismiss ? shown.findLastIndex((i) => i.type === 'message' && Boolean(i.conclusion)) : -1
  const lastStepIndex = shown.findLastIndex((i) => i.type === 'step')
  // Retry belongs to the latest failure only, and only once nothing runs.
  const lastFailure = shown.findLastIndex((i) => i.type === 'failure' && Boolean(i.retryText))
  const retryIndex = !running && lastFailure > shown.findLastIndex((i) => i.type === 'message' && i.author === 'you') ? lastFailure : -1
  const liveStep = running && lastStepIndex >= 0 && lastStepIndex === shown.length - 1 && !streaming
  const now = useTick(liveStep || shown.some((i) => i.type === 'compaction' && i.state === 'running'))
  const last = shown.at(-1)
  const streamingShowsAuthor = !(last?.type === 'message' && last.author === streamingAuthor)

  return (
    <div className="transcript">
      {shown.map((item, index) => {
        switch (item.type) {
          case 'message':
            if (item.phase === 'update') {
              // Interim updates stay compact: a label and the first line, the rest on request.
              const [first = '', ...rest] = item.text.trim().split('\n')
              return (
                <section key={item.key} className="message phase-update">
                  {item.fromConversation ? <div className="author"><a className="author-name" href={`/?thread=${encodeURIComponent(item.fromConversation.id)}`}>From {item.fromConversation.title}</a><time className="author-time">{time(item.ts)}</time></div> : item.showAuthor ? <Author author={item.author} ts={item.ts} where={item.workspace && workspaceName ? workspaceName(item.workspace) : undefined} /> : null}
                  {rest.length ? (
                    <details className="update-line"><summary><span className="update-tag">Update</span>{first}</summary><div>{rest.join('\n')}</div></details>
                  ) : <div className="update-line"><span className="update-tag">Update</span>{first}</div>}
                </section>
              )
            }
            return (
              <section key={item.key} className={`message${item.phase === 'acknowledgement' ? ' phase-ack' : ''}${item.conclusion ? ` conclusion-${item.conclusion}` : ''}${item.queuedId ? ' waiting' : ''}`}>
                {item.fromConversation ? <div className="author"><a className="author-name" href={`/?thread=${encodeURIComponent(item.fromConversation.id)}`}>From {item.fromConversation.title}</a><time className="author-time">{time(item.ts)}</time></div> : item.showAuthor ? <Author author={item.author} ts={item.ts} where={item.workspace && workspaceName ? workspaceName(item.workspace) : undefined} /> : null}
                {item.conclusion ? (
                  <div className="conclusion-head">
                    <span className={`conclusion-tag ${item.conclusion}`}>{item.conclusion === 'question' ? 'Question for you' : 'Blocked'}</span>
                    {index === waitingIndex ? <button type="button" className="button-soft conclusion-dismiss" onClick={onDismiss}>Dismiss</button> : null}
                  </div>
                ) : null}
                <div className={`bubble ${item.author === 'you' ? 'user' : 'agent reply'}${item.phase === 'acknowledgement' ? ' ack' : ''}`}>
                  {/* What you typed stays exactly as typed; agent replies are Markdown. */}
                  {item.author === 'you' ? item.text : <ReplyMarkdown text={item.text} />}
                  {item.images?.length ? <ConversationImages threadId={threadId} images={item.images} /> : null}
                  {item.attachments || item.workflows ? (
                    <div className={`message-clips${item.text ? '' : ' only'}`} role="list" aria-label="Sent with this message">
                      {item.attachments?.map((label) => {
                        // "src/a.ts" or, for selected lines, "src/a.ts:3-7".
                        const target = labelTarget(label)
                        const { path } = target
                        const chip = (
                          <span role="listitem" className="reference-chip" title={label} tabIndex={replies.projectPath ? 0 : undefined}>
                            <FileIcon />
                            <span>{label.split('/').pop() ?? label}</span>
                          </span>
                        )
                        // Peek at the file (or those lines) as it is now; Files is on the Mac only.
                        const project = replies.projectPath
                        return project ? (
                          <Peek key={`file:${label}`} title={label} load={async () => peekText(linesOf((await api.readFile(project, path, replies.workspaceId)).text, target))}
                            action={replies.onOpenFile ? { label: 'Open in Files', run: () => replies.onOpenFile?.(target) } : undefined}>
                            {chip}
                          </Peek>
                        ) : <span key={`file:${label}`}>{chip}</span>
                      })}
                      {item.workflows?.map((w) => (
                        <Peek key={`workflow:${w.name}`} title={`Workflow ${w.name}`} load={async () => peekText(w.prompt)}>
                          <details role="listitem" className="reference-chip workflow-clip">
                            <summary title={`Workflow ${w.name}: show the instructions it sent`}><WorkflowIcon /><span>{w.name}</span></summary>
                            <pre>{w.prompt}</pre>
                          </details>
                        </Peek>
                      ))}
                    </div>
                  ) : null}
                </div>
                {item.queuedId && running ? (
                  <div className="waiting-row" role="status">
                    <span>Waiting: the agent takes it at its next step</span>
                    {onUnqueue ? <button type="button" className="button-soft" onClick={() => onUnqueue(item.queuedId!)}>Remove</button> : null}
                    {onSendNow ? <button type="button" className="button-soft" onClick={onSendNow}>Stop and send now</button> : null}
                  </div>
                ) : null}
                {/* A waiting message's own buttons sit where Copy would; Remove gives the text back anyway. */}
                {item.text.trim() && !(item.queuedId && running) ? <CopyButton text={item.text} /> : null}
              </section>
            )
          case 'step': {
            const live = liveStep && index === lastStepIndex
            const end = item.endedAt ? Date.parse(item.endedAt) : live ? now : undefined
            return (
              <div key={item.key} className={`step${live ? ' live' : ''}`}>
                <Bars live={live} />
                <span className="step-label">{item.label}</span>
                {end !== undefined ? <span className="step-time">· {elapsed(item.startedAt, end)}</span> : null}
                {item.error ? <div className="step-error">{item.error}</div> : null}
              </div>
            )
          }
          case 'decisions':
            return (
              <details key={item.key} className="decisions">
                <summary>{decisionSummary(item.entries)}</summary>
                <ul>
                  {item.entries.map((entry) => (
                    <li key={entry.key} className={entry.resolution === 'deny' ? 'decision-denied' : undefined}>
                      <span className="decision-answer">{resolvedLabel(entry)}</span>
                      <span>{agentName(entry.agent)} · {entry.toolName}</span>
                      <code>{entry.detail}</code>
                    </li>
                  ))}
                </ul>
              </details>
            )
          case 'approval': {
            const open = openApprovals.has(item.requestId)
            return (
              <div key={item.key} className={`approval${open ? ' open' : ''}`}>
                <div className="approval-title">
                  <strong>{agentName(item.agent)}</strong> wants to use <strong>{item.toolName}</strong>
                  {item.workspace && workspaceName ? <span className="author-where" title="The workspace this agent works in">{workspaceName(item.workspace)}</span> : null}
                </div>
                {item.note ? <p className="approval-note">{item.note}</p> : null}
                {item.flags?.length ? (
                  <ul className="approval-flags" aria-label="Also asks for">
                    {item.flags.map((flag) => <li key={flag}>{flag}</li>)}
                  </ul>
                ) : null}
                {/* Capped and scrolled from its top: a long command cannot push its start out of view beside Allow. */}
                <code className="approval-detail" tabIndex={0}>{item.detail}</code>
                {lineCount(item.detail) > 1 ? <span className="approval-lines">{lineCount(item.detail)} lines; scroll to read them all</span> : null}
                {item.fullInput ? (
                  <details className="approval-input">
                    <summary>All input</summary>
                    <pre>{item.fullInput}</pre>
                  </details>
                ) : null}
                {open ? (
                  <div className="approval-actions">
                    <button type="button" className="button-primary" onClick={() => onApprove(item.requestId, 'allow')}>
                      Allow
                    </button>
                    {item.canAllowForSession ? (
                      <button type="button" className="button-soft" onClick={() => onApprove(item.requestId, 'allow_session')}>
                        {item.allowWiderLabel ?? 'Allow for this session'}
                      </button>
                    ) : null}
                    <button type="button" className="button-soft" onClick={() => onApprove(item.requestId, 'deny')}>
                      Deny
                    </button>
                  </div>
                ) : (
                  <div className="approval-expired">No longer waiting: that turn has ended.</div>
                )}
              </div>
            )
          }
          case 'question':
            return <QuestionCard key={item.key} item={item} where={item.workspace && workspaceName ? workspaceName(item.workspace) : undefined} open={openApprovals.has(item.requestId)} onAnswer={(answers) => onAnswer(item.requestId, answers)} />
          case 'failure':
            return (
              <div key={item.key} className="failure" role="alert">
                <div className="failure-title">{item.title}</div>
                {item.detail ? <div className="failure-detail">{item.detail}</div> : null}
                <div className="failure-actions">
                  {index === retryIndex && onRetry ? <button type="button" className="button-soft" onClick={() => onRetry(item.retryText!, item.retryImages ?? [])}>Retry</button> : null}
                  {item.raw && item.raw !== item.detail ? (
                    <details className="failure-raw"><summary>Details</summary><pre>{item.raw}</pre></details>
                  ) : null}
                  <TroubleshootingLink text={item.raw} />
                </div>
              </div>
            )
          case 'compaction': {
            const live = item.state === 'running'
            const end = item.endedAt ? Date.parse(item.endedAt) : live ? now : undefined
            const sizes = item.preTokens !== undefined && item.postTokens !== undefined ? ` · ${tokens(item.preTokens)} → ${tokens(item.postTokens)} tokens` : ''
            return (
              <div key={item.key} className={`step compaction${live ? ' live' : ''}${item.state === 'failed' ? ' compaction-failed' : ''}`}>
                <Bars live={live} />
                <span className="step-label">{live ? 'Making room: summarising the conversation so far' : item.state === 'failed' ? 'Could not summarise the conversation' : `Summarised the conversation to make room${sizes}`}</span>
                {end !== undefined ? <span className="step-time">· {elapsed(item.startedAt, end)}</span> : null}
              </div>
            )
          }
          case 'helper': {
            const live = item.state === 'running'
            const end = item.endedAt ? Date.parse(item.endedAt) : undefined
            return (
              <details key={item.key} className={`helper helper-${item.state}`}>
                <summary>
                  <Bars live={live} />
                  <span className="helper-label">{item.description}</span>
                  <span className="helper-meta">· {HELPER_LABEL[item.state]}{item.steps.length ? ` · ${item.steps.length} step${item.steps.length === 1 ? '' : 's'}` : ''}{end !== undefined ? ` · ${elapsed(item.startedAt, end)}` : ''}</span>
                </summary>
                {item.steps.length ? <ol className="helper-steps">{item.steps.map((step, i) => <li key={i}>{step}</li>)}</ol> : null}
                {item.answer ? <div className="helper-answer reply"><ReplyMarkdown text={item.answer} /></div> : live ? null : <div className="helper-empty">No report.</div>}
              </details>
            )
          }
          case 'image':
            return (
              <section key={item.key} className={`message image-item ${item.author === 'you' ? 'from-you' : 'from-agent'}`}>
                {item.showAuthor ? <Author author={item.author} /> : null}
                <ConversationImages threadId={threadId} images={[item]} />
              </section>
            )
          case 'result':
            return <ResultCard key={item.key} threadId={threadId} runId={item.runId} onOpenChanges={onOpenChanges} />
          case 'note':
            return (
              <div key={item.key} className={`note meta-line${item.tone === 'error' ? ' note-error' : ''}`}>
                {item.text}
                {item.tone === 'error' ? <TroubleshootingLink text={item.text} /> : null}
                {item.runId && onOpenChanges ? <button type="button" className="note-action" onClick={() => onOpenChanges(item.runId!)}>Changes</button> : null}
              </div>
            )
          default:
            return null
        }
      })}
      {workspaceName && streams && Object.values(streams).some(Boolean) ? (
        // Two agents can be typing at once: one live reply per workspace, each labelled.
        Object.entries(streams).filter(([, text]) => text).map(([workspace, text]) => (
          <section key={`streaming-${workspace}`} className="message">
            <Author author={streamingAuthor} where={workspace ? workspaceName(workspace) : undefined} />
            <div className="bubble agent reply streaming"><ReplyMarkdown text={text} /></div>
          </section>
        ))
      ) : streaming ? (
        <section className="message">
          {streamingShowsAuthor ? <Author author={streamingAuthor} /> : null}
          <div className="bubble agent reply streaming"><ReplyMarkdown text={streaming} /></div>
        </section>
      ) : null}
    </div>
  )
}
