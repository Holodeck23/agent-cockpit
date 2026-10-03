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
