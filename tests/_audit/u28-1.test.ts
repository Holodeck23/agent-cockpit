// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThreadDetail } from '../../web/src/api.ts'
import { QuestionCard } from '../../web/src/components/QuestionCard.tsx'
import { ThreadView } from '../../web/src/components/ThreadView.tsx'
import type { TranscriptItem } from '../../web/src/transcript.ts'

// u28-1: the card greyed itself out the moment Send answers was pressed and never came back. A failed
// request (the server answers 400 for an answer over 4000 characters, or the phone link drops) left the
// agent waiting while the card could not be edited or sent again.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const item = {
  type: 'question', key: 'q1', requestId: 'r1', agent: 'claude', dismissed: false,
  questions: [{ id: 'q', question: 'Which bed?', header: 'Bed', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }],
} as unknown as Extract<TranscriptItem, { type: 'question' }>

const h = vi.hoisted(() => ({ answer: undefined as undefined | (() => Promise<unknown>) }))

// Everything but the one call under test answers with nothing, so ThreadView's children mount quietly.
vi.mock('../../web/src/api.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../web/src/api.ts')>()
  const api = new Proxy(original.api, { get: (_target, name) => (name === 'answerQuestion' ? () => h.answer!() : () => Promise.resolve(undefined)) })
  return { ...original, api }
})

let root: Root | undefined
let host: HTMLDivElement | undefined
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = undefined; host = undefined })

async function mount(onAnswer: (answers: Record<string, string> | undefined) => void | Promise<unknown>): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(createElement(QuestionCard, { item, open: true, onAnswer })) })
  return host
}

describe('the question card after a failed answer', () => {
  it('can be used again when the request is refused', async () => {
    const onAnswer = vi.fn(() => Promise.reject(new Error('400')))
    const el = await mount(onAnswer)
    await act(async () => { el.querySelector<HTMLInputElement>('input[type=radio]')!.click() })
    const send = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Send answers')!
    expect(send.disabled).toBe(false)
    await act(async () => { send.click() })
    expect(onAnswer).toHaveBeenCalledTimes(1)
    expect(el.querySelector('fieldset')!.disabled).toBe(false)
    expect(send.disabled).toBe(false)
    expect([...el.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss')!.disabled).toBe(false)
  })

  it('stays locked while the request is in flight, so a second click cannot send twice', async () => {
    const onAnswer = vi.fn(() => new Promise<void>(() => {}))
    const el = await mount(onAnswer)
    await act(async () => { el.querySelector<HTMLInputElement>('input[type=radio]')!.click() })
    const send = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Send answers')!
    await act(async () => { send.click() })
    expect(el.querySelector('fieldset')!.disabled).toBe(true)
    expect(send.disabled).toBe(true)
  })

  it('stops your own answer at the length the server accepts', async () => {
    const el = await mount(() => undefined)
    expect(el.querySelector<HTMLInputElement>('input.question-other')!.maxLength).toBe(4000)
  })
})

// The live wiring: ThreadView handed the card a callback that never rejected, so a refused request
// (or a dropped phone link) still left the card locked.
describe('ThreadView gives the question card the request it made', () => {
  // jsdom has no layout observers; the conversation view only needs them to exist.
  beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }) })
  afterEach(() => { vi.unstubAllGlobals() })

  const detail = {
    meta: { id: 't1', title: 'Garden', projectPath: '/Users/example/garden', settings: { agent: 'claude', permissionMode: 'manual', useHooks: false }, sessionId: 's', sessionStarted: true, completed: false },
    status: 'needs_input', transcriptPath: '/Users/example/garden/messages.md', streaming: '',
    events: [
      { ts: '2026-10-10T10:00:00.000Z', event: { kind: 'user_text', text: 'plan the beds' } },
      { ts: '2026-10-10T10:00:01.000Z', event: { kind: 'question', requestId: 'r1', questions: item.questions } },
    ],
  } as unknown as ThreadDetail

  async function mountThread(onError: (message: string) => void): Promise<HTMLDivElement> {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => { root!.render(createElement(ThreadView, { detail, streaming: '', processes: [], onError })) })
    return host
  }

  it('re-enables the card and reports the refusal when the answer is rejected', async () => {
    h.answer = () => Promise.reject(new Error('Answer is too long'))
    const onError = vi.fn()
    const el = await mountThread(onError)
    await act(async () => { el.querySelector<HTMLInputElement>('input[type=radio]')!.click() })
    const send = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Send answers')!
    await act(async () => { send.click() })
    expect(onError).toHaveBeenCalledWith('Answer is too long')
    expect(el.querySelector('fieldset')!.disabled).toBe(false)
    expect(send.disabled).toBe(false)
  })

  it('keeps the card locked while the answer is in flight', async () => {
    h.answer = () => new Promise(() => {})
    const el = await mountThread(vi.fn())
    await act(async () => { el.querySelector<HTMLInputElement>('input[type=radio]')!.click() })
    const send = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Send answers')!
    await act(async () => { send.click() })
    expect(el.querySelector('fieldset')!.disabled).toBe(true)
  })
})
