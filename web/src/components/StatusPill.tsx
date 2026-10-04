import { useEffect, useState } from 'react'
import type { ThreadStatus } from '../api.ts'
import { STATUS_LABEL } from '../conversation-meta.ts'
import { elapsed } from '../transcript.ts'
import { Bars } from './icons.tsx'

interface StatusPillProps {
  status: ThreadStatus
  /** The latest turn's span: Working counts up from its start; Error keeps how long it ran (A11). */
  turn?: { readonly startedAt: string; readonly endedAt?: string }
}

/** Re-renders every second while `active`. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

/** "Working · 0:07" while a turn runs, "Error · 0:12" once one failed; other states are just the word. */
export function statusText(status: ThreadStatus, turn: StatusPillProps['turn'], now: number): string {
  if (status === 'working' && turn && !turn.endedAt) return `${STATUS_LABEL.working} · ${elapsed(turn.startedAt, now)}`
  if (status === 'error' && turn?.endedAt) return `${STATUS_LABEL.error} · ${elapsed(turn.startedAt, Date.parse(turn.endedAt))}`
  return STATUS_LABEL[status]
}

/** Status in the list and thread header. Idle threads show nothing: there is nothing to report. */
export function StatusPill({ status, turn }: StatusPillProps) {
  const now = useNow(status === 'working')
  if (status === 'idle') return null
  return (
    <span className={`pill pill-${status}`}>
      {status === 'working' ? <Bars live /> : null}
      {statusText(status, turn, now)}
    </span>
  )
}
