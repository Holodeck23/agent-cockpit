import { useState } from 'react'
import type { AgentQuestion } from '../../../server/agents/types.ts'
import { agentName, type TranscriptItem } from '../transcript.ts'

type QuestionItem = Extract<TranscriptItem, { type: 'question' }>

interface QuestionCardProps {
  item: QuestionItem
  /** The agent is still waiting for these answers. */
  open: boolean
  /** Undefined closes the questions without answers. */
  onAnswer: (answers: Record<string, string> | undefined) => void
}

/** One answer per question: the picked choices (", "-joined when several are allowed), or your own words. */
export function answerOf(question: AgentQuestion, picked: readonly string[], other: string): string {
  const own = other.trim()
  if (!question.multiSelect) return own || picked[0] || ''
  return [...picked, ...(own ? [own] : [])].join(', ')
}

/** The agent's questions (J6), grouped in one card; once answered it keeps what you said. */
export function QuestionCard({ item, open, onAnswer }: QuestionCardProps) {
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const [sending, setSending] = useState(false)
  const answers = Object.fromEntries(item.questions.map((q) => [q.id, answerOf(q, picked[q.id] ?? [], other[q.id] ?? '')]))
  const anyAnswer = Object.values(answers).some((a) => a.length > 0)
  const settled = item.answers !== undefined || item.dismissed

  const pick = (q: AgentQuestion, label: string, on: boolean): void =>
    setPicked((now) => ({ ...now, [q.id]: q.multiSelect ? (on ? [...(now[q.id] ?? []), label] : (now[q.id] ?? []).filter((l) => l !== label)) : [label] }))
  const answer = (value: Record<string, string> | undefined): void => {
    setSending(true)
    onAnswer(value)
  }

  return (
    <section className={`question-card${open && !settled ? ' open' : ''}`} aria-label={`${agentName(item.agent)} asks`}>
      <div className="question-card-title"><strong>{agentName(item.agent)}</strong> asks {item.questions.length === 1 ? 'a question' : `${item.questions.length} questions`}</div>
      {item.questions.map((q) => (
        <fieldset key={q.id} className="question" disabled={!open || settled || sending}>
          <legend>{q.header ? <span className="question-header">{q.header}</span> : null}{q.question}</legend>
          {settled ? (
            <div className="question-answer">{item.answers?.[q.id] || (item.dismissed ? 'Not answered' : 'No answer')}</div>
          ) : (
            <>
              {q.options.map((o) => (
                <label key={o.label} className="question-option">
                  <input
                    type={q.multiSelect ? 'checkbox' : 'radio'}
                    name={`${item.requestId}:${q.id}`}
                    checked={(picked[q.id] ?? []).includes(o.label)}
                    onChange={(e) => pick(q, o.label, e.target.checked)}
                  />
                  <span className="question-option-label">{o.label}</span>
                  {o.description ? <span className="question-option-detail">{o.description}</span> : null}
                </label>
              ))}
              <input
                className="question-other"
                aria-label={`Your own answer: ${q.question}`}
                placeholder={q.options.length ? 'Or answer in your own words' : 'Your answer'}
                value={other[q.id] ?? ''}
                onChange={(e) => setOther((now) => ({ ...now, [q.id]: e.target.value }))}
              />
            </>
          )}
        </fieldset>
      ))}
      {settled ? (
        item.dismissed ? <div className="question-closed">Closed without answers</div> : null
      ) : open ? (
        <div className="approval-actions">
          <button type="button" className="button-primary" disabled={!anyAnswer || sending} onClick={() => answer(answers)}>Send answers</button>
          <button type="button" className="button-soft" disabled={sending} onClick={() => answer(undefined)}>Dismiss</button>
        </div>
      ) : (
        <div className="approval-expired">No longer waiting: that turn has ended.</div>
      )}
    </section>
  )
}
