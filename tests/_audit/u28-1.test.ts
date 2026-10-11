// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QuestionCard } from '../../web/src/components/QuestionCard.tsx'
import type { TranscriptItem } from '../../web/src/transcript.ts'

// u28-1: the card greyed itself out the moment Send answers was pressed and never came back. A failed
// request (the server answers 400 for an answer over 4000 characters, or the phone link drops) left the
// agent waiting while the card could not be edited or sent again.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const item = {
  type: 'question', key: 'q1', requestId: 'r1', agent: 'claude', dismissed: false,
  questions: [{ id: 'q', question: 'Which bed?', header: 'Bed', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }],
} as unknown as Extract<TranscriptItem, { type: 'question' }>

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
