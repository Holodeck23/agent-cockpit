import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { codexPolicy } from '../server/agents/codex/launch.ts'
import { createCodexStreamState, parseCodexNotification } from '../server/agents/codex/parse.ts'
import type { NormalizedEvent } from '../server/agents/types.ts'

function parseFixture(name: string, state = createCodexStreamState()): NormalizedEvent[] {
  const lines = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').split('\n').filter(Boolean)
  return lines.flatMap((line) => {
    const message = JSON.parse(line) as { method?: string; params?: unknown; id?: unknown }
    return message.method && message.id === undefined ? parseCodexNotification(message.method, message.params, state) : []
  })
}

describe('parseCodexNotification on a real app-server turn', () => {
  const events = parseFixture('codex-turn-filechange.jsonl')

  it('reports the Codex thread id as the session', () => {
    expect(events[0]).toMatchObject({ kind: 'session', sessionId: '01a0e923-bb6e-7322-847b-80db7128d241' })
  })

  it('shows the shell command and the file edit as tool uses', () => {
    const tools = events.flatMap((e) => (e.kind === 'tool_use' ? [e.name] : []))
    expect(tools).toEqual(['Shell', 'Edit'])
  })

  it('ends with the final answer and a successful result', () => {
    const texts = events.flatMap((e) => (e.kind === 'assistant_text' ? [e.text] : []))
    expect(texts.at(-1)).toBe('done')
    expect(events.at(-1)).toMatchObject({ kind: 'result', ok: true })
  })

  it('reports five-hour usage', () => {
    expect(events.some((e) => e.kind === 'usage' && e.status === '0% used' && e.usedPercent === 0)).toBe(true)
  })
})

describe('codex turn outcomes and policy', () => {
  it('marks an interrupted turn as stopped', () => {
    expect(parseCodexNotification('turn/completed', { turn: { status: 'interrupted' } })).toEqual([
      { kind: 'result', ok: false, stopped: true },
    ])
  })

  it('suppresses errors Codex will retry', () => {
    expect(parseCodexNotification('error', { error: { message: 'x' }, willRetry: true })).toEqual([])
  })

  it('maps cockpit permission modes to approval policy and sandbox', () => {
    expect(codexPolicy('manual')).toEqual({ approvalPolicy: 'on-request', sandbox: 'workspace-write' })
    expect(codexPolicy('plan').sandbox).toBe('read-only')
    expect(codexPolicy('bypassPermissions')).toEqual({ approvalPolicy: 'never', sandbox: 'danger-full-access' })
  })
})

describe('parseCodexNotification for MCP tool calls', () => {
  const item = { type: 'mcpToolCall', id: 'call_1', server: 'cockpit', tool: 'list_processes', arguments: {}, status: 'inProgress' }

  it('names the call like Claude does, mcp__server__tool', () => {
    expect(parseCodexNotification('item/started', { item })).toEqual([
      { kind: 'tool_use', id: 'call_1', name: 'mcp__cockpit__list_processes', input: {} },
    ])
  })

  it('reports the text result, or the error on failure', () => {
    const result = { content: [{ type: 'text', text: 'No processes for this project.' }], structuredContent: null, _meta: null }
    expect(parseCodexNotification('item/completed', { item: { ...item, status: 'completed', result, error: null } })).toEqual([
      { kind: 'tool_result', toolUseId: 'call_1', content: 'No processes for this project.', isError: false },
    ])
    expect(
      parseCodexNotification('item/completed', { item: { ...item, status: 'failed', result: null, error: { message: 'boom' } } }),
    ).toEqual([{ kind: 'tool_result', toolUseId: 'call_1', content: 'boom', isError: true }])
  })
})

describe('parseCodexNotification on a real sub-agent and compaction session (codex-cli 0.147.0)', () => {
  const events = parseFixture('codex-turn-subagent-compact.jsonl')
  const spawn = 'call_WWChFUCUyVTtr6eHi80nyZUa'

  it('reports one session: the conversation thread, never the helper thread', () => {
    expect(events.filter((e) => e.kind === 'session')).toEqual([{ kind: 'session', sessionId: '01a105a3-5f89-7a01-a6e1-ba8aaced4048' }])
  })

  it('follows the helper from its spawn call to the end of its own turn', () => {
    const sub = events.filter((e) => e.kind === 'subagent' && e.phase !== 'progress')
    expect(sub).toEqual([
      { kind: 'subagent', id: spawn, phase: 'started', description: expect.stringMatching(/^Count the number of lines in notes\.txt/) },
      { kind: 'subagent', id: spawn, phase: 'finished', status: 'completed' },
    ])
  })

  it("reports the helper's words and command as its progress, and keeps its turn end out of the main turn", () => {
    const progress = events.filter((e) => e.kind === 'subagent' && e.phase === 'progress')
    expect(progress.map((e) => e.kind === 'subagent' && (e.tool ? `tool:${e.tool.name}` : 'text'))).toEqual(['text', 'tool:Shell', 'text'])
    expect(progress.every((e) => e.kind === 'subagent' && e.id === spawn)).toBe(true)
    // Main turns: the two you sent (the recorder cut the second short) and the compaction turn; never the helper's.
    expect(events.filter((e) => e.kind === 'result')).toHaveLength(3)
    expect(events.filter((e) => e.kind === 'assistant_text').map((e) => e.kind === 'assistant_text' && e.text))
      .toEqual(['ok', expect.stringMatching(/^I’ll use the multi-agent tool/)])
  })

  it("reports each of your messages as taken, and not the helper's instructions", () => {
    expect(events.flatMap((e) => (e.kind === 'user_taken' ? [e.text] : []))).toEqual([
      'Reply with the single word ok.',
      'Spawn one sub-agent to count the lines in notes.txt, wait for it, then tell me the number.',
    ])
  })

  it('reports compaction as started and finished', () => {
    expect(events.filter((e) => e.kind === 'compaction')).toEqual([
      { kind: 'compaction', phase: 'started' },
      { kind: 'compaction', phase: 'finished', ok: true },
    ])
  })

  it('marks a spawn that started no helper as finished at once', () => {
    const state = createCodexStreamState()
    parseCodexNotification('thread/started', { thread: { id: 'main' } }, state)
    expect(parseCodexNotification('item/completed', { threadId: 'main', item: { type: 'collabAgentToolCall', id: 'c1', tool: 'spawnAgent', status: 'failed', receiverThreadIds: [] } }, state))
      .toEqual([{ kind: 'subagent', id: 'c1', phase: 'finished', status: 'failed' }])
  })
})

describe('images Codex shows (G4)', () => {
  it('imageView names the file the agent looked at', () => {
    expect(parseCodexNotification('item/completed', { item: { type: 'imageView', id: 'i1', path: '/p/shot.png' } }))
      .toEqual([{ kind: 'image_data', source: { path: '/p/shot.png' } }])
  })
  it('imageGeneration gives its saved file, or else its base64 result; a failed one gives nothing', () => {
    expect(parseCodexNotification('item/completed', { item: { type: 'imageGeneration', id: 'g1', status: 'completed', revisedPrompt: null, result: 'iVBORw0KGgo=', savedPath: '/home/.codex/generated/g1.png' } }))
      .toEqual([{ kind: 'image_data', source: { path: '/home/.codex/generated/g1.png' } }])
    expect(parseCodexNotification('item/completed', { item: { type: 'imageGeneration', id: 'g2', status: 'completed', revisedPrompt: 'a cat', result: 'iVBORw0KGgo=' } }))
      .toEqual([{ kind: 'image_data', source: { data: 'iVBORw0KGgo=' }, name: 'a cat' }])
    expect(parseCodexNotification('item/completed', { item: { type: 'imageGeneration', id: 'g3', status: 'failed', revisedPrompt: null, result: '' } })).toEqual([])
    expect(parseCodexNotification('item/started', { item: { type: 'imageView', id: 'i2', path: '/p/x.png' } })).toEqual([])
  })
})
