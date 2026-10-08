import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { QuestionCard } from '../web/src/components/QuestionCard.tsx'
import { buildTranscript, type TranscriptItem } from '../web/src/transcript.ts'
import type { StoredEvent } from '../server/threads/types.ts'

// W12-15: two agents in one conversation can each ask at once. A card that waits on you says
// whose it is, like the messages around it; a one-workspace conversation reads as before.

const ask = (requestId: string, workspaceId?: string): StoredEvent => ({ ts: '2026-10-08T08:38:00Z', ...(workspaceId ? { workspaceId } : {}),
  event: { kind: 'question', requestId, questions: [{ id: 'q', question: 'Which bed?', header: 'Bed', multiSelect: false, options: [{ label: 'Red' }] }] } } as StoredEvent)
const approve = (requestId: string, workspaceId?: string): StoredEvent => ({ ts: '2026-10-08T08:38:00Z', ...(workspaceId ? { workspaceId } : {}),
  event: { kind: 'approval_request', requestId, toolName: 'Bash', input: { command: 'ls' }, suggestions: [] } } as StoredEvent)
const cards = (events: StoredEvent[]) => buildTranscript(events, 'claude')
  .filter((i): i is Extract<TranscriptItem, { type: 'question' | 'approval' }> => i.type === 'question' || i.type === 'approval')
  .map((i) => [i.type, i.requestId, i.workspace])

describe('cards that wait on you, in a conversation with two workspaces', () => {
  it('carry the workspace whose agent asks', () => {
    expect(cards([ask('a', 'main'), ask('b', 'rose'), approve('c', 'rose')]))
      .toEqual([['question', 'a', 'main'], ['question', 'b', 'rose'], ['approval', 'c', 'rose']])
  })

  it('carry none while the conversation has only one', () => {
    expect(cards([ask('a', 'main'), approve('c', 'main')])).toEqual([['question', 'a', undefined], ['approval', 'c', undefined]])
  })

  it('the question card names it', () => {
    const item = buildTranscript([ask('a', 'main'), ask('b', 'rose')], 'claude').find((i) => i.type === 'question' && i.requestId === 'b') as Extract<TranscriptItem, { type: 'question' }>
    const html = renderToStaticMarkup(createElement(QuestionCard, { item, open: true, onAnswer: () => undefined, where: 'Rose bed' }))
    expect(html).toContain('aria-label="Claude Code asks in Rose bed"')
    expect(html).toMatch(/class="author-where"[^>]*>Rose bed</)
  })
})
