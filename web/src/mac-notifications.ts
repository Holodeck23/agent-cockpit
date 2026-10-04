// Native Mac notifications when an agent finishes or needs you, for every conversation except the
// one you are looking at. Clicking one opens that conversation. On by default; remembered per Mac.
import { useEffect, useState } from 'react'
import type { ThreadSummary } from './api.ts'
import type { SoundKind } from './sounds.ts'

export interface NotifySettings {
  readonly reply: boolean
  readonly decision: boolean
}
export const DEFAULT_NOTIFY: NotifySettings = { reply: true, decision: true }
const KEY = 'cockpit:mac-notifications'

export function parseNotify(raw: string | null): NotifySettings {
  try {
    const stored: unknown = raw ? JSON.parse(raw) : {}
    const s = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {}
    return { reply: s.reply !== false, decision: s.decision !== false }
  } catch {
    return DEFAULT_NOTIFY
  }
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

type Row = Pick<ThreadSummary, 'preview' | 'status' | 'awaiting' | 'asking'> & { meta: Pick<ThreadSummary['meta'], 'title'> }

export function notificationText(thread: Row, kind: SoundKind): { title: string; body: string } {
  const preview = thread.preview.replace(/\s+/g, ' ').trim()
  const label = thread.awaiting === 'question' ? 'Question' : 'Blocked'
  const body = kind === 'reply'
    ? (preview ? `Finished: ${preview}` : 'Finished')
    : thread.asking ? `Question: ${thread.asking}`
    : thread.awaiting ? `${label}: ${preview.replace(/^(question|blocked)\s*:\s*/i, '') || 'see the conversation'}` : 'Waiting for your approval'
  return { title: clip(thread.meta.title, 80), body: clip(body, 160) }
}

export function useNotifySettings(): { notify: NotifySettings; setNotify: (next: NotifySettings) => void } {
  const [notify, setNotify] = useState<NotifySettings>(() => {
    try { return parseNotify(localStorage.getItem(KEY)) } catch { return DEFAULT_NOTIFY }
  })
  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(notify)) } catch { /* not persisted */ }
  }, [notify])
  return { notify, setNotify }
}
