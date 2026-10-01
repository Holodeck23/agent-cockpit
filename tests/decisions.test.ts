import { describe, expect, it } from 'vitest'
import { decisionSummary, groupDecisions, type ApprovalItem } from '../web/src/decisions.ts'
import type { TranscriptItem } from '../web/src/transcript.ts'

const approval = (id: string, resolution?: ApprovalItem['resolution']): ApprovalItem => ({
  type: 'approval', key: `a:${id}`, requestId: id, agent: 'claude', toolName: 'Bash', detail: `echo ${id}`, canAllowForSession: true,
  ...(resolution ? { resolution } : {}),
})
const note = (text: string): TranscriptItem => ({ type: 'note', key: `n:${text}`, text, tone: 'plain' })

describe('decision lines', () => {
  it('groups consecutive answered approvals and keeps open or unanswered ones as cards', () => {
    const items: TranscriptItem[] = [approval('1', 'allow'), approval('2', 'deny'), note('between'), approval('3', 'allow'), approval('4'), approval('5', 'allow')]
    const shown = groupDecisions(items, new Set(['5']))
    expect(shown.map((s) => s.type === 'decisions' ? `D[${s.entries.map((e) => e.requestId).join(',')}]` : s.type)).toEqual([
      'D[1,2]', 'note', 'D[3]', 'approval', 'approval',
    ])
  })

  it('summarises one decision by its answer and several by counts', () => {
    expect(decisionSummary([approval('1', 'allow_session')])).toBe('1 decision · Allowed for this session')
    expect(decisionSummary([approval('1', 'allow'), approval('2', 'allow_session'), approval('3', 'deny')])).toBe('3 decisions · 2 allowed, 1 denied')
    expect(decisionSummary([approval('1', 'deny'), approval('2', 'deny')])).toBe('2 decisions · 2 denied')
  })
})
