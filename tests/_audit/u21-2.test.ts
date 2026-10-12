import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '../../server/agents/types.ts'
import type { StoredEvent } from '../../server/threads/types.ts'
import { buildTranscript } from '../../web/src/transcript.ts'

// u21-2: a message queued while a turn runs is recorded in the log before that turn's own error/result.
// It is not the start of the running turn, so it must not take over Retry, the "failure already shown"
// flag, or the "refused step" note of the turn that is still going.
const at = (second: number, event: NormalizedEvent): StoredEvent => ({
  ts: new Date(Date.UTC(2026, 8, 28, 10, 0, second)).toISOString(),
  event,
})
const image = (second: number, letter: string): StoredEvent =>
  at(second, { kind: 'image', file: `${letter.repeat(64)}.png`, mediaType: 'image/png', from: 'you', name: `${letter}.png` })
const failures = (items: ReturnType<typeof buildTranscript>) => items.filter((i) => i.type === 'failure')

describe('u21-2: a message queued mid-turn does not take over the running turn', () => {
  it('Retry on the failed turn resends that turn, not the message queued behind it', () => {
    const items = buildTranscript([
      at(0, { kind: 'user_text', text: 'A: fix the build' }),
      image(1, 'a'),
      at(2, { kind: 'user_text', text: 'B: and the docs', queuedId: 'q1' }),
      image(3, 'b'),
      at(4, { kind: 'result', ok: false, text: 'boom' }),
    ], 'claude')
    expect(failures(items)).toHaveLength(1)
    expect(failures(items)[0]).toMatchObject({ retryText: 'A: fix the build', retryImages: [{ file: `${'a'.repeat(64)}.png`, name: 'a.png' }] })
  })

  it('does not add a second failure card when the message is queued between the error and its failed result', () => {
    const items = buildTranscript([
      at(0, { kind: 'user_text', text: 'A' }),
      at(1, { kind: 'error', message: 'boom' }),
      at(2, { kind: 'user_text', text: 'B', queuedId: 'q1' }),
      at(3, { kind: 'result', ok: false, text: 'boom' }),
    ], 'claude')
    expect(failures(items)).toHaveLength(1)
    expect(failures(items)[0]).toMatchObject({ retryText: 'A' })
  })

  it('keeps the refused-step note of the running turn', () => {
    const items = buildTranscript([
      at(0, { kind: 'user_text', text: 'A' }),
      at(1, { kind: 'tool_use', id: 't', name: 'run_command', input: { CommandLine: 'npm run typecheck' } }),
      at(2, { kind: 'tool_result', toolUseId: 't', content: 'user denied permission to run command:\nnpm run typecheck', isError: true }),
      at(3, { kind: 'user_text', text: 'B', queuedId: 'q1' }),
      at(4, { kind: 'result', ok: true, text: '' }),
    ], 'antigravity', 'plan')
    const notes = items.filter((i) => i.type === 'note')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ tone: 'error' })
    expect(notes[0]?.type === 'note' ? notes[0].text : '').not.toContain('Turn finished')
  })

  it('still retries the queued message itself when its own turn fails after it was taken', () => {
    const items = buildTranscript([
      at(0, { kind: 'user_text', text: 'A' }),
      at(1, { kind: 'user_text', text: 'B', queuedId: 'q1' }),
      image(2, 'b'),
      at(3, { kind: 'result', ok: true }),
      at(4, { kind: 'user_taken', text: 'B', id: 'q1' }),
      at(5, { kind: 'error', message: 'boom' }),
      at(6, { kind: 'result', ok: false, text: 'boom' }),
    ], 'claude')
    expect(failures(items)).toHaveLength(1)
    expect(failures(items)[0]).toMatchObject({ retryText: 'B', retryImages: [{ file: `${'b'.repeat(64)}.png`, name: 'b.png' }] })
  })

  it('a failure of the first turn keeps its own Retry even though the queued one runs next', () => {
    const items = buildTranscript([
      at(0, { kind: 'user_text', text: 'A' }),
      at(1, { kind: 'user_text', text: 'B', queuedId: 'q1' }),
      at(2, { kind: 'result', ok: false, text: 'boom' }),
      at(3, { kind: 'user_taken', text: 'B', id: 'q1' }),
      at(4, { kind: 'result', ok: false, text: 'boom again' }),
    ], 'claude')
    expect(failures(items).map((f) => f.type === 'failure' && f.retryText)).toEqual(['A', 'B'])
  })

  it('a message taken while the turn still runs does not change what that turn retries', () => {
    const items = buildTranscript([
      at(0, { kind: 'user_text', text: 'A' }),
      at(1, { kind: 'user_text', text: 'B', queuedId: 'q1' }),
      at(2, { kind: 'user_taken', text: 'B', id: 'q1' }),
      at(3, { kind: 'result', ok: false, text: 'boom' }),
    ], 'claude')
    expect(failures(items)).toHaveLength(1)
    expect(failures(items)[0]).toMatchObject({ retryText: 'A' })
  })
})
