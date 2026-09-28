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
