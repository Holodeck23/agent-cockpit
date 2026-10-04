// Turns a thread's raw event log into what the thread view draws: messages with
// author rows, tool calls collapsed into one activity line each, approvals as
// cards, and small notes. Pure, so it's unit-tested without a browser.
import type { AgentId, AgentQuestion, ApprovalBehavior, WorkflowSnapshot } from '../../server/agents/types.ts'
import type { StoredEvent } from '../../server/threads/types.ts'
import { describeAttachments } from '../../server/files/references.ts'
import { PERMISSION_LABEL } from './permission-labels.ts'
import { parseConclusion, turnRoles } from '../../server/threads/turns.ts'
import { waitingMessages } from '../../server/threads/status.ts'
import { failureWords } from './agent-errors.ts'

/** An image stored with the conversation; `file` names it under /api/threads/:id/images/. */
export interface ImageRef { readonly file: string; readonly name?: string }

export type TranscriptItem =
  | {
      type: 'message'; key: string; author: 'you' | AgentId; text: string; ts: string; showAuthor: boolean; attachments?: string[]; workflows?: readonly WorkflowSnapshot[]
      /** Images you sent with this message. */
      images?: readonly ImageRef[]
      /** Agent messages before the conclusion (U12); absent on conclusions and your messages. */
      fromConversation?: { id: string; title: string }
      phase?: 'acknowledgement' | 'update'
      /** A conclusion that asks you something or reports a blocker; its marker is removed from `text`. */
      conclusion?: 'question' | 'blocker'
      /** Sent mid-turn and not taken by the agent yet (J1): it can still be taken back. */
      queuedId?: string
    }
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
  /** An image the agent showed (G4), or one of yours with no message to sit under. */
  | ({ type: 'image'; key: string; author: 'you' | AgentId; showAuthor: boolean } & ImageRef)
  /** A failed turn or an agent error (J10): plain title, the agent's words, your message to retry. */
  | { type: 'failure'; key: string; title: string; detail: string; raw: string; retryText?: string }
  /** The agent's questions with choices (J6); `answers` once you answered, `dismissed` once you closed them. */
  | { type: 'question'; key: string; requestId: string; agent: AgentId; questions: readonly AgentQuestion[]; answers?: Readonly<Record<string, string>>; dismissed?: boolean }
  /** The agent summarising earlier context to make room (J3); tokens as it reported them. */
  | { type: 'compaction'; key: string; state: 'running' | 'done' | 'failed'; startedAt: string; endedAt?: string; preTokens?: number; postTokens?: number }
  /** A helper agent (J7): what it was asked, what it did, what it said back. */
  | {
      type: 'helper'; key: string; id: string; description: string; state: HelperState
      steps: readonly string[]; answer?: string; startedAt: string; endedAt?: string
    }

export type HelperState = 'running' | 'done' | 'failed' | 'stopped'

/** The agents' own words for how a helper ended, as one of ours. */
export function helperState(status: string | undefined): HelperState {
  if (status === 'failed' || status === 'errored' || status === 'notFound') return 'failed'
  if (status === 'stopped' || status === 'killed' || status === 'interrupted' || status === 'shutdown') return 'stopped'
  return 'done'
}

export function agentName(agent: AgentId): string {
  return agent === 'codex' ? 'Codex' : agent === 'antigravity' ? 'Antigravity' : agent === 'opencode' ? 'OpenCode' : 'Claude Code'
}

const basename = (path: string): string => path.split('/').filter(Boolean).pop() ?? path
const clip = (text: string, max = 60): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

function field(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function firstField(input: unknown, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = field(input, key)
    if (value) return value
  }
  return undefined
}

/** The main argument of a tool call, for approval cards. */
export function toolDetail(input: unknown): string {
  for (const key of ['command', 'CommandLine', 'file_path', 'path', 'AbsolutePath', 'pattern', 'Query', 'url', 'Url', 'query', 'description', 'id', 'message', 'text']) {
    const value = field(input, key)
    if (value) return value
  }
  return typeof input === 'object' && input !== null ? JSON.stringify(input).slice(0, 160) : ''
}

const COCKPIT_TOOLS: Record<string, string> = {
  start_conversation: 'Start a conversation',
  send_to_conversation: 'Send to a conversation',
  stop_conversation: 'Stop a conversation',
  list_conversations: 'List conversations',
  read_conversation: 'Read a conversation',
  start_process: 'Start a process',
  save_workflow: 'Save a workflow',
  stop_process: 'Stop a process',
  list_processes: 'List processes',
  read_process_output: 'Read process output',
  open_preview: 'Open a preview',
  recall: 'Search memory',
  remember: 'Remember',
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
    case 'save_workflow':
      return `Saving workflow ${field(input, 'name') ?? ''}`
    case 'start_process':
      return `Starting ${clip(field(input, 'command') ?? 'a process', 48)}`
    case 'stop_process':
      return `Stopping ${field(input, 'id') ?? 'a process'}`
    case 'list_processes':
      return 'Checking running processes'
    case 'read_process_output':
      return `Reading the ${field(input, 'id') ?? 'process'} log`
    case 'recall':
      return `Searching memory${field(input, 'query') ? ` for “${clip(field(input, 'query') ?? '', 40)}”` : ''}`
    case 'remember':
      return `Remembering: ${clip(field(input, 'text') ?? '', 48)}`
    case 'open_preview':
      return `Opening the preview${field(input, 'url') ? ` at ${clip(field(input, 'url') ?? '', 40)}` : ''}`
    default:
      return `Using ${tool}`
  }
}

/** A plain-words activity line for a tool call: "Reading README.md", "Running npm test". */
export function describeTool(name: string, input: unknown): string {
  const path = firstField(input, 'file_path', 'path', 'AbsolutePath')
  if (name.startsWith('mcp__cockpit__')) return describeCockpitTool(name.slice('mcp__cockpit__'.length), input)
  if (name.startsWith('mcp__')) return `Using ${friendlyToolName(name)}`
  switch (name) {
    case 'Bash':
    case 'Shell':
    case 'run_command': {
      const description = field(input, 'description')
      if (description) return clip(description)
      const command = firstField(input, 'command', 'CommandLine')
      return command ? `Running ${clip(command, 48)}` : 'Running a command'
    }
    case 'Read':
    case 'view_file':
      return path ? `Reading ${basename(path)}` : 'Reading a file'
    case 'Write':
    case 'write_to_file':
      return path ? `Writing ${basename(path)}` : 'Writing a file'
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'replace_file_content':
    case 'multi_replace_file_content':
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
    case 'search_web':
      return `Searching the web for “${clip(firstField(input, 'query', 'Query') ?? '', 40)}”`
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

/**
 * What the agent suggested you might ask next (J2), newest three, from after your last message.
 * Sending anything retires them. Claude emits one per turn when its server enables it.
 */
export function followUpSuggestions(events: readonly StoredEvent[]): string[] {
  const since = events.findLastIndex((e) => e.event.kind === 'user_text') + 1
  const texts = events.slice(since).flatMap(({ event }) => (event.kind === 'suggestion' ? [event.text] : []))
  return [...new Set(texts)].slice(-3)
}

export function buildTranscript(events: readonly StoredEvent[], currentAgent: AgentId): TranscriptItem[] {
  const firstSwitch = events.find((e) => e.event.kind === 'agent_switch')?.event
  let agent: AgentId = firstSwitch?.kind === 'agent_switch' ? firstSwitch.from : currentAgent

  const items: TranscriptItem[] = []
  const roles = turnRoles(events)
  const waiting = new Set(waitingMessages(events))
  // A message you took back went to your draft; it is no longer part of the conversation.
  const takenBack = new Set(events.flatMap((e) => (e.event.kind === 'user_unqueued' ? [e.event.id] : [])))
  const steps = new Map<string, number>()
  const approvals = new Map<string, number>()
  const helpers = new Map<string, number>()
  let compacting: number | undefined
  let lastUserText: string | undefined
  /** Images sent with a message you took back went with it. */
  let skipYourImages = false
  /** A failure card already stands for the current turn, so its failed result adds nothing. */
  let failedThisTurn = false
  const endCompaction = (ts: string, state: 'done' | 'failed', sizes: { preTokens?: number; postTokens?: number } = {}): void => {
    const item = compacting === undefined ? undefined : items[compacting]
    if (compacting !== undefined && item?.type === 'compaction') replace(compacting, { ...item, state, endedAt: ts, ...sizes })
    compacting = undefined
  }
  const replace = (index: number, next: TranscriptItem): void => {
    items.splice(index, 1, next)
  }
  const updateHelper = (id: string, change: (helper: Extract<TranscriptItem, { type: 'helper' }>) => TranscriptItem): void => {
    const at = helpers.get(id)
    const helper = at === undefined ? undefined : items[at]
    if (at !== undefined && helper?.type === 'helper') replace(at, change(helper))
  }
  /** A helper cannot outlive its agent session. */
  const endRunningHelpers = (ts: string): void => {
    for (const id of helpers.keys()) updateHelper(id, (h) => (h.state === 'running' ? { ...h, state: 'stopped', endedAt: ts } : h))
  }

  events.forEach(({ ts, event }, index) => {
    const key = `${ts}-${index}`
    const last = items.at(-1)
    if (event.kind === 'image' && event.from === 'you' && skipYourImages) return
    skipYourImages = false
    switch (event.kind) {
      case 'user_text':
      case 'assistant_text': {
        if (event.kind === 'user_text' && event.queuedId && takenBack.has(event.queuedId)) { skipYourImages = true; return }
        if (event.kind === 'user_text') { lastUserText = event.text; failedThisTurn = false }
        const author = event.kind === 'user_text' ? 'you' : agent
        const showAuthor = !((last?.type === 'message' || last?.type === 'image') && last.author === author)
        if (event.kind === 'user_text') {
          // Attached files show as names; their contents went to the agent, not the transcript.
          const described = describeAttachments(event.text)
          const used = new Set(event.workflows?.map((w) => w.name))
          // A used workflow shows as a clip under the message, so its token leaves the text.
          const text = used.size === 0 ? described.text : described.text
            .replace(/(^|\s)@workflow:([a-z0-9]+(?:-[a-z0-9]+)*)[ \t]?/g, (match, lead: string, name: string) => (used.has(name) ? lead : match))
            .replace(/[ \t]+\n/g, '\n').trim()
          const { attachments } = described
          items.push({ type: 'message', key, author, text, ts, showAuthor, ...(event.fromConversation ? { fromConversation: event.fromConversation } : {}), ...(attachments.length ? { attachments } : {}),
            ...(event.workflows?.length ? { workflows: event.workflows } : {}), ...(event.queuedId && waiting.has(event.queuedId) ? { queuedId: event.queuedId } : {}) })
        } else {
          const role = roles.get(index)
          const parsed = role === 'conclusion' ? parseConclusion(event.text) : undefined
          items.push({ type: 'message', key, author, text: parsed?.text ?? event.text, ts, showAuthor,
            ...(role === 'acknowledgement' || role === 'update' ? { phase: role } : {}),
            ...(parsed && parsed.kind !== 'answer' ? { conclusion: parsed.kind } : {}) })
        }
        return
      }
      case 'image': {
        const ref: ImageRef = { file: event.file, ...(event.name ? { name: event.name } : {}) }
        if (event.from === 'you' && last?.type === 'message' && last.author === 'you') {
          replace(items.length - 1, { ...last, images: [...(last.images ?? []), ref] })
        } else {
          const author = event.from === 'you' ? 'you' : agent
          items.push({ type: 'image', key, author, showAuthor: !((last?.type === 'message' || last?.type === 'image') && last.author === author), ...ref })
        }
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
      case 'question':
        approvals.set(event.requestId, items.length)
        items.push({ type: 'question', key, requestId: event.requestId, agent, questions: event.questions })
        return
      case 'question_answered': {
        const at = approvals.get(event.requestId)
        const card = at === undefined ? undefined : items[at]
        if (at !== undefined && card?.type === 'question') replace(at, { ...card, answers: event.answers, ...(event.dismissed ? { dismissed: true } : {}) })
        return
      }
      case 'approval_resolved': {
        const at = approvals.get(event.requestId)
        const card = at === undefined ? undefined : items[at]
        if (at !== undefined && card?.type === 'approval') replace(at, { ...card, resolution: event.behavior })
        return
      }
      case 'settings_changed': {
        const mode = (PERMISSION_LABEL as Record<string, string>)[event.permissionMode] ?? event.permissionMode
        items.push({ type: 'note', key, text: `Now ${event.model ?? 'the default model'}, ${event.effort ? `${event.effort} effort` : 'default effort'}, ${mode}. Applies from your next message.`, tone: 'plain' })
        return
      }
      case 'branch_changed':
        items.push({ type: 'note', key, text: `The project switched from ${event.from} to ${event.to}${event.byTitle ? ` in “${event.byTitle}”` : ''}. Files here now reflect ${event.to}.`, tone: 'plain' })
        return
      case 'subagent': {
        if (event.phase === 'started') {
          const helper: TranscriptItem = { type: 'helper', key, id: event.id, description: event.description ?? 'A helper', state: 'running', steps: [], startedAt: ts }
          // Claude's own "Delegating" step for the call that started it becomes the helper.
          const stepAt = steps.get(event.id)
          if (stepAt !== undefined && items[stepAt]?.type === 'step') {
            replace(stepAt, { ...helper, startedAt: (items[stepAt] as { startedAt: string }).startedAt })
            helpers.set(event.id, stepAt)
          } else {
            helpers.set(event.id, items.length)
            items.push(helper)
          }
        } else if (event.phase === 'progress') {
          const { tool, text } = event
          updateHelper(event.id, (h) => ({ ...h, ...(tool ? { steps: [...h.steps, describeTool(tool.name, tool.input)] } : {}), ...(text ? { answer: text } : {}) }))
        } else {
          updateHelper(event.id, (h) => ({ ...h, state: helperState(event.status), endedAt: ts }))
        }
        return
      }
      case 'compaction':
        if (event.phase === 'started') {
          compacting = items.length
          items.push({ type: 'compaction', key, state: 'running', startedAt: ts })
        } else if (compacting !== undefined) {
          endCompaction(ts, event.ok === false ? 'failed' : 'done', {
            ...(event.preTokens !== undefined ? { preTokens: event.preTokens } : {}),
            ...(event.postTokens !== undefined ? { postTokens: event.postTokens } : {}),
          })
        } else if (event.ok !== false) {
          // Codex can finish without a start we saw (a resumed session); still say it happened.
          items.push({ type: 'compaction', key, state: 'done', startedAt: ts, endedAt: ts })
        }
        return
      case 'exit':
      case 'session_boundary':
        endRunningHelpers(ts)
        if (compacting !== undefined) endCompaction(ts, 'failed')
        return
      case 'agent_switch':
        endRunningHelpers(ts)
        agent = event.to
        items.push({ type: 'note', key, text: `Handed over from ${agentName(event.from)} to ${agentName(event.to)}. The conversation so far goes with it.`, tone: 'plain' })
        return
      case 'result': {
        if (compacting !== undefined) endCompaction(ts, event.ok ? 'done' : 'failed')
        const failed = !event.ok && !event.stopped
        if (failed && !failedThisTurn) {
          const words = failureWords(event.text)
          items.push({ type: 'failure', key, ...words, raw: event.text ?? '', ...(lastUserText ? { retryText: lastUserText } : {}) })
        } else if (!failed) {
          items.push({ type: 'note', key, text: RESULT_NOTE(event.ok, event.stopped, event.durationMs), tone: 'plain' })
        }
        failedThisTurn = false
        return
      }
      case 'error':
        failedThisTurn = true
        items.push({ type: 'failure', key, ...failureWords(event.message), raw: event.message, ...(lastUserText ? { retryText: lastUserText } : {}) })
        return
      default:
        return
    }
  })
  return items
}
