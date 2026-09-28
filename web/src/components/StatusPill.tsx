import type { ThreadStatus } from '../api.ts'
import { STATUS_LABEL } from '../conversation-meta.ts'
import { Bars, CheckIcon } from './icons.tsx'

interface StatusPillProps {
  status: ThreadStatus
}

/** Status in the list and thread header. Idle threads show nothing: there is nothing to report. */
export function StatusPill({ status }: StatusPillProps) {
  if (status === 'idle') return null
  return (
    <span className={`pill pill-${status}`}>
      {status === 'working' ? <Bars live /> : status === 'done' ? <CheckIcon /> : null}
      {STATUS_LABEL[status]}
    </span>
  )
}
