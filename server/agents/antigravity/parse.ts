import { z } from 'zod'
import type { NormalizedEvent } from '../types.ts'

// Antigravity's print mode emits one NDJSON object per event. Keep this parser
// deliberately tolerant: new step types must not break an existing Cockpit.

const lineSchema = z.looseObject({ event: z.string() })

const toolStepSchema = z.looseObject({
  conversation_id: z.string(),
  step_index: z.number(),
  state: z.string(),
  step_type: z.literal('tool'),
  tool_name: z.string().optional(),
  tool_info: z.looseObject({
    name: z.string().optional(),
    parameters: z.unknown().optional(),
    output: z.unknown().optional(),
    error: z.looseObject({ message: z.string().optional() }).optional(),
  }),
})

const responseStepSchema = z.looseObject({
  step_type: z.literal('agent_response'),
  text_delta: z.string().optional(),
})

const resultSchema = z.looseObject({
  conversation_id: z.string(),
  status: z.string(),
  response: z.string().optional(),
  error: z.string().optional(),
  duration_seconds: z.number().optional(),
  num_turns: z.number().optional(),
})

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function toolId(step: z.infer<typeof toolStepSchema>): string {
  return `antigravity:${step.conversation_id}:${step.step_index}`
}

function parseStep(value: unknown): NormalizedEvent[] {
  const response = responseStepSchema.safeParse(value)
  if (response.success) {
    const text = response.data.text_delta
    return text ? [{ kind: 'text_delta', text }] : []
  }

  const tool = toolStepSchema.safeParse(value)
  if (!tool.success) return []
  const { data } = tool
  const name = data.tool_name ?? data.tool_info.name ?? 'unknown'
  if (data.state === 'ACTIVE') {
    return [{ kind: 'tool_use', id: toolId(data), name, input: data.tool_info.parameters ?? {} }]
  }
  if (data.state !== 'DONE' && data.state !== 'ERROR') return []
  const error = data.tool_info.error?.message
  return [{
    kind: 'tool_result',
    toolUseId: toolId(data),
    content: error ?? stringify(data.tool_info.output),
    isError: data.state === 'ERROR' || Boolean(error),
  }]
}

export function parseAntigravityLine(line: string): NormalizedEvent[] {
  const trimmed = line.trim()
  if (!trimmed) return []
  let json: unknown
  try {
    json = JSON.parse(trimmed)
  } catch {
    return [{ kind: 'error', message: `Unparseable agent output: ${trimmed.slice(0, 200)}` }]
  }
  const parsed = lineSchema.safeParse(json)
  if (!parsed.success) return []
  const raw = parsed.data

  if (raw.event === 'init') {
    if (typeof raw.conversation_id !== 'string') return []
    const init = typeof raw.init === 'object' && raw.init !== null ? raw.init as Record<string, unknown> : {}
    return [{
      kind: 'session',
      sessionId: raw.conversation_id,
      model: typeof init.model === 'string' ? init.model : undefined,
      cwd: typeof init.cwd === 'string' ? init.cwd : undefined,
    }]
  }
  if (raw.event === 'step_update') return parseStep(raw.step_update)
  if (raw.event !== 'result') return []

  const result = resultSchema.safeParse(raw.result)
  if (!result.success) return []
  const { data } = result
  const events: NormalizedEvent[] = []
  if (data.response) {
    events.push({
      kind: 'assistant_text',
      messageId: `antigravity:${data.conversation_id}:${data.num_turns ?? 0}`,
      text: data.response,
    })
  }
  events.push({
    kind: 'result',
    ok: data.status === 'SUCCESS',
    text: data.error || data.response,
    durationMs: data.duration_seconds === undefined ? undefined : Math.round(data.duration_seconds * 1000),
  })
  return events
}
