import { useCallback, useEffect, useRef, useState } from 'react'
import { api, subscribe, type ProcessInfo, type StoredEvent, type ThreadDetail, type ThreadSummary, type ThreadUpdate } from './api.ts'

export interface Cockpit {
  readonly threads: ThreadSummary[]
  readonly selectedId: string | undefined
  readonly detail: ThreadDetail | undefined
  /** Text streamed for the current turn but not yet finalized. */
  readonly streaming: string
  readonly error: string | undefined
  /** Project processes (dev servers etc.) started through the cockpit MCP, newest first. */
  readonly processes: ProcessInfo[]
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
      meta: update.event.kind === 'completion_changed' ? { ...t.meta, completed: update.event.completed } : t.meta,
      preview: text ? text.slice(0, 140) : t.preview,
      messageCount: t.messageCount + (isMessage ? 1 : 0),
      lastActivityAt,
    }
  })
}

/** Replaces the process with the same id, or adds it at the front. */
function upsertProcess(list: ProcessInfo[], info: ProcessInfo): ProcessInfo[] {
  return list.some((p) => p.id === info.id) ? list.map((p) => (p.id === info.id ? info : p)) : [info, ...list]
}

export function useCockpit(): Cockpit {
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [detail, setDetail] = useState<ThreadDetail>()
  const [streaming, setStreaming] = useState('')
  const [error, setError] = useState<string>()
  const [processes, setProcesses] = useState<ProcessInfo[]>([])

  const refresh = useCallback(() => {
    api.listThreads().then(setThreads, (e: unknown) => setError(String(e)))
  }, [])

  useEffect(refresh, [refresh])

  const selectedRef = useRef(selectedId)
  const loadVersion = useRef(0)
  const reloadDetail = useCallback((id: string): void => {
    const version = ++loadVersion.current
    api.thread(id).then(
      (loaded) => {
        if (version !== loadVersion.current || selectedRef.current !== id) return
        setDetail(loaded)
        setStreaming(loaded.streaming)
      },
      (e: unknown) => {
        if (version === loadVersion.current && selectedRef.current === id) setError(String(e))
      },
    )
  }, [])

  const select = useCallback((id: string | undefined): void => {
    if (selectedRef.current === id) return
    ++loadVersion.current
    selectedRef.current = id
    setSelectedId(id)
    setDetail(undefined)
    setStreaming('')
  }, [])

  useEffect(() => {
    if (selectedId) reloadDetail(selectedId)
    return () => { ++loadVersion.current }
  }, [selectedId, reloadDetail])

  // One subscription for the life of the page; refs identify the selected thread.
  const knownIds = useRef(new Set<string>())
  knownIds.current = new Set(threads.map((t) => t.meta.id))

  useEffect(() => {
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
      if (update.event.kind === 'completion_changed') {
        const completed = update.event.completed
        setDetail((d) => d?.meta.id === update.threadId ? { ...d, meta: { ...d.meta, completed } } : d)
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
      api.listProcesses().then(setProcesses, (e: unknown) => setError(String(e)))
    }
    const onProcess = (info: ProcessInfo): void => setProcesses((current) => upsertProcess(current, info))
    return subscribe({ onUpdate, onProcess, onOpen })
  }, [refresh, reloadDetail])

  return {
    threads,
    selectedId,
    detail,
    streaming,
    error,
    processes,
    select,
    refresh,
    reportError: setError,
  }
}
