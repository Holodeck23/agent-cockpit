import { z } from 'zod'
import type { NormalizedEvent } from '../types.ts'

// Maps `codex app-server` notifications (JSON-RPC, no "jsonrpc" field) into
// NormalizedEvents. Server->client *requests* (approvals) are handled in
// launch.ts because they need a reply.

const itemSchema = z.looseObject({ type: z.string(), id: z.string() })

/**
 * Sub-agents run as their own Codex threads and report on the same stream. The first thread
 * started is the conversation's; a spawnAgent call names each helper thread it started.
 */
export interface CodexStreamState {
  mainThreadId?: string
  /** Helper thread id -> the spawnAgent call that started it. */
  readonly children: Map<string, string>
}

export const createCodexStreamState = (): CodexStreamState => ({ children: new Map() })

const firstLine = (text: string): string => {
  const line = text.split('\n')[0]!.trim()
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

/** What a helper thread reports: its words and tool calls as its progress, its turn's end as its finish. */
function childEvents(parentId: string, method: string, data: Record<string, unknown>): NormalizedEvent[] {
  if (method === 'item/started' || method === 'item/completed') {
    const item = itemSchema.safeParse(data.item)
    if (!item.success || item.data.type === 'userMessage') return []
    const events = method === 'item/started' ? itemStarted(item.data) : itemCompleted(item.data)
    return events.flatMap((e): NormalizedEvent[] =>
      e.kind === 'assistant_text' ? [{ kind: 'subagent', id: parentId, phase: 'progress', text: e.text }]
      : e.kind === 'tool_use' ? [{ kind: 'subagent', id: parentId, phase: 'progress', tool: { name: e.name, input: e.input } }]
      : [])
  }
  if (method === 'turn/completed') {
    const turn = z.looseObject({ status: z.string() }).safeParse(data.turn)
    return [{ kind: 'subagent', id: parentId, phase: 'finished', status: turn.success ? turn.data.status : 'failed' }]
  }
  return []
}

function collabEvents(method: string, item: z.infer<typeof itemSchema>, state: CodexStreamState | undefined): NormalizedEvent[] {
  if (item.tool !== 'spawnAgent') return []
  if (method === 'item/started') {
    const prompt = typeof item.prompt === 'string' ? firstLine(item.prompt) : ''
    return [{ kind: 'subagent', id: item.id, phase: 'started', ...(prompt ? { description: prompt } : {}) }]
  }
  const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter((t): t is string => typeof t === 'string') : []
  for (const thread of receivers) state?.children.set(thread, item.id)
  // A spawn that started nothing will never report a finish of its own.
  return item.status === 'failed' || receivers.length === 0 ? [{ kind: 'subagent', id: item.id, phase: 'finished', status: 'failed' }] : []
}

function itemStarted(item: z.infer<typeof itemSchema>): NormalizedEvent[] {
  if (item.type === 'contextCompaction') return [{ kind: 'compaction', phase: 'started' }]
  if (item.type === 'commandExecution' && typeof item.command === 'string') {
    return [{ kind: 'tool_use', id: item.id, name: 'Shell', input: { command: item.command } }]
  }
  if (item.type === 'fileChange' && Array.isArray(item.changes)) {
    const paths = item.changes.flatMap((c: unknown) =>
      typeof c === 'object' && c !== null && 'path' in c && typeof c.path === 'string' ? [c.path] : [],
    )
    return [{ kind: 'tool_use', id: item.id, name: 'Edit', input: { file_path: paths.join(', ') } }]
  }
  if (item.type === 'mcpToolCall' && typeof item.server === 'string' && typeof item.tool === 'string') {
    // Same naming as Claude (mcp__server__tool), so the UI labels both agents' calls alike.
    return [{ kind: 'tool_use', id: item.id, name: `mcp__${item.server}__${item.tool}`, input: item.arguments ?? {} }]
  }
  return []
}

function mcpResultText(item: z.infer<typeof itemSchema>): string {
  const error = z.object({ message: z.string() }).safeParse(item.error)
  if (error.success) return error.data.message
  const result = z.object({ content: z.array(z.looseObject({ text: z.string().optional() })) }).safeParse(item.result)
  return result.success ? result.data.content.flatMap((c) => (c.text ? [c.text] : [])).join('\n') : ''
}

function userMessageText(item: z.infer<typeof itemSchema>): string {
  if (!Array.isArray(item.content)) return ''
  return item.content.flatMap((c: unknown) =>
    typeof c === 'object' && c !== null && 'text' in c && typeof c.text === 'string' ? [c.text] : []).join('')
}

function itemCompleted(item: z.infer<typeof itemSchema>): NormalizedEvent[] {
  if (item.type === 'contextCompaction') return [{ kind: 'compaction', phase: 'finished', ok: true }]
  // Codex has taken a message you sent (J1 spike: this is its "taken" signal, also for a steered message).
  if (item.type === 'userMessage') {
    const text = userMessageText(item)
    return text.length > 0 ? [{ kind: 'user_taken', text }] : []
  }
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
  if (item.type === 'mcpToolCall') {
    return [{ kind: 'tool_result', toolUseId: item.id, content: mcpResultText(item).slice(0, 4000), isError: item.status === 'failed' }]
  }
  return []
}

export function parseCodexNotification(method: string, params: unknown, state?: CodexStreamState): NormalizedEvent[] {
  const p = z.looseObject({}).safeParse(params)
  if (!p.success) return []
  const data = p.data

  if (state?.mainThreadId && typeof data.threadId === 'string' && data.threadId !== state.mainThreadId) {
    const parentId = state.children.get(data.threadId)
    return parentId ? childEvents(parentId, method, data) : []
  }

  switch (method) {
    case 'thread/started': {
      const thread = z.looseObject({ id: z.string() }).safeParse(data.thread)
      if (!thread.success) return []
      if (state && !state.mainThreadId) state.mainThreadId = thread.data.id
      return thread.data.id === state?.mainThreadId || !state ? [{ kind: 'session', sessionId: thread.data.id }] : []
    }
    case 'item/agentMessage/delta':
      return typeof data.delta === 'string' && data.delta.length > 0 ? [{ kind: 'text_delta', text: data.delta }] : []
    case 'item/started':
    case 'item/completed': {
      const item = itemSchema.safeParse(data.item)
      if (!item.success) return []
      if (item.data.type === 'collabAgentToolCall') return collabEvents(method, item.data, state)
      return method === 'item/started' ? itemStarted(item.data) : itemCompleted(item.data)
    }
    case 'account/rateLimits/updated': {
      const limits = z
        .looseObject({ primary: z.looseObject({ usedPercent: z.number(), resetsAt: z.number().optional() }).nullable() })
        .safeParse(data.rateLimits)
      if (!limits.success || !limits.data.primary) return []
      const { usedPercent, resetsAt } = limits.data.primary
      return [
        { kind: 'usage', limitType: 'five_hour', status: usedPercent >= 100 ? 'rejected' : `${usedPercent}% used`, resetsAt, usedPercent },
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
