import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '../../server/agents/types.ts'
import type { StoredEvent } from '../../server/threads/types.ts'
import { turnRoles } from '../../server/threads/turns.ts'
import { buildTranscript } from '../../web/src/transcript.ts'

const log = (...events: NormalizedEvent[]): StoredEvent[] => events.map((event, i) => ({ ts: `2026-10-01T10:00:${String(i).padStart(2, '0')}Z`, event }))
const says = (text: string): NormalizedEvent => ({ kind: 'assistant_text', messageId: text, text })
const tool = (id: string): NormalizedEvent => ({ kind: 'tool_use', id, name: 'Bash', input: { command: 'ls' } })
const rolesOf = (events: StoredEvent[]) => [...turnRoles(events).entries()].map(([i, role]) => `${(events[i]!.event as { text: string }).text}=${role}`)

describe('u17-2: a message queued mid-turn is not the end of the running turn', () => {
  it('the running turn keeps one acknowledgement, updates, and a single conclusion at the result', () => {
    const events = log(
      { kind: 'user_text', text: 'go' },
      says('Looking'),
      tool('t1'),
      says('Found part 1'),
      { kind: 'user_text', text: 'also do X', queuedId: 'q1' },
      tool('t2'),
      says('Done all'),
      { kind: 'result', ok: true },
    )
    expect(rolesOf(events)).toEqual(['Looking=acknowledgement', 'Found part 1=update', 'Done all=conclusion'])
  })

  it('a turn still running (queued message, no result yet) has no conclusion', () => {
    const events = log(
      { kind: 'user_text', text: 'go' },
      says('Looking'),
      tool('t1'),
      says('Found part 1'),
      { kind: 'user_text', text: 'also do X', queuedId: 'q1' },
      tool('t2'),
      says('Still going'),
    )
    expect([...turnRoles(events).values()]).not.toContain('conclusion')
  })

  it('the transcript shows the interim message as a compact update, not as a conclusion bubble', () => {
    const events = log(
      { kind: 'user_text', text: 'go' },
      says('Looking'),
      tool('t1'),
      says('Found part 1'),
      { kind: 'user_text', text: 'also do X', queuedId: 'q1' },
      tool('t2'),
      says('Still going'),
    )
    const items = buildTranscript(events, 'claude')
    const found = items.find((i) => i.type === 'message' && i.text === 'Found part 1')
    expect(found).toMatchObject({ type: 'message', phase: 'update' })
  })

  it('an acknowledgement before the queued message stays an acknowledgement', () => {
    const events = log(
      { kind: 'user_text', text: 'go' },
      says('On it.'),
      { kind: 'user_text', text: 'also do X', queuedId: 'q1' },
      tool('t1'),
      says('All done.'),
      { kind: 'result', ok: true },
    )
    expect(rolesOf(events)).toEqual(['On it.=acknowledgement', 'All done.=conclusion'])
  })
})
