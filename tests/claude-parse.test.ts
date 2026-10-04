import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseClaudeLine } from '../server/agents/claude/parse.ts'
import type { NormalizedEvent } from '../server/agents/types.ts'

function parseFixture(name: string): NormalizedEvent[] {
  const text = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
  return text.split('\n').flatMap(parseClaudeLine)
}

describe('parseClaudeLine on a real basic turn', () => {
  const events = parseFixture('claude-turn-basic.jsonl')

  it('emits the session id from system/init', () => {
    const session = events.find((e) => e.kind === 'session')
    expect(session).toMatchObject({ kind: 'session', sessionId: '3e6a366b-3f63-435a-a822-c515bd808f9c' })
  })

  it('streams text deltas that add up to the final assistant text', () => {
    const streamed = events.flatMap((e) => (e.kind === 'text_delta' ? [e.text] : [])).join('')
    const final = events.flatMap((e) => (e.kind === 'assistant_text' ? [e.text] : [])).join('')
    expect(final.toLowerCase()).toContain('pong')
    expect(streamed).toBe(final)
  })

  it('reports usage limits and a successful result', () => {
    expect(events.some((e) => e.kind === 'usage' && e.limitType === 'five_hour')).toBe(true)
    // The recorded event carries unifiedWindows.five_hour.utilization 0.24.
    expect(events.find((e) => e.kind === 'usage')).toMatchObject({ usedPercent: 24 })
    const result = events.find((e) => e.kind === 'result')
    expect(result).toMatchObject({ kind: 'result', ok: true })
  })
})

describe('parseClaudeLine on a real approval turn', () => {
  const events = parseFixture('claude-turn-approval.jsonl')

  it('turns can_use_tool into an approval request', () => {
    const approval = events.find((e) => e.kind === 'approval_request')
    expect(approval).toMatchObject({ kind: 'approval_request', toolName: 'Write' })
    if (approval?.kind === 'approval_request') expect(approval.requestId).toMatch(/[0-9a-f-]{36}/)
  })

  it('orders tool_use before its tool_result', () => {
    const useIndex = events.findIndex((e) => e.kind === 'tool_use')
    const resultIndex = events.findIndex((e) => e.kind === 'tool_result')
    expect(useIndex).toBeGreaterThanOrEqual(0)
    expect(resultIndex).toBeGreaterThan(useIndex)
  })
})

describe('parseClaudeLine robustness', () => {
  it('ignores blank lines and unknown types', () => {
    expect(parseClaudeLine('')).toEqual([])
    expect(parseClaudeLine('{"type":"something_new"}')).toEqual([])
  })

  it('reports unparseable output as an error event instead of throwing', () => {
    const [event] = parseClaudeLine('not json')
    expect(event?.kind).toBe('error')
  })
})

describe('parseClaudeLine on a real question, sub-agent and compaction session (Claude 2.1.289)', () => {
  const events = parseFixture('claude-turn-question-subagent-compact.jsonl')

  it('turns AskUserQuestion into a question with its options, not an approval', () => {
    const question = events.find((e) => e.kind === 'question')
    expect(question).toMatchObject({
      kind: 'question',
      questions: [{ id: 'Which colour do you prefer?', header: 'Color preference', multiSelect: false,
        options: [{ label: 'Red', description: 'A warm, bold colour' }, { label: 'Blue', description: 'A cool, calm colour' }] }],
    })
    expect(events.some((e) => e.kind === 'approval_request')).toBe(false)
  })

  it('reports each message you sent at the moment Claude takes it', () => {
    const taken = events.flatMap((e) => (e.kind === 'user_taken' ? [e.text] : []))
    expect(taken).toHaveLength(2)
    expect(taken[0]).toMatch(/^Use the AskUserQuestion tool/)
    // The "Compacted" echo of /compact is the CLI's own output, not your message.
    expect(taken.some((t) => t.includes('local-command'))).toBe(false)
  })

  it('follows the sub-agent from start to finish, keyed by the tool call that started it', () => {
    const sub = events.filter((e) => e.kind === 'subagent' && !e.text && !e.tool)
    expect(sub.map((e) => e.kind === 'subagent' && e.phase)).toEqual(['started', 'progress', 'finished'])
    expect(sub[0]).toMatchObject({ id: 'toolu_01JSTmvfu3LaG9RffEsKuk93', description: 'Count lines in notes.txt' })
    expect(sub[1]).toMatchObject({ lastTool: 'Read' })
    expect(sub[2]).toMatchObject({ status: 'completed' })
  })

  it("reports the sub-agent's own tool calls and words as its progress, never as the main agent's", () => {
    const progress = events.filter((e) => e.kind === 'subagent' && e.phase === 'progress' && (e.text || e.tool))
    expect(progress).toEqual([
      { kind: 'subagent', id: 'toolu_01JSTmvfu3LaG9RffEsKuk93', phase: 'progress', tool: { name: 'Read', input: { file_path: '/tmp/fixture/notes.txt' } } },
      { kind: 'subagent', id: 'toolu_01JSTmvfu3LaG9RffEsKuk93', phase: 'progress', text: '4' },
    ])
    expect(events.filter((e) => e.kind === 'tool_result').map((e) => e.kind === 'tool_result' && e.toolUseId))
      .not.toContain('toolu_018mYgEmH6Zru9cameHyafd8')
    const mainText = events.flatMap((e) => (e.kind === 'assistant_text' ? [e.text] : []))
    expect(mainText).toEqual(['You chose Red.', expect.stringMatching(/^Agent is running/), '4'])
  })

  it('reports compaction as started, then finished with the sizes', () => {
    const compaction = events.filter((e) => e.kind === 'compaction')
    expect(compaction).toEqual([
      { kind: 'compaction', phase: 'started' },
      { kind: 'compaction', phase: 'finished', ok: true, trigger: 'manual', preTokens: 34052, postTokens: 2775 },
    ])
  })
})

describe('parseClaudeLine on shapes this account does not receive', () => {
  it('reads a prompt suggestion (shape from the CLI source; behind a server-side flag)', () => {
    expect(parseClaudeLine(JSON.stringify({ type: 'prompt_suggestion', suggestion: ' Run the tests ', uuid: 'u', session_id: 's' })))
      .toEqual([{ kind: 'suggestion', text: 'Run the tests' }])
    expect(parseClaudeLine(JSON.stringify({ type: 'prompt_suggestion', suggestion: '  ' }))).toEqual([])
  })

  it('reports a failed compaction', () => {
    expect(parseClaudeLine(JSON.stringify({ type: 'system', subtype: 'status', status: null, compact_result: 'failed' })))
      .toEqual([{ kind: 'compaction', phase: 'finished', ok: false }])
  })

  it('keeps an AskUserQuestion it cannot read as an ordinary approval', () => {
    const [event] = parseClaudeLine(JSON.stringify({ type: 'control_request', request_id: 'r1',
      request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [] } } }))
    expect(event).toMatchObject({ kind: 'approval_request', toolName: 'AskUserQuestion' })
  })
})

describe('images Claude shows (G4)', () => {
  it('a tool result holding an image (Read of a PNG, recorded from 2.1.289) emits its bytes once', async () => {
    const { readFileSync } = await import('node:fs')
    const lines = readFileSync(new URL('./fixtures/claude-2.1.289-image.jsonl', import.meta.url), 'utf8').trim().split('\n')
    const events = lines.flatMap((line) => parseClaudeLine(line))
    const images = events.filter((e) => e.kind === 'image_data')
    expect(images).toHaveLength(1)
    expect(images[0]).toMatchObject({ kind: 'image_data', source: { data: expect.stringMatching(/^iVBORw0KGgo/) } })
    // The step still ends, and the text before and after it is still the reply.
    expect(events.find((e) => e.kind === 'tool_result')).toMatchObject({ toolUseId: 'toolu_01DZNPhL5QCGQGVBuZdfPA6N', isError: false })
    expect(events.filter((e) => e.kind === 'assistant_text').map((e) => (e as { text: string }).text)).toEqual(['Calculator icon on light gray.\n\nNow let me read the icon.png file:', 'Calculator icon with button grid.'])
  })
  it('a helper’s images stay inside the helper', () => {
    const line = JSON.stringify({ type: 'user', parent_tool_use_id: 'toolu_parent', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] }] } })
    expect(parseClaudeLine(line)).toEqual([])
  })
})
