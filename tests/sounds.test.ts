import { describe, expect, it } from 'vitest'
import { attentionChanges, DEFAULT_SOUNDS, parseSounds, soundFor, type Seen } from '../web/src/sounds.ts'

type Status = 'idle' | 'working' | 'needs_input' | 'done' | 'error'
const row = (id: string, status: Status, at = 't1') => ({ meta: { id }, status, lastActivityAt: at })
const seen = (...rows: Array<[string, Status, string?]>): Seen => new Map(rows.map(([id, status, at]) => [id, { status, lastActivityAt: at ?? 't0' }]))
const on = { reply: true, decision: true }

describe('sounds', () => {
  it('are off unless stored as on', () => {
    expect(DEFAULT_SOUNDS).toEqual({ reply: false, decision: false })
    expect(parseSounds(null)).toEqual(DEFAULT_SOUNDS)
    expect(parseSounds('garbage')).toEqual(DEFAULT_SOUNDS)
    expect(parseSounds('{"reply":true,"decision":"yes"}')).toEqual({ reply: true, decision: false })
  })

  it('plays a reply when a turn ends after working or waiting', () => {
    expect(soundFor(seen(['a', 'working']), [row('a', 'done')], on)).toBe('reply')
    expect(soundFor(seen(['a', 'working']), [row('a', 'idle')], on)).toBe('reply')
    expect(soundFor(seen(['a', 'needs_input']), [row('a', 'done')], on)).toBe('reply')
    expect(soundFor(seen(['a', 'working']), [row('a', 'error')], on)).toBeUndefined()
    expect(soundFor(seen(['a', 'done']), [row('a', 'done')], on)).toBeUndefined()
  })

  it('plays a decision for each fresh wait, ahead of any reply', () => {
    expect(soundFor(seen(['a', 'working']), [row('a', 'needs_input')], on)).toBe('decision')
    expect(soundFor(seen(), [row('a', 'needs_input')], on)).toBe('decision') // new since the last update
    expect(soundFor(seen(['a', 'needs_input', 't0']), [row('a', 'needs_input', 't1')], on)).toBe('decision') // next approval, no gap
    expect(soundFor(seen(['a', 'needs_input', 't1']), [row('a', 'needs_input', 't1')], on)).toBeUndefined() // same one, still waiting
    expect(soundFor(seen(['a', 'working'], ['b', 'working']), [row('a', 'done'), row('b', 'needs_input')], on)).toBe('decision')
  })

  it('stays quiet on the first look and for sounds switched off', () => {
    expect(soundFor(undefined, [row('a', 'needs_input'), row('b', 'done')], on)).toBeUndefined()
    expect(soundFor(seen(), [row('a', 'done')], on)).toBeUndefined()
    expect(soundFor(seen(['a', 'working']), [row('a', 'done')], { reply: false, decision: true })).toBeUndefined()
    expect(soundFor(seen(['a', 'working']), [row('a', 'needs_input')], { reply: true, decision: false })).toBeUndefined()
    expect(soundFor(seen(['a', 'working'], ['b', 'working']), [row('a', 'needs_input'), row('b', 'done')], { reply: true, decision: false })).toBe('reply')
  })

  it('stays quiet for the conversation you are looking at, but not for others', () => {
    expect(soundFor(seen(['a', 'working']), [row('a', 'done')], on, 'a')).toBeUndefined()
    expect(soundFor(seen(['a', 'working'], ['b', 'working']), [row('a', 'done'), row('b', 'done')], on, 'a')).toBe('reply')
    expect(soundFor(seen(['a', 'working']), [row('a', 'needs_input')], on, 'a')).toBeUndefined()
  })
})

describe('attentionChanges', () => {
  it('names each conversation that finished or now needs a decision, skipping the focused one', () => {
    const before = seen(['a', 'working'], ['b', 'working'], ['c', 'working'], ['d', 'done'])
    const now = [row('a', 'done'), row('b', 'needs_input'), row('c', 'working'), row('d', 'done')]
    expect(attentionChanges(before, now)).toEqual([{ id: 'a', kind: 'reply' }, { id: 'b', kind: 'decision' }])
    expect(attentionChanges(before, now, 'b')).toEqual([{ id: 'a', kind: 'reply' }])
    expect(attentionChanges(undefined, now)).toEqual([])
  })

  it('a question at the end of a turn is a decision, not a reply', () => {
    expect(attentionChanges(seen(['a', 'working']), [{ ...row('a', 'done'), awaiting: 'question' as const }])).toEqual([{ id: 'a', kind: 'decision' }])
  })
})
