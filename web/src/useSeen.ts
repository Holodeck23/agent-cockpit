import { useCallback, useEffect, useState } from 'react'
import type { ThreadSummary } from './api.ts'

// "Unread" = activity since you last had the conversation open. Tracked per
// window in localStorage; the server doesn't need to know.
const KEY = 'cockpit:seen'

type SeenMap = Readonly<Record<string, string>>

function load(): SeenMap | undefined {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as SeenMap) : undefined
  } catch {
    return undefined
  }
}

function save(map: SeenMap): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map))
  } catch {
    // not persisted; unread state resets next launch
  }
}

export function useSeen(threads: readonly ThreadSummary[], selectedId: string | undefined): (thread: ThreadSummary) => boolean {
  const [seen, setSeen] = useState<SeenMap | undefined>(load)

  // First run ever: everything that already exists counts as read.
  useEffect(() => {
    if (seen !== undefined || threads.length === 0) return
    const initial = Object.fromEntries(threads.map((t) => [t.meta.id, t.lastActivityAt]))
    setSeen(initial)
    save(initial)
  }, [seen, threads])

  // The open conversation is always read, including activity that lands while it's open.
  const selected = threads.find((t) => t.meta.id === selectedId)
  useEffect(() => {
    if (!selected) return
    setSeen((current) => {
      if (current?.[selected.meta.id] === selected.lastActivityAt) return current
      const next = { ...current, [selected.meta.id]: selected.lastActivityAt }
      save(next)
      return next
    })
  }, [selected?.meta.id, selected?.lastActivityAt])

  return useCallback(
    (thread: ThreadSummary) => thread.meta.id !== selectedId && (seen?.[thread.meta.id] ?? '') < thread.lastActivityAt,
    [seen, selectedId],
  )
}
