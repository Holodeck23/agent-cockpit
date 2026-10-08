import type { ApprovalOutcome } from '../../server/agents/types.ts'
import type { TranscriptItem } from './transcript.ts'

// Answered approvals are history: the transcript shows them as one short, expandable
// "decision" line instead of a full card. Consecutive answers share a line.

export type ApprovalItem = Extract<TranscriptItem, { type: 'approval' }>
export interface DecisionGroup { readonly type: 'decisions'; readonly key: string; readonly entries: readonly ApprovalItem[] }
export type ShownItem = TranscriptItem | DecisionGroup

export const RESOLVED: Record<ApprovalOutcome, string> = {
  allow: 'Allowed',
  allow_session: 'Allowed for this session',
  deny: 'Denied by you',
  expired: 'Expired',
  canceled: 'Canceled',
}

/** How an answer reads; a wider Allow the asker named ("Allow on example.com for this run") keeps its own words. */
export function resolvedLabel(entry: ApprovalItem): string {
  if (entry.resolution === 'allow_session' && entry.allowWiderLabel) return entry.allowWiderLabel.replace(/^Allow\b/, 'Allowed')
  return RESOLVED[entry.resolution!]
}

/** `open` holds approvals that can still be answered; those stay as cards. */
export function groupDecisions(items: readonly TranscriptItem[], open: ReadonlySet<string>): ShownItem[] {
  const shown: ShownItem[] = []
  for (const item of items) {
    const answered = item.type === 'approval' && item.resolution !== undefined && !open.has(item.requestId)
    const last = shown.at(-1)
    if (answered && last?.type === 'decisions') shown[shown.length - 1] = { ...last, entries: [...last.entries, item] }
    else if (answered) shown.push({ type: 'decisions', key: `decisions:${item.key}`, entries: [item] })
    else shown.push(item)
  }
  return shown
}

/** "1 decision · Allowed", "3 decisions · 2 allowed, 1 denied". */
export function decisionSummary(entries: readonly ApprovalItem[]): string {
  if (entries.length === 1) return `1 decision · ${resolvedLabel(entries[0]!)}`
  const counts = new Map<string, number>()
  for (const entry of entries) {
    const label = entry.resolution === 'allow_session' ? 'allowed' : RESOLVED[entry.resolution!].toLowerCase()
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return `${entries.length} decisions · ${[...counts].map(([label, count]) => `${count} ${label}`).join(', ')}`
}
