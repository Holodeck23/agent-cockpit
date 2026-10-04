import { describe, expect, it } from 'vitest'
import type { ThreadSummary } from '../server/threads/types.ts'
import { dayLabel, filterConversations, needsYou, STATUS_LABEL, tagFor, toneFor, TAG_TONES } from '../web/src/conversation-meta.ts'

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

  it('while searching, includes completed conversations and full-text matches', () => {
    const search = (query: string, textMatches?: ReadonlySet<string>) =>
      filterConversations({ threads, query, showCompleted: false, isUnread, textMatches }, 'all').rows.map((t) => t.meta.id)
    expect(search('logo')).toEqual(['3'])
    expect(search('invoice', new Set(['1', '3']))).toEqual(['1', '3'])
    expect(search('', new Set(['1', '3']))).toEqual(['1', '2', '4'])
  })

  it('returns only the active tab rows', () => {
    const { rows } = filterConversations({ threads, query: '', showCompleted: false, isUnread }, 'unread')
    expect(rows.map((t) => t.meta.id)).toEqual(['4'])
  })
})

describe('needsYou', () => {
  it('ignores completed conversations, so the Dock badge and Needs you tab skip them', () => {
    expect(needsYou(thread('a', { status: 'needs_input' }))).toBe(true)
    expect(needsYou(thread('b', { status: 'needs_input', completed: true }))).toBe(false)
    expect(needsYou({ ...thread('c', { status: 'done', completed: true }), awaiting: 'question' })).toBe(false)
    expect(needsYou({ ...thread('d', { status: 'done' }), awaiting: 'question' })).toBe(true)
  })

  it('a completed conversation shown with Show completed does not count in Needs you', () => {
    const threads = [thread('1', { status: 'needs_input', completed: true }), thread('2', { status: 'needs_input' })]
    expect(filterConversations({ threads, query: '', showCompleted: true, isUnread: () => false }, 'needs').counts.needs).toBe(1)
  })
})

describe('status labels', () => {
  it('calls a finished turn Ready, so it is not mistaken for a completed conversation', () => {
    expect(STATUS_LABEL.done).toBe('Ready')
  })
})

describe('an empty conversation list says why (A10)', () => {
  it('has its own words per filter, and offers a way back to everything', async () => {
    const { emptyListState } = await import('../web/src/conversation-meta.ts')
    expect(emptyListState('all', { total: 0, query: '' })).toEqual({ title: 'No conversations yet', detail: 'Start something with your agent.', back: false, done: false })
    expect(emptyListState('unread', { total: 3, query: '' })).toEqual({ title: 'All read', detail: 'No unread conversations.', back: true, done: true })
    expect(emptyListState('needs', { total: 3, query: '' })).toMatchObject({ title: 'Nothing needs you', back: true, done: true })
    expect(emptyListState('working', { total: 3, query: '' })).toMatchObject({ title: 'Nothing working', back: true, done: false })
    expect(emptyListState('working', { total: 3, query: 'zebra' })).toEqual({ title: 'No matches', detail: 'No conversation here mentions “zebra”.', back: false, done: false })
    expect(emptyListState('all', { total: 3, query: '' })).toMatchObject({ title: 'Nothing here', back: false })
  })
})
