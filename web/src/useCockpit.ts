import { useCallback, useEffect, useState } from 'react'
import { api, subscribe, type StoredEvent, type ThreadDetail, type ThreadSummary, type ThreadUpdate } from './api.ts'

export interface Cockpit {
  readonly threads: ThreadSummary[]
  readonly selectedId: string | undefined
  readonly detail: ThreadDetail | undefined
  /** Text streamed for the current turn but not yet finalized. */
  readonly streaming: string
  readonly error: string | undefined
  select(id: string | undefined): void
  refresh(): void
  reportError(message: string | undefined): void
}

function applyToSummaries(threads: ThreadSummary[], update: ThreadUpdate): ThreadSummary[] {
  return threads.map((t) => {
    if (t.meta.id !== update.threadId) return t
    const text = update.event.kind === 'assistant_text' || update.event.kind === 'user_text' ? update.event.text : undefined
    return { ...t, status: update.status, preview: text ? text.slice(0, 140) : t.preview }
  })
}

export function useCockpit(): Cockpit {
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [detail, setDetail] = useState<ThreadDetail>()
  const [streaming, setStreaming] = useState('')
  const [error, setError] = useState<string>()

  const refresh = useCallback(() => {
    api.listThreads().then(setThreads, (e: unknown) => setError(String(e)))
  }, [])

  useEffect(refresh, [refresh])

  useEffect(() => {
    setStreaming('')
    if (!selectedId) {
      setDetail(undefined)
      return
    }
    api.thread(selectedId).then(setDetail, (e: unknown) => setError(String(e)))
  }, [selectedId])

  useEffect(
    () =>
      subscribe((update) => {
        setThreads((current) =>
          current.some((t) => t.meta.id === update.threadId) ? applyToSummaries(current, update) : current,
        )
        if (!threads.some((t) => t.meta.id === update.threadId)) refresh()
        if (update.threadId !== selectedId) return
        if (update.event.kind === 'text_delta') {
          const delta = update.event.text
          setStreaming((s) => s + delta)
          return
        }
        if (update.event.kind === 'agent_switch') {
          // Settings and session changed server-side: reload the thread and the list.
          const id = update.threadId
          api.thread(id).then(setDetail, (e: unknown) => setError(String(e)))
          refresh()
          return
        }
        if (update.event.kind === 'assistant_text' || update.event.kind === 'result') setStreaming('')
        const stored: StoredEvent = { ts: new Date().toISOString(), event: update.event }
        setDetail((d) => (d ? { ...d, status: update.status, events: [...d.events, stored] } : d))
      }),
    [selectedId, threads, refresh],
  )

  return {
    threads,
    selectedId,
    detail,
    streaming,
    error,
    select: setSelectedId,
    refresh,
    reportError: setError,
  }
}
