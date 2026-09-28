import { useCallback, useEffect, useRef, useState } from 'react'
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
    const isMessage = update.event.kind === 'assistant_text' || update.event.kind === 'user_text'
    const text = isMessage && 'text' in update.event ? update.event.text : undefined
    // Streaming deltas are not persisted server-side, so they don't count as activity either.
    const lastActivityAt = update.event.kind === 'text_delta' ? t.lastActivityAt : new Date().toISOString()
    return {
      ...t,
      status: update.status,
      preview: text ? text.slice(0, 140) : t.preview,
      messageCount: t.messageCount + (isMessage ? 1 : 0),
      lastActivityAt,
    }
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

  // One subscription for the life of the page. Re-subscribing on every change dropped
  // events that arrived during the reconnect (SSE doesn't replay), leaving stale
  // statuses; current values are read through refs instead.
  const selectedRef = useRef(selectedId)
  selectedRef.current = selectedId
  const knownIds = useRef(new Set<string>())
  knownIds.current = new Set(threads.map((t) => t.meta.id))

  useEffect(() => {
    const reloadDetail = (id: string): void => {
      api.thread(id).then(setDetail, (e: unknown) => setError(String(e)))
    }
    const onUpdate = (update: ThreadUpdate): void => {
      const isDelta = update.event.kind === 'text_delta'
      if (!knownIds.current.has(update.threadId)) refresh()
      else if (!isDelta) setThreads((current) => applyToSummaries(current, update))
      if (update.threadId !== selectedRef.current) return
      if (update.event.kind === 'text_delta') {
        const delta = update.event.text
        setStreaming((s) => s + delta)
        return
      }
      if (update.event.kind === 'agent_switch') {
        // Settings and session changed server-side: reload the thread and the list.
        reloadDetail(update.threadId)
        refresh()
        return
      }
      if (update.event.kind === 'assistant_text' || update.event.kind === 'result') setStreaming('')
      const stored: StoredEvent = { ts: new Date().toISOString(), event: update.event }
      setDetail((d) => (d && d.meta.id === update.threadId ? { ...d, status: update.status, events: [...d.events, stored] } : d))
    }
    // After a (re)connect, anything missed while disconnected is re-read from the server.
    const onOpen = (): void => {
      refresh()
      if (selectedRef.current) reloadDetail(selectedRef.current)
    }
    return subscribe(onUpdate, onOpen)
  }, [refresh])

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
