import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '../server/agents/types.ts'
import type { StoredEvent } from '../server/threads/types.ts'
import { buildTranscript, describeTool, elapsed, friendlyToolName, toolDetail } from '../web/src/transcript.ts'

const at = (second: number, event: NormalizedEvent): StoredEvent => ({
  ts: new Date(Date.UTC(2026, 8, 28, 10, 0, second)).toISOString(),
  event,
})

describe('describeTool', () => {
  it('says what the agent is doing in plain words', () => {
    expect(describeTool('Read', { file_path: '/p/src/app.ts' })).toBe('Reading app.ts')
    expect(describeTool('Bash', { command: 'npm test', description: 'Run the tests' })).toBe('Run the tests')
    expect(describeTool('Shell', { command: 'ls -la' })).toBe('Running ls -la')
    expect(describeTool('Edit', { file_path: '/p/a.ts, /p/b.ts' })).toBe('Editing a.ts, b.ts')
    expect(describeTool('Grep', { pattern: 'TODO' })).toBe('Searching for “TODO”')
    expect(describeTool('WebFetch', { url: 'https://example.com/x' })).toBe('Reading example.com')
    expect(describeTool('mcp__thing', {})).toBe('Using mcp__thing')
  })

  it('picks the main argument for approval cards', () => {
    expect(toolDetail({ file_path: '/p/notes.txt', content: 'hi' })).toBe('/p/notes.txt')
    expect(toolDetail({ other: 1 })).toBe('{"other":1}')
  })
})

describe('elapsed', () => {
  it('formats m:ss', () => {
    expect(elapsed('2026-09-28T10:00:00.000Z', Date.parse('2026-09-28T10:01:05.900Z'))).toBe('1:05')
  })
})

describe('buildTranscript', () => {
  it('shows attached files by name without their contents', () => {
    const [item] = buildTranscript([at(0, { kind: 'user_text', text: 'Review @file:src%2Fapp.ts' })], 'claude')
    expect(item).toMatchObject({ type: 'message', author: 'you', text: 'Review', attachments: ['src/app.ts'] })
  })
  it('groups authors, collapses tool calls into timed steps, and folds approvals', () => {
    const items = buildTranscript(
      [
        at(0, { kind: 'user_text', text: 'Make notes' }),
        at(1, { kind: 'assistant_text', messageId: 'm1', text: 'On it.' }),
        at(2, { kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/p/README.md' } }),
        at(5, { kind: 'tool_result', toolUseId: 't1', content: 'ok', isError: false }),
        at(6, { kind: 'approval_request', requestId: 'r1', toolName: 'Write', input: { file_path: '/p/notes.txt' }, suggestions: [{}] }),
        at(8, { kind: 'approval_resolved', requestId: 'r1', behavior: 'allow' }),
        at(9, { kind: 'assistant_text', messageId: 'm2', text: 'Done.' }),
        at(10, { kind: 'assistant_text', messageId: 'm3', text: 'Anything else?' }),
        at(11, { kind: 'result', ok: true, durationMs: 11_000 }),
      ],
      'claude',
    )
    expect(items.map((i) => i.type)).toEqual(['message', 'message', 'step', 'approval', 'message', 'message', 'note'])
    expect(items[2]).toMatchObject({ label: 'Reading README.md', endedAt: '2026-09-28T10:00:05.000Z' })
    expect(items[3]).toMatchObject({ toolName: 'Write', detail: '/p/notes.txt', canAllowForSession: true, resolution: 'allow' })
    expect(items.filter((i) => i.type === 'message').map((i) => (i.type === 'message' ? [i.author, i.showAuthor] : []))).toEqual([
      ['you', true],
      ['claude', true],
      ['claude', true],
      ['claude', false],
    ])
    expect(items[6]).toMatchObject({ text: 'Turn finished · 11.0s', tone: 'plain' })
  })

  it('credits messages to the agent that wrote them across a switch', () => {
    const items = buildTranscript(
      [
        at(0, { kind: 'assistant_text', messageId: 'a', text: 'from claude' }),
        at(1, { kind: 'agent_switch', from: 'claude', to: 'codex' }),
        at(2, { kind: 'assistant_text', messageId: 'b', text: 'from codex' }),
      ],
      'codex',
    )
    expect(items.map((i) => (i.type === 'message' ? i.author : i.type))).toEqual(['claude', 'note', 'codex'])
    expect(items[1]).toMatchObject({ text: 'Handed over from Claude Code to Codex. The conversation so far goes with it.' })
  })

  it('marks failed tool calls and failed turns as errors', () => {
    const items = buildTranscript(
      [
        at(0, { kind: 'tool_use', id: 't', name: 'Bash', input: { command: 'false' } }),
        at(1, { kind: 'tool_result', toolUseId: 't', content: 'exit 1', isError: true }),
        at(2, { kind: 'result', ok: false }),
      ],
      'claude',
    )
    expect(items[0]).toMatchObject({ error: 'exit 1' })
    expect(items[1]).toMatchObject({ text: 'Turn failed', tone: 'error' })
  })
})

describe('workflows used by a message', () => {
  it('carries the snapshot onto the message and leaves older events unchanged', () => {
    const items = buildTranscript([
      at(0, { kind: 'user_text', text: '@workflow:review', workflows: [{ name: 'review', prompt: 'Review the diff' }] }),
      at(1, { kind: 'user_text', text: 'plain' }),
    ], 'claude')
    expect(items[0]).toMatchObject({ type: 'message', workflows: [{ name: 'review', prompt: 'Review the diff' }] })
    expect(items[1]).not.toHaveProperty('workflows')
  })

  it('shows a used workflow as a clip, not as its @workflow token; unknown tokens stay as typed', () => {
    const items = buildTranscript([
      at(0, { kind: 'user_text', text: 'Run @workflow:review on @workflow:ghost today', workflows: [{ name: 'review', prompt: 'Review the diff' }] }),
    ], 'claude')
    expect(items[0]).toMatchObject({ text: 'Run on @workflow:ghost today', workflows: [{ name: 'review' }] })
  })
})

describe('cockpit MCP tools in the transcript', () => {
  it('describes each cockpit tool call in plain words', () => {
    expect(describeTool('mcp__cockpit__start_process', { command: 'npm run dev' })).toBe('Starting npm run dev')
    expect(describeTool('mcp__cockpit__read_process_output', { id: 'proc-1' })).toBe('Reading the proc-1 log')
    expect(describeTool('mcp__cockpit__open_preview', {})).toBe('Opening the preview')
    expect(describeTool('mcp__other__thing', {})).toBe('Using thing (other)')
  })

  it('names MCP tools readably on approval cards', () => {
    expect(friendlyToolName('mcp__cockpit__start_process')).toBe('Start a process')
    expect(friendlyToolName('Bash')).toBe('Bash')
  })
})

describe('branch changes made elsewhere', () => {
  it('say which branch, from where, as a plain note', () => {
    const items = buildTranscript([
      at(0, { kind: 'branch_changed', from: 'main', to: 'feature/login', byTitle: 'Login work' }),
      at(1, { kind: 'branch_changed', from: 'main', to: 'fix' }),
    ], 'claude')
    expect(items).toMatchObject([
      { type: 'note', text: 'The project switched from main to feature/login in “Login work”. Files here now reflect feature/login.' },
      { type: 'note', text: 'The project switched from main to fix. Files here now reflect fix.' },
    ])
  })
})

describe('settings changes', () => {
  it('say what now applies, from the next message', () => {
    const items = buildTranscript([
      at(0, { kind: 'settings_changed', model: 'opus', effort: 'high', permissionMode: 'acceptEdits' }),
      at(1, { kind: 'settings_changed', permissionMode: 'manual' }),
    ], 'claude')
    expect(items).toMatchObject([
      { type: 'note', text: 'Now opus, high effort, Edit files without asking. Applies from your next message.' },
      { type: 'note', text: 'Now the default model, default effort, Ask before acting. Applies from your next message.' },
    ])
  })
})

describe('helpers in the transcript (J7)', () => {
  it("turns Claude's delegating step into a helper with its steps, report and end", () => {
    const items = buildTranscript([
      at(0, { kind: 'user_text', text: 'Count the lines' }),
      at(1, { kind: 'tool_use', id: 'a1', name: 'Agent', input: { description: 'Count lines in notes.txt' } }),
      at(2, { kind: 'subagent', id: 'a1', phase: 'started', description: 'Count lines in notes.txt' }),
      at(2, { kind: 'tool_result', toolUseId: 'a1', content: 'Async agent launched', isError: false }),
      at(3, { kind: 'subagent', id: 'a1', phase: 'progress', tool: { name: 'Read', input: { file_path: '/p/notes.txt' } } }),
      at(4, { kind: 'subagent', id: 'a1', phase: 'progress', lastTool: 'Read' }),
      at(5, { kind: 'subagent', id: 'a1', phase: 'progress', text: '4' }),
      at(7, { kind: 'subagent', id: 'a1', phase: 'finished', status: 'completed' }),
    ], 'claude')
    expect(items.filter((i) => i.type === 'step')).toEqual([])
    expect(items[1]).toMatchObject({ type: 'helper', description: 'Count lines in notes.txt', state: 'done', steps: ['Reading notes.txt'], answer: '4', startedAt: at(1, { kind: 'thread_deleted' }).ts })
  })

  it('shows a Codex helper with no step of its own, and a helper cut off by its session ending as stopped', () => {
    const items = buildTranscript([
      at(0, { kind: 'subagent', id: 'c1', phase: 'started', description: 'Count the lines' }),
      at(1, { kind: 'subagent', id: 'c2', phase: 'started' }),
      at(2, { kind: 'subagent', id: 'c1', phase: 'finished', status: 'failed' }),
      at(3, { kind: 'exit', code: 0 }),
    ], 'codex')
    expect(items.map((i) => i.type === 'helper' && [i.description, i.state])).toEqual([['Count the lines', 'failed'], ['A helper', 'stopped']])
  })
})

describe('compaction in the transcript (J3)', () => {
  it('shows a running line that ends with the sizes, or as failed when the turn fails first', () => {
    const items = buildTranscript([
      at(0, { kind: 'compaction', phase: 'started' }),
      at(22, { kind: 'compaction', phase: 'finished', ok: true, trigger: 'manual', preTokens: 34052, postTokens: 2775 }),
      at(23, { kind: 'result', ok: true }),
      at(30, { kind: 'compaction', phase: 'started' }),
      at(31, { kind: 'result', ok: false }),
    ], 'claude')
    const compactions = items.filter((i) => i.type === 'compaction')
    expect(compactions).toMatchObject([{ state: 'done', preTokens: 34052, postTokens: 2775, endedAt: at(22, { kind: 'thread_deleted' }).ts }, { state: 'failed' }])
  })
})

describe('agent questions in the transcript (J6)', () => {
  const questions = [
    { id: 'Which colour?', question: 'Which colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] },
    { id: 'Which sizes?', question: 'Which sizes?', header: 'Sizes', multiSelect: true, options: [{ label: 'Small' }, { label: 'Large' }] },
  ]
  it('shows the questions as one card that keeps the answers you gave', () => {
    const items = buildTranscript([
      at(0, { kind: 'question', requestId: 'q1', questions }),
      at(5, { kind: 'question_answered', requestId: 'q1', answers: { 'Which colour?': 'Blue', 'Which sizes?': 'Small, Large' } }),
    ], 'claude')
    expect(items).toEqual([expect.objectContaining({ type: 'question', requestId: 'q1', agent: 'claude', questions,
      answers: { 'Which colour?': 'Blue', 'Which sizes?': 'Small, Large' } })])
  })
  it('marks questions you closed without answering', () => {
    const items = buildTranscript([
      at(0, { kind: 'question', requestId: 'q1', questions }),
      at(5, { kind: 'question_answered', requestId: 'q1', answers: {}, dismissed: true }),
    ], 'codex')
    expect(items[0]).toMatchObject({ type: 'question', dismissed: true })
  })
})
