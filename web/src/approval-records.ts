import type { ApprovalOutcome } from '../../server/agents/types.ts'
import type { StoredEvent } from '../../server/threads/types.ts'

/** Pair a decision only with its own tool call. Never assign it to the next unrelated error. */
export function toolDecisions(events: readonly StoredEvent[]): Map<string, ApprovalOutcome> {
  const result = new Map<string, ApprovalOutcome>()
  const requests = new Map<string, { key?: string }>()
  const calls: { key: string; name: string; input: string; workspace: string }[] = []
  const keyOf = (workspace: string | undefined, id: string): string => `${workspace ?? ''}\n${id}`
  for (const { event, workspaceId } of events) {
    if (event.kind === 'tool_use') calls.push({ key: keyOf(workspaceId, event.id), name: event.name, input: JSON.stringify(event.input), workspace: workspaceId ?? '' })
    if (event.kind === 'approval_request') {
      const matches = calls.filter((call) => call.workspace === (workspaceId ?? '') && call.name === event.toolName && call.input === JSON.stringify(event.input))
      requests.set(event.requestId, { key: event.toolUseId ? keyOf(workspaceId, event.toolUseId) : matches.length === 1 ? matches[0]!.key : undefined })
    }
    if (event.kind === 'approval_resolved') {
      const key = requests.get(event.requestId)?.key
      if (key) result.set(key, event.outcome ?? event.behavior)
    }
    if (event.kind === 'result' || event.kind === 'session_boundary' || event.kind === 'agent_switch') {
      // Keep completed decisions, but do not match identical commands from earlier turns.
      for (let i = calls.length - 1; i >= 0; i--) if (calls[i]!.workspace === (workspaceId ?? '')) calls.splice(i, 1)
    }
  }
  return result
}
