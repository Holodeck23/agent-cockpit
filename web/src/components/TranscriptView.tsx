import { useContext, useEffect, useState } from 'react'
import type { AgentId, ApprovalBehavior } from '../../../server/agents/types.ts'
import { decisionSummary, groupDecisions, RESOLVED } from '../decisions.ts'
import { agentName, elapsed, type TranscriptItem } from '../transcript.ts'
import { AgentGlyph } from './AgentGlyph.tsx'
import { CopyButton } from './CopyButton.tsx'
import { Bars, FileIcon, WorkflowIcon } from './icons.tsx'
import { TroubleshootingLink } from './TroubleshootingLink.tsx'
import { ReplyContext, ReplyMarkdown } from '../markdown/reply.tsx'
import { Peek } from './Peek.tsx'
import { api } from '../api.ts'
import { peekText } from '../file-text.ts'

interface TranscriptViewProps {
  items: TranscriptItem[]
  /** Approval ids that can still be answered (a turn is running). */
  openApprovals: ReadonlySet<string>
  running: boolean
  streaming: string
  streamingAuthor: AgentId
  onApprove: (requestId: string, behavior: ApprovalBehavior) => void
  /** Present while the last turn's question or blocker still waits on you. */
  onDismiss?: () => void
}

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

function Author({ author, ts }: { author: 'you' | AgentId; ts?: string }) {
  return (
    <div className="author">
      <AgentGlyph author={author} />
      <span className="author-name">{author === 'you' ? 'You' : agentName(author)}</span>
      {ts ? <time className="author-time">{time(ts)}</time> : null}
    </div>
  )
}

export function TranscriptView({ items, openApprovals, running, streaming, streamingAuthor, onApprove, onDismiss }: TranscriptViewProps) {
  const shown = groupDecisions(items, openApprovals)
  const replies = useContext(ReplyContext)
  const waitingIndex = onDismiss ? shown.findLastIndex((i) => i.type === 'message' && Boolean(i.conclusion)) : -1
  const lastStepIndex = shown.findLastIndex((i) => i.type === 'step')
  const liveStep = running && lastStepIndex >= 0 && lastStepIndex === shown.length - 1 && !streaming
  const now = useTick(liveStep)
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
                  {item.fromConversation ? <div className="author"><a className="author-name" href={`/?thread=${encodeURIComponent(item.fromConversation.id)}`}>From {item.fromConversation.title}</a><time className="author-time">{time(item.ts)}</time></div> : item.showAuthor ? <Author author={item.author} ts={item.ts} /> : null}
                  {rest.length ? (
                    <details className="update-line"><summary><span className="update-tag">Update</span>{first}</summary><div>{rest.join('\n')}</div></details>
                  ) : <div className="update-line"><span className="update-tag">Update</span>{first}</div>}
                </section>
              )
            }
            return (
              <section key={item.key} className={`message${item.phase === 'acknowledgement' ? ' phase-ack' : ''}${item.conclusion ? ` conclusion-${item.conclusion}` : ''}`}>
                {item.fromConversation ? <div className="author"><a className="author-name" href={`/?thread=${encodeURIComponent(item.fromConversation.id)}`}>From {item.fromConversation.title}</a><time className="author-time">{time(item.ts)}</time></div> : item.showAuthor ? <Author author={item.author} ts={item.ts} /> : null}
                {item.conclusion ? (
                  <div className="conclusion-head">
                    <span className={`conclusion-tag ${item.conclusion}`}>{item.conclusion === 'question' ? 'Question for you' : 'Blocked'}</span>
                    {index === waitingIndex ? <button type="button" className="button-soft conclusion-dismiss" onClick={onDismiss}>Dismiss</button> : null}
                  </div>
                ) : null}
                <div className={`bubble ${item.author === 'you' ? 'user' : 'agent reply'}${item.phase === 'acknowledgement' ? ' ack' : ''}`}>
                  {/* What you typed stays exactly as typed; agent replies are Markdown. */}
                  {item.author === 'you' ? item.text : <ReplyMarkdown text={item.text} />}
                  {item.attachments || item.workflows ? (
                    <div className={`message-clips${item.text ? '' : ' only'}`} role="list" aria-label="Sent with this message">
                      {item.attachments?.map((path) => {
                        const chip = (
                          <span role="listitem" className="reference-chip" title={path} tabIndex={replies.projectPath ? 0 : undefined}>
                            <FileIcon />
                            <span>{path.split('/').pop() ?? path}</span>
                          </span>
                        )
                        // Peek at the file as it is now; Files is on the Mac only.
                        const project = replies.projectPath
                        return project ? (
                          <Peek key={`file:${path}`} title={path} load={async () => peekText((await api.readFile(project, path)).text)}
                            action={replies.onOpenFile ? { label: 'Open in Files', run: () => replies.onOpenFile?.({ path }) } : undefined}>
                            {chip}
                          </Peek>
                        ) : <span key={`file:${path}`}>{chip}</span>
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
                {item.text.trim() ? <CopyButton text={item.text} /> : null}
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
                      <span className="decision-answer">{RESOLVED[entry.resolution!]}</span>
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
                </div>
                <code className="approval-detail">{item.detail}</code>
                {open ? (
                  <div className="approval-actions">
                    <button type="button" className="button-primary" onClick={() => onApprove(item.requestId, 'allow')}>
                      Allow
                    </button>
                    {item.canAllowForSession ? (
                      <button type="button" className="button-soft" onClick={() => onApprove(item.requestId, 'allow_session')}>
                        Allow for this session
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
          case 'note':
            return (
              <div key={item.key} className={`note meta-line${item.tone === 'error' ? ' note-error' : ''}`}>
                {item.text}
                {item.tone === 'error' ? <TroubleshootingLink text={item.text} /> : null}
              </div>
            )
          default:
            return null
        }
      })}
      {streaming ? (
        <section className="message">
          {streamingShowsAuthor ? <Author author={streamingAuthor} /> : null}
          <div className="bubble agent reply streaming"><ReplyMarkdown text={streaming} /></div>
        </section>
      ) : null}
    </div>
  )
}
