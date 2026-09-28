// Pure helpers for how a conversation is labelled in the list. No React, so they're unit-tested.
import type { ThreadStatus, ThreadSummary } from './api.ts'

const FILLER = new Set(
  'a an the to for of and or in on at with my me i you your we our it this that please can could would will should just make create write build use add do help want need let lets tell show give get'.split(
    ' ',
  ),
)

export const TAG_TONES = ['blue', 'green', 'pink', 'apricot'] as const
export type TagTone = (typeof TAG_TONES)[number]

/** A short tag from the title: the first two meaningful words, e.g. "Plant reminders". */
export function tagFor(title: string): string {
  const words = title
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0)
  const meaningful = words.filter((w) => !FILLER.has(w.toLowerCase()))
  const picked = (meaningful.length > 0 ? meaningful : words).slice(0, 2).join(' ').toLowerCase()
  const tag = picked.length > 22 ? `${picked.slice(0, 21).trimEnd()}…` : picked
  return tag.charAt(0).toUpperCase() + tag.slice(1)
}

export function toneFor(tag: string): TagTone {
  let hash = 0
  for (const char of tag) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return TAG_TONES[hash % TAG_TONES.length] ?? 'blue'
}

export function agentLabel(agent: string): string {
  return agent === 'codex' ? 'Codex' : 'Claude Code'
}

/** "Today", "Yesterday", a weekday within the last week, else "12 Sep". */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const then = new Date(iso)
  const startOf = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const days = Math.round((startOf(now) - startOf(then)) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return then.toLocaleDateString('en-GB', { weekday: 'long' })
  return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

export type ListFilter = 'all' | 'needs' | 'working' | 'unread'

export interface FilterInput {
  readonly threads: readonly ThreadSummary[]
  readonly query: string
  readonly showCompleted: boolean
  readonly isUnread: (thread: ThreadSummary) => boolean
}

const MATCHES: Record<ListFilter, (t: ThreadSummary, isUnread: (t: ThreadSummary) => boolean) => boolean> = {
  all: () => true,
  needs: (t) => t.status === 'needs_input',
  working: (t) => t.status === 'working',
  unread: (t, isUnread) => isUnread(t),
}

/** Threads after search and the completed toggle, then the per-tab counts and the active tab's rows. */
export function filterConversations(input: FilterInput, filter: ListFilter): { counts: Record<ListFilter, number>; rows: ThreadSummary[] } {
  const q = input.query.trim().toLowerCase()
  const base = input.threads.filter(
    (t) =>
      (input.showCompleted || !t.meta.completed) &&
      (q === '' || t.meta.title.toLowerCase().includes(q) || t.preview.toLowerCase().includes(q)),
  )
  const count = (f: ListFilter): number => base.filter((t) => MATCHES[f](t, input.isUnread)).length
  return {
    counts: { all: count('all'), needs: count('needs'), working: count('working'), unread: count('unread') },
    rows: base.filter((t) => MATCHES[filter](t, input.isUnread)),
  }
}

export const STATUS_LABEL: Record<ThreadStatus, string> = {
  idle: 'Waiting',
  working: 'Working',
  needs_input: 'Needs you',
  done: 'Done',
  error: 'Error',
}
