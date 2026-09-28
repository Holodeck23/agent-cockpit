import { z } from 'zod'
import type { NormalizedEvent } from '../types.ts'

// Maps `codex app-server` notifications (JSON-RPC, no "jsonrpc" field) into
// NormalizedEvents. Server->client *requests* (approvals) are handled in
// launch.ts because they need a reply.

const itemSchema = z.looseObject({ type: z.string(), id: z.string() })

function itemStarted(item: z.infer<typeof itemSchema>): NormalizedEvent[] {
  if (item.type === 'commandExecution' && typeof item.command === 'string') {
    return [{ kind: 'tool_use', id: item.id, name: 'Shell', input: { command: item.command } }]
  }
  if (item.type === 'fileChange' && Array.isArray(item.changes)) {
    const paths = item.changes.flatMap((c: unknown) =>
      typeof c === 'object' && c !== null && 'path' in c && typeof c.path === 'string' ? [c.path] : [],
    )
    return [{ kind: 'tool_use', id: item.id, name: 'Edit', input: { file_path: paths.join(', ') } }]
  }
  return []
}

function itemCompleted(item: z.infer<typeof itemSchema>): NormalizedEvent[] {
  if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text.length > 0) {
    return [{ kind: 'assistant_text', messageId: item.id, text: item.text }]
  }
  if (item.type === 'commandExecution') {
    const failed = typeof item.exitCode === 'number' && item.exitCode !== 0
    const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ''
    return [{ kind: 'tool_result', toolUseId: item.id, content: output.slice(0, 4000), isError: failed }]
  }
  if (item.type === 'fileChange') {
    return [{ kind: 'tool_result', toolUseId: item.id, content: String(item.status ?? ''), isError: item.status === 'failed' }]
  }
  return []
}

export function parseCodexNotification(method: string, params: unknown): NormalizedEvent[] {
  const p = z.looseObject({}).safeParse(params)
  if (!p.success) return []
  const data = p.data

  switch (method) {
    case 'thread/started': {
      const thread = z.looseObject({ id: z.string() }).safeParse(data.thread)
      return thread.success ? [{ kind: 'session', sessionId: thread.data.id }] : []
    }
    case 'item/agentMessage/delta':
      return typeof data.delta === 'string' && data.delta.length > 0 ? [{ kind: 'text_delta', text: data.delta }] : []
    case 'item/started': {
      const item = itemSchema.safeParse(data.item)
      return item.success ? itemStarted(item.data) : []
    }
    case 'item/completed': {
      const item = itemSchema.safeParse(data.item)
      return item.success ? itemCompleted(item.data) : []
    }
    case 'account/rateLimits/updated': {
      const limits = z
        .looseObject({ primary: z.looseObject({ usedPercent: z.number(), resetsAt: z.number().optional() }).nullable() })
        .safeParse(data.rateLimits)
      if (!limits.success || !limits.data.primary) return []
      const { usedPercent, resetsAt } = limits.data.primary
      return [
        { kind: 'usage', limitType: 'five_hour', status: usedPercent >= 100 ? 'rejected' : `${usedPercent}% used`, resetsAt },
      ]
    }
    case 'turn/completed': {
      const turn = z.looseObject({ status: z.string() }).safeParse(data.turn)
      const status = turn.success ? turn.data.status : 'failed'
      return [{ kind: 'result', ok: status === 'completed', ...(status === 'interrupted' ? { stopped: true } : {}) }]
    }
    case 'error': {
      const error = z.looseObject({ message: z.string() }).safeParse(data.error)
      if (data.willRetry === true) return []
      return [{ kind: 'error', message: error.success ? error.data.message.slice(0, 1000) : 'Codex reported an error' }]
    }
    default:
      return []
  }
}
