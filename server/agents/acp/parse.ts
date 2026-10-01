import type { NormalizedEvent } from '../types.ts'

// Agent Client Protocol (https://agentclientprotocol.com) session/update notifications → Cockpit events.
// Text arrives in chunks; the launcher collects them into one assistant message per run of chunks
// (ended by a tool call or the end of the turn). Tool calls carry a kind, a title and, usually, the
// raw input; they are named like the other agents' steps so the transcript reads the same.

interface ToolCallLike {
  readonly toolCallId?: unknown
  readonly title?: unknown
  readonly kind?: unknown
  readonly rawInput?: unknown
  readonly locations?: unknown
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
const firstPath = (locations: unknown): string | undefined =>
  Array.isArray(locations) ? str((locations[0] as { path?: unknown } | undefined)?.path) : undefined

/** A Cockpit tool name and input for an ACP tool call, so steps and approval cards read like Claude's. */
export function acpTool(call: ToolCallLike): { name: string; input: Record<string, unknown> } {
  const raw = (call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {}) as Record<string, unknown>
  const title = str(call.title) ?? 'a step'
  const path = str(raw.filePath) ?? str(raw.file_path) ?? str(raw.path) ?? firstPath(call.locations)
  switch (call.kind) {
    case 'execute':
      return { name: 'Shell', input: { command: str(raw.command) ?? title, ...(str(raw.description) ? { description: raw.description } : {}) } }
    case 'edit':
    case 'delete':
    case 'move':
      return { name: 'Edit', input: { file_path: path ?? title } }
    case 'read':
      return { name: 'Read', input: { file_path: path ?? title } }
    case 'search':
      return { name: 'Grep', input: { pattern: str(raw.pattern) ?? str(raw.query) ?? title } }
    case 'fetch':
      return { name: 'WebFetch', input: { url: str(raw.url) ?? title } }
    default:
      return { name: title, input: raw }
  }
}

/** The text of a tool call's output content, if it has any. */
function toolOutput(content: unknown, rawOutput: unknown): string {
  if (Array.isArray(content)) {
    const texts = content.flatMap((c) => {
      const inner = (c as { content?: { text?: unknown } }).content
      return typeof inner?.text === 'string' ? [inner.text] : []
    })
    if (texts.length) return texts.join('\n')
  }
  if (typeof rawOutput === 'string') return rawOutput
  return rawOutput === undefined ? '' : JSON.stringify(rawOutput)
}

export type AcpUpdate =
  | { type: 'text'; text: string }
  | { type: 'events'; events: NormalizedEvent[] }
  | { type: 'ignore' }

/** One session/update notification. Text chunks are returned as text for the launcher to collect. */
export function parseAcpUpdate(params: unknown): AcpUpdate {
  const update = ((params ?? {}) as { update?: Record<string, unknown> }).update
  if (!update) return { type: 'ignore' }
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const content = update.content as { type?: string; text?: unknown } | undefined
      return content?.type === 'text' && typeof content.text === 'string' ? { type: 'text', text: content.text } : { type: 'ignore' }
    }
    case 'tool_call': {
      const id = str(update.toolCallId)
      if (!id) return { type: 'ignore' }
      const events: NormalizedEvent[] = [{ kind: 'tool_use', id, ...acpTool(update) }]
      // Some agents report a call already finished.
      if (update.status === 'completed' || update.status === 'failed') {
        events.push({ kind: 'tool_result', toolUseId: id, content: toolOutput(update.content, update.rawOutput).slice(0, 4000), isError: update.status === 'failed' })
      }
      return { type: 'events', events }
    }
    case 'tool_call_update': {
      const id = str(update.toolCallId)
      if (!id || (update.status !== 'completed' && update.status !== 'failed')) return { type: 'ignore' }
      return { type: 'events', events: [{ kind: 'tool_result', toolUseId: id, content: toolOutput(update.content, update.rawOutput).slice(0, 4000), isError: update.status === 'failed' }] }
    }
    default:
      // Thoughts, plans, mode and command lists are not part of the conversation.
      return { type: 'ignore' }
  }
}

/** session/prompt's stopReason as the end of a Cockpit turn. */
export function acpTurnEnd(stopReason: unknown): NormalizedEvent {
  if (stopReason === 'cancelled') return { kind: 'result', ok: false, stopped: true }
  return { kind: 'result', ok: stopReason !== 'refusal' }
}
