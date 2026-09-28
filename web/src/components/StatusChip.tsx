import type { ThreadStatus } from '../api.ts'

const LABELS: Record<ThreadStatus, string> = {
  idle: 'Idle',
  working: 'Working',
  needs_input: 'Needs you',
  done: 'Done',
  error: 'Error',
}

interface StatusChipProps {
  status: ThreadStatus
}

export function StatusChip({ status }: StatusChipProps) {
  return <span className={`chip chip-${status}`}>{LABELS[status]}</span>
}
