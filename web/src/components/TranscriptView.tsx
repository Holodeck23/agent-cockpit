import { useEffect, useState } from 'react'
import type { ApprovalBehavior } from '../../../server/agents/types.ts'
import { agentName, elapsed, type TranscriptItem } from '../transcript.ts'
import { AgentGlyph } from './AgentGlyph.tsx'
import { Bars } from './icons.tsx'

interface TranscriptViewProps {
  items: TranscriptItem[]
  /** Approval ids that can still be answered (a turn is running). */
  openApprovals: ReadonlySet<string>
  running: boolean
  streaming: string
  streamingAuthor: 'claude' | 'codex'
  onApprove: (requestId: string, behavior: ApprovalBehavior) => void
}

const RESOLVED: Record<ApprovalBehavior, string> = {
  allow: 'Allowed',
  allow_session: 'Allowed for this session',
  deny: 'Denied',
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

function Author({ author, ts }: { author: 'you' | 'claude' | 'codex'; ts?: string }) {
  return (
    <div className="author">
      <AgentGlyph author={author} />
      <span className="author-name">{author === 'you' ? 'You' : agentName(author)}</span>
      {ts ? <time className="author-time">{time(ts)}</time> : null}
    </div>
  )
}

export function TranscriptView({ items, openApprovals, running, streaming, streamingAuthor, onApprove }: TranscriptViewProps) {
  const lastStepIndex = items.findLastIndex((i) => i.type === 'step')
  const liveStep = running && lastStepIndex >= 0 && lastStepIndex === items.length - 1 && !streaming
  const now = useTick(liveStep)
  const last = items.at(-1)
  const streamingShowsAuthor = !(last?.type === 'message' && last.author === streamingAuthor)

  return (
    <div className="transcript">
      {items.map((item, index) => {
        switch (item.type) {
          case 'message':
            return (
              <section key={item.key} className="message">
                {item.showAuthor ? <Author author={item.author} ts={item.ts} /> : null}
                <div className={`bubble ${item.author === 'you' ? 'user' : 'agent'}`}>
                  {item.text}
                  {item.attachments ? (
                    <div className={`attachments${item.text ? '' : ' only'}`}>Attached: {item.attachments.join(', ')}</div>
                  ) : null}
                </div>
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
          case 'approval': {
            const open = openApprovals.has(item.requestId)
            if (!open && item.resolution) {
              return (
                <div key={item.key} className="note">
                  {RESOLVED[item.resolution]}: {item.toolName} <code>{item.detail}</code>
                </div>
              )
            }
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
              </div>
            )
          default:
            return null
        }
      })}
      {streaming ? (
        <section className="message">
          {streamingShowsAuthor ? <Author author={streamingAuthor} /> : null}
          <div className="bubble agent streaming">{streaming}</div>
        </section>
      ) : null}
    </div>
  )
}
