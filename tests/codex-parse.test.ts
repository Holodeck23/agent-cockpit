import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { codexPolicy } from '../server/agents/codex/launch.ts'
import { parseCodexNotification } from '../server/agents/codex/parse.ts'
import type { NormalizedEvent } from '../server/agents/types.ts'

function parseFixture(name: string): NormalizedEvent[] {
  const lines = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').split('\n').filter(Boolean)
  return lines.flatMap((line) => {
    const message = JSON.parse(line) as { method?: string; params?: unknown; id?: unknown }
    return message.method && message.id === undefined ? parseCodexNotification(message.method, message.params) : []
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
    expect(events.some((e) => e.kind === 'usage' && e.status === '0% used')).toBe(true)
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
