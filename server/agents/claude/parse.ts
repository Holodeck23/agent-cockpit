import { z } from 'zod'
import type { AgentQuestion, NormalizedEvent } from '../types.ts'

// Translates one line of `claude --output-format stream-json` into zero or more
// NormalizedEvents. Unknown message types are ignored, not errors: the CLI adds
// new event types regularly and a cockpit must not break on them.

const textBlock = z.object({ type: z.literal('text'), text: z.string() })
const toolUseBlock = z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() })
const toolResultBlock = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.unknown(),
  is_error: z.boolean().optional(),
})

const lineSchema = z.looseObject({ type: z.string() })

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'object' && part !== null && 'text' in part ? String(part.text) : ''))
      .join('')
  }
  return content === undefined ? '' : JSON.stringify(content)
}

/** The tool call that started the sub-agent this message came from, if it did. */
const parentOf = (raw: Record<string, unknown>): string | undefined =>
  typeof raw.parent_tool_use_id === 'string' ? raw.parent_tool_use_id : undefined

function parseAssistant(raw: Record<string, unknown>): NormalizedEvent[] {
  const message = z.looseObject({ id: z.string(), content: z.array(z.unknown()) }).safeParse(raw.message)
  if (!message.success) return []
  const parent = parentOf(raw)
  const events: NormalizedEvent[] = []
  for (const block of message.data.content) {
    const text = textBlock.safeParse(block)
    if (text.success && text.data.text.length > 0) {
      events.push(parent
        ? { kind: 'subagent', id: parent, phase: 'progress', text: text.data.text }
        : { kind: 'assistant_text', messageId: message.data.id, text: text.data.text })
      continue
    }
    const tool = toolUseBlock.safeParse(block)
    if (!tool.success) continue
    events.push(parent
      ? { kind: 'subagent', id: parent, phase: 'progress', tool: { name: tool.data.name, input: tool.data.input } }
      : { kind: 'tool_use', id: tool.data.id, name: tool.data.name, input: tool.data.input })
  }
  return events
}

function parseUser(raw: Record<string, unknown>): NormalizedEvent[] {
  const message = z.looseObject({ content: z.unknown() }).safeParse(raw.message)
  if (!message.success) return []
  // --replay-user-messages echoes a message you sent at the moment Claude takes it.
  if (raw.isReplay === true) {
    const text = stringifyContent(message.data.content)
    return text.length > 0 && !text.startsWith('<local-command-') ? [{ kind: 'user_taken', text }] : []
  }
  // A sub-agent's tool results stay inside it; its progress already names the tool.
  if (!Array.isArray(message.data.content) || parentOf(raw)) return []
  return message.data.content.flatMap((block): NormalizedEvent[] => {
    const result = toolResultBlock.safeParse(block)
    if (!result.success) return []
    return [
      {
        kind: 'tool_result',
        toolUseId: result.data.tool_use_id,
        content: stringifyContent(result.data.content),
        isError: result.data.is_error ?? false,
      },
    ]
  })
}

const questionSchema = z.object({
  questions: z.array(z.looseObject({
    question: z.string(),
    header: z.string().optional(),
    multiSelect: z.boolean().optional(),
    options: z.array(z.looseObject({ label: z.string(), description: z.string().optional() })).optional(),
  })).min(1),
})

/** AskUserQuestion's input as questions; undefined when it is not the shape we know (then it stays an approval). */
export function claudeQuestions(input: unknown): AgentQuestion[] | undefined {
  const parsed = questionSchema.safeParse(input)
  if (!parsed.success) return undefined
  return parsed.data.questions.map((q) => ({
    id: q.question,
    question: q.question,
    header: q.header ?? '',
    options: (q.options ?? []).map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
    multiSelect: q.multiSelect ?? false,
  }))
}

function parseSystem(raw: Record<string, unknown>): NormalizedEvent[] {
  switch (raw.subtype) {
    case 'init':
      if (typeof raw.session_id !== 'string') return []
      return [
        {
          kind: 'session',
          sessionId: raw.session_id,
          model: typeof raw.model === 'string' ? raw.model : undefined,
          cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
        },
      ]
    case 'status':
      if (raw.status === 'compacting') return [{ kind: 'compaction', phase: 'started' }]
      // Success is reported again, with sizes, by the compact_boundary that follows.
      if (typeof raw.compact_result === 'string' && raw.compact_result !== 'success') return [{ kind: 'compaction', phase: 'finished', ok: false }]
      return []
    case 'compact_boundary': {
      const meta = z.looseObject({ trigger: z.string().optional(), pre_tokens: z.number().optional(), post_tokens: z.number().optional() })
        .safeParse(raw.compact_metadata)
      const m = meta.success ? meta.data : {}
      return [{
        kind: 'compaction', phase: 'finished', ok: true,
        ...(m.trigger ? { trigger: m.trigger } : {}),
        ...(m.pre_tokens !== undefined ? { preTokens: m.pre_tokens } : {}),
        ...(m.post_tokens !== undefined ? { postTokens: m.post_tokens } : {}),
      }]
    }
    case 'task_started':
    case 'task_progress':
    case 'task_notification': {
      if (typeof raw.tool_use_id !== 'string') return []
      const phase = raw.subtype === 'task_started' ? 'started' : raw.subtype === 'task_progress' ? 'progress' : 'finished'
      return [{
        kind: 'subagent', id: raw.tool_use_id, phase,
        ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
        ...(typeof raw.status === 'string' ? { status: raw.status } : {}),
        ...(typeof raw.last_tool_name === 'string' ? { lastTool: raw.last_tool_name } : {}),
      }]
    }
    default:
      return []
  }
}

function parseStreamEvent(raw: Record<string, unknown>): NormalizedEvent[] {
  const parsed = z
    .object({ event: z.looseObject({ type: z.string(), delta: z.looseObject({ type: z.string() }).optional() }) })
    .safeParse(raw)
  if (!parsed.success) return []
  const { event } = parsed.data
  // Only the main agent streams into the reply being written.
  if (typeof raw.parent_tool_use_id === 'string') return []
  if (event.type !== 'content_block_delta' || event.delta?.type !== 'text_delta') return []
  const text = event.delta.text
  return typeof text === 'string' && text.length > 0 ? [{ kind: 'text_delta', text }] : []
}

function parseControlRequest(raw: Record<string, unknown>): NormalizedEvent[] {
  const parsed = z
    .object({
      request_id: z.string(),
      request: z.looseObject({
        subtype: z.string(),
        tool_name: z.string().optional(),
        input: z.unknown(),
        description: z.string().optional(),
        permission_suggestions: z.array(z.unknown()).optional(),
      }),
    })
    .safeParse(raw)
  if (!parsed.success || parsed.data.request.subtype !== 'can_use_tool') return []
  const { request_id, request } = parsed.data
  const questions = request.tool_name === 'AskUserQuestion' ? claudeQuestions(request.input) : undefined
  if (questions) return [{ kind: 'question', requestId: request_id, questions }]
  return [
    {
      kind: 'approval_request',
      requestId: request_id,
      toolName: request.tool_name ?? 'unknown',
      input: request.input,
      description: request.description,
      suggestions: request.permission_suggestions ?? [],
    },
  ]
}

export function parseClaudeLine(line: string): NormalizedEvent[] {
  const trimmed = line.trim()
  if (trimmed.length === 0) return []
  let json: unknown
  try {
    json = JSON.parse(trimmed)
  } catch {
    return [{ kind: 'error', message: `Unparseable agent output: ${trimmed.slice(0, 200)}` }]
  }
  const parsed = lineSchema.safeParse(json)
  if (!parsed.success) return []
  const raw = parsed.data

  switch (raw.type) {
    case 'system':
      return parseSystem(raw)
    case 'prompt_suggestion':
      return typeof raw.suggestion === 'string' && raw.suggestion.trim().length > 0 ? [{ kind: 'suggestion', text: raw.suggestion.trim() }] : []
    case 'stream_event':
      return parseStreamEvent(raw)
    case 'assistant':
      return parseAssistant(raw)
    case 'user':
      return parseUser(raw)
    case 'control_request':
      return parseControlRequest(raw)
    case 'rate_limit_event': {
      const info = z
        .looseObject({
          status: z.string(),
          rateLimitType: z.string(),
          resetsAt: z.number().optional(),
          unifiedWindows: z.record(z.string(), z.looseObject({ utilization: z.number().optional() })).optional(),
        })
        .safeParse(raw.rate_limit_info)
      if (!info.success) return []
      // utilization is 0–1 for the window this event is about, when Claude reports it.
      const utilization = info.data.unifiedWindows?.[info.data.rateLimitType]?.utilization
      return [{
        kind: 'usage',
        limitType: info.data.rateLimitType,
        status: info.data.status,
        resetsAt: info.data.resetsAt,
        ...(utilization === undefined ? {} : { usedPercent: Math.round(utilization * 100) }),
      }]
    }
    case 'result':
      return [
        {
          kind: 'result',
          ok: raw.is_error !== true && raw.subtype === 'success',
          text: typeof raw.result === 'string' ? raw.result : undefined,
          costUsd: typeof raw.total_cost_usd === 'number' ? raw.total_cost_usd : undefined,
          durationMs: typeof raw.duration_ms === 'number' ? raw.duration_ms : undefined,
        },
      ]
    default:
      return []
  }
}
