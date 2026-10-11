// @vitest-environment jsdom
import { createElement, act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useAttention, type AttentionChange } from '../../web/src/sounds.ts'
import type { ThreadSummary } from '../../web/src/api.ts'

// u18-1: useCockpit starts with threads = [] and App passes that straight to useAttention. The first
// effect run therefore "sees" an empty list and arms the watcher (seen = empty Map). When the real
// list arrives, attentionChanges(emptyMap, realThreads) reports every waiting conversation as new,
// so each one chimes and posts a native notification at launch.
// CORRECT behaviour: conversations that were already waiting when the app opened (the first real
// list) call for nothing; only a change after that does.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function thread(id: string, status: ThreadSummary['status'], extra: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    meta: { id, title: id },
    status,
    preview: '',
    messageCount: 2,
    lastActivityAt: '2026-10-10T10:00:00.000Z',
    ...extra,
  } as unknown as ThreadSummary
}

let root: Root | undefined
let host: HTMLElement | undefined

function mount(): { set: (threads: ThreadSummary[]) => void; calls: AttentionChange[][] } {
  const calls: AttentionChange[][] = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const Probe = ({ threads }: { threads: ThreadSummary[] }): ReactElement | null => {
    useAttention(threads, () => undefined, (changes) => { calls.push(changes) })
    return null
  }
  const set = (threads: ThreadSummary[]): void => { act(() => { root!.render(createElement(Probe, { threads })) }) }
  return { set, calls }
}

afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  root = undefined
  host = undefined
})

describe('useAttention at launch', () => {
  it('stays quiet for conversations that were already waiting when the first list arrives', () => {
    const { set, calls } = mount()
    set([]) // useCockpit's initial state, before api.listThreads() resolves
    // The list that arrives: one open approval, one finished turn that ended on a question.
    set([
      thread('approval', 'needs_input'),
      thread('asked', 'done', { awaiting: 'question' }),
      thread('finished', 'done'),
    ])
    expect(calls.flat()).toEqual([])
  })

  it('still reports a conversation that starts waiting after the first list', () => {
    const { set, calls } = mount()
    set([])
    set([thread('a', 'working')])
    expect(calls.flat()).toEqual([])
    set([thread('a', 'needs_input', { lastActivityAt: '2026-10-10T10:05:00.000Z' })])
    expect(calls.flat()).toEqual([{ id: 'a', kind: 'decision' }])
  })
})
