import type { ProcessInfo } from './api.ts'

// Processes grouped by the conversation that owns them (K2), newest active work first. A process
// without a conversation sits under Project processes, never under whichever conversation is open.
// Finished processes appear only in the Show finished view.

export interface ProcessGroup {
  readonly key: string
  readonly label: string
  readonly processes: readonly ProcessInfo[]
}

export const PROJECT_GROUP = 'Project processes'

export function ownerText(info: ProcessInfo): string {
  const owner = info.owner
  const base = !owner ? 'Project process'
    : owner.kind === 'conversation' ? `Started by “${owner.title}”`
    : owner.kind === 'user' ? 'Started by you'
    : owner.formerly ? `Project process (kept from “${owner.formerly}”)` : 'Project process'
  const users = info.sharedWith?.length ? ` · also used by ${info.sharedWith.map((u) => `“${u.title}”`).join(', ')}` : ''
  return base + users
}

const groupOf = (info: ProcessInfo): { key: string; label: string } =>
  info.owner?.kind === 'conversation' ? { key: `thread:${info.owner.threadId}`, label: info.owner.title } : { key: 'project', label: PROJECT_GROUP }

const active = (info: ProcessInfo): boolean => info.status !== 'exited'

export function groupProcesses(list: readonly ProcessInfo[], finished: boolean): ProcessGroup[] {
  const shown = list.filter((p) => (finished ? !active(p) : active(p)))
  const groups = new Map<string, { key: string; label: string; processes: ProcessInfo[] }>()
  for (const p of [...shown].sort((a, b) => b.startedAt.localeCompare(a.startedAt))) {
    const { key, label } = groupOf(p)
    const group = groups.get(key) ?? { key, label, processes: [] }
    group.processes.push(p)
    groups.set(key, group)
  }
  // Groups follow their newest process, so the most recent work leads.
  return [...groups.values()]
}
