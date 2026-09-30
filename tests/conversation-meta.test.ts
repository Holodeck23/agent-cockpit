import { describe, expect, it } from 'vitest'
import type { ThreadSummary } from '../server/threads/types.ts'
import { dayLabel, filterConversations, STATUS_LABEL, tagFor, toneFor, TAG_TONES } from '../web/src/conversation-meta.ts'

function thread(id: string, patch: { title?: string; status?: ThreadSummary['status']; completed?: boolean; preview?: string }): ThreadSummary {
  return {
    meta: {
      id,
      title: patch.title ?? `Thread ${id}`,
      projectPath: '/p',
      settings: { agent: 'claude', permissionMode: 'manual', useHooks: false },
      sessionId: id,
      sessionStarted: true,
      completed: patch.completed ?? false,
      createdAt: '2026-09-28T10:00:00.000Z',
      updatedAt: '2026-09-28T10:00:00.000Z',
    },
    status: patch.status ?? 'done',
    preview: patch.preview ?? '',
    messageCount: 2,
    lastActivityAt: '2026-09-28T10:00:00.000Z',
  }
}

describe('tagFor', () => {
  it('skips filler words and keeps two meaningful ones', () => {
    expect(tagFor('An app that reminds me to water my plants')).toBe('App reminds')
    expect(tagFor('Please build a preorder page for my bakery')).toBe('Preorder page')
    expect(tagFor('Fix the login bug!')).toBe('Fix login')
  })

  it('falls back to the raw words and truncates long tags', () => {
    expect(tagFor('the and a')).toBe('The and')
    expect(tagFor('Internationalisation localisation')).toBe('Internationalisation…')
  })

  it('maps a tag to a stable tone', () => {
    expect(toneFor('Plant reminders')).toBe(toneFor('Plant reminders'))
    expect(TAG_TONES).toContain(toneFor('anything'))
  })
})

describe('dayLabel', () => {
  const now = new Date('2026-09-28T15:00:00')
  it('uses Today, Yesterday, a weekday, then a date', () => {
    expect(dayLabel('2026-09-28T08:00:00', now)).toBe('Today')
    expect(dayLabel('2026-09-27T23:00:00', now)).toBe('Yesterday')
    expect(dayLabel('2026-09-24T12:00:00', now)).toBe('Thursday')
    expect(dayLabel('2026-09-12T12:00:00', now)).toBe('12 Sept')
  })
})

describe('filterConversations', () => {
  const threads = [
    thread('1', { title: 'Plant reminders', status: 'working' }),
    thread('2', { title: 'Bakery preorders', status: 'needs_input', preview: 'May I write order.html?' }),
    thread('3', { title: 'Old logo', status: 'done', completed: true }),
    thread('4', { title: 'Clinic checklist', status: 'done' }),
  ]
  const isUnread = (t: ThreadSummary): boolean => t.meta.id === '4'

  it('counts every tab over the searched, completed-filtered set', () => {
    const { counts, rows } = filterConversations({ threads, query: '', showCompleted: false, isUnread }, 'all')
    expect(counts).toEqual({ all: 3, needs: 1, working: 1, unread: 1 })
    expect(rows.map((t) => t.meta.id)).toEqual(['1', '2', '4'])
  })

  it('includes completed threads when asked', () => {
    expect(filterConversations({ threads, query: '', showCompleted: true, isUnread }, 'all').counts.all).toBe(4)
  })

  it('searches titles and previews, case-insensitively', () => {
    const byPreview = filterConversations({ threads, query: 'ORDER.HTML', showCompleted: false, isUnread }, 'all')
    expect(byPreview.rows.map((t) => t.meta.id)).toEqual(['2'])
  })

  it('returns only the active tab rows', () => {
    const { rows } = filterConversations({ threads, query: '', showCompleted: false, isUnread }, 'unread')
    expect(rows.map((t) => t.meta.id)).toEqual(['4'])
  })
})

describe('status labels', () => {
  it('calls a finished turn Ready, so it is not mistaken for a completed conversation', () => {
    expect(STATUS_LABEL.done).toBe('Ready')
  })
})
