// Turns a thread's raw event log into what the thread view draws: messages with
// author rows, tool calls collapsed into one activity line each, approvals as
// cards, and small notes. Pure, so it's unit-tested without a browser.
import type { AgentId, ApprovalBehavior } from '../../server/agents/types.ts'
import type { StoredEvent } from '../../server/threads/types.ts'

export type TranscriptItem =
  | { type: 'message'; key: string; author: 'you' | AgentId; text: string; ts: string; showAuthor: boolean }
  | { type: 'step'; key: string; label: string; startedAt: string; endedAt?: string; error?: string }
  | {
      type: 'approval'
      key: string
      requestId: string
      agent: AgentId
      toolName: string
      detail: string
      canAllowForSession: boolean
      resolution?: ApprovalBehavior
    }
  | { type: 'note'; key: string; text: string; tone: 'plain' | 'error' }

export function agentName(agent: AgentId): string {
  return agent === 'codex' ? 'Codex' : 'Claude Code'
}

const basename = (path: string): string => path.split('/').filter(Boolean).pop() ?? path
const clip = (text: string, max = 60): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

function field(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** The main argument of a tool call, for approval cards. */
export function toolDetail(input: unknown): string {
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'id', 'message']) {
    const value = field(input, key)
    if (value) return value
  }
  return typeof input === 'object' && input !== null ? JSON.stringify(input).slice(0, 160) : ''
}

const COCKPIT_TOOLS: Record<string, string> = {
  start_process: 'Start a process',
  stop_process: 'Stop a process',
  list_processes: 'List processes',
  read_process_output: 'Read process output',
  open_preview: 'Open a preview',
}

/** "mcp__cockpit__start_process" → "Start a process"; other MCP tools → "tool (server)". */
export function friendlyToolName(name: string): string {
  const match = /^mcp__(.+?)__(.+)$/.exec(name)
  if (!match) return name
  const [, server = '', tool = ''] = match
  return server === 'cockpit' ? (COCKPIT_TOOLS[tool] ?? tool) : `${tool} (${server})`
}

function describeCockpitTool(tool: string, input: unknown): string {
  switch (tool) {
    case 'start_process':
      return `Starting ${clip(field(input, 'command') ?? 'a process', 48)}`
    case 'stop_process':
      return `Stopping ${field(input, 'id') ?? 'a process'}`
    case 'list_processes':
      return 'Checking running processes'
    case 'read_process_output':
      return `Reading the ${field(input, 'id') ?? 'process'} log`
    case 'open_preview':
      return `Opening the preview${field(input, 'url') ? ` at ${clip(field(input, 'url') ?? '', 40)}` : ''}`
    default:
      return `Using ${tool}`
  }
}

/** A plain-words activity line for a tool call: "Reading README.md", "Running npm test". */
export function describeTool(name: string, input: unknown): string {
  const path = field(input, 'file_path') ?? field(input, 'path')
  if (name.startsWith('mcp__cockpit__')) return describeCockpitTool(name.slice('mcp__cockpit__'.length), input)
  if (name.startsWith('mcp__')) return `Using ${friendlyToolName(name)}`
  switch (name) {
    case 'Bash':
    case 'Shell': {
      const description = field(input, 'description')
      if (description) return clip(description)
      const command = field(input, 'command')
      return command ? `Running ${clip(command, 48)}` : 'Running a command'
    }
    case 'Read':
      return path ? `Reading ${basename(path)}` : 'Reading a file'
    case 'Write':
      return path ? `Writing ${basename(path)}` : 'Writing a file'
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return path ? `Editing ${clip(path.split(', ').map(basename).join(', '), 48)}` : 'Editing files'
    case 'Glob':
      return `Finding files${field(input, 'pattern') ? ` matching ${clip(field(input, 'pattern') ?? '', 40)}` : ''}`
    case 'Grep':
      return `Searching for “${clip(field(input, 'pattern') ?? '', 40)}”`
    case 'WebFetch': {
      const url = field(input, 'url')
      try {
        return url ? `Reading ${new URL(url).host}` : 'Reading a web page'
      } catch {
        return 'Reading a web page'
      }
    }
    case 'WebSearch':
      return `Searching the web for “${clip(field(input, 'query') ?? '', 40)}”`
    case 'TodoWrite':
      return 'Updating the plan'
    case 'Task':
    case 'Agent':
      return `Delegating: ${clip(field(input, 'description') ?? 'a subtask', 48)}`
    default:
      return `Using ${name}`
  }
}

/** m:ss between two timestamps. */
export function elapsed(fromIso: string, toMs: number): string {
  const seconds = Math.max(0, Math.floor((toMs - Date.parse(fromIso)) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

const RESULT_NOTE = (ok: boolean, stopped: boolean | undefined, durationMs: number | undefined): string =>
  `${ok ? 'Turn finished' : stopped ? 'Stopped' : 'Turn failed'}${durationMs ? ` · ${(durationMs / 1000).toFixed(1)}s` : ''}`

export function buildTranscript(events: readonly StoredEvent[], currentAgent: AgentId): TranscriptItem[] {
  const firstSwitch = events.find((e) => e.event.kind === 'agent_switch')?.event
  let agent: AgentId = firstSwitch?.kind === 'agent_switch' ? firstSwitch.from : currentAgent

  const items: TranscriptItem[] = []
  const steps = new Map<string, number>()
  const approvals = new Map<string, number>()
  const replace = (index: number, next: TranscriptItem): void => {
    items.splice(index, 1, next)
  }

  events.forEach(({ ts, event }, index) => {
    const key = `${ts}-${index}`
    const last = items.at(-1)
    switch (event.kind) {
      case 'user_text':
      case 'assistant_text': {
        const author = event.kind === 'user_text' ? 'you' : agent
        const showAuthor = !(last?.type === 'message' && last.author === author)
        items.push({ type: 'message', key, author, text: event.text, ts, showAuthor })
        return
      }
      case 'tool_use':
        steps.set(event.id, items.length)
        items.push({ type: 'step', key, label: describeTool(event.name, event.input), startedAt: ts })
        return
      case 'tool_result': {
        const at = steps.get(event.toolUseId)
        const step = at === undefined ? undefined : items[at]
        if (at !== undefined && step?.type === 'step') {
          replace(at, { ...step, endedAt: ts, ...(event.isError ? { error: clip(event.content, 300) } : {}) })
        }
        return
      }
      case 'approval_request':
        approvals.set(event.requestId, items.length)
        items.push({
          type: 'approval',
          key,
          requestId: event.requestId,
          agent,
          toolName: friendlyToolName(event.toolName),
          detail: toolDetail(event.input),
          canAllowForSession: event.suggestions.length > 0,
        })
        return
      case 'approval_resolved': {
        const at = approvals.get(event.requestId)
        const card = at === undefined ? undefined : items[at]
        if (at !== undefined && card?.type === 'approval') replace(at, { ...card, resolution: event.behavior })
        return
      }
      case 'agent_switch':
        agent = event.to
        items.push({ type: 'note', key, text: `Handed over from ${agentName(event.from)} to ${agentName(event.to)}. The conversation so far goes with it.`, tone: 'plain' })
        return
      case 'result':
        items.push({ type: 'note', key, text: RESULT_NOTE(event.ok, event.stopped, event.durationMs), tone: event.ok || event.stopped ? 'plain' : 'error' })
        return
      case 'error':
        items.push({ type: 'note', key, text: event.message, tone: 'error' })
        return
      default:
        return
    }
  })
  return items
}
