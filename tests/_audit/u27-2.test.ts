// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentPicker, type AgentChoice } from '../../web/src/components/AgentPicker.tsx'

// u27-2: the picker panel sits inside the composer's <form> (and the workflow editor's). The preset
// name box stops Enter, but the two model boxes ("Claude model id" and Model) do not, so Enter in
// them is implicit submission: the composer sends the half-written follow-up with the OLD settings,
// the workflow editor runs Save workflow.
// CORRECT behaviour: Enter in a model box never submits the enclosing form.
// (jsdom does not run implicit submission for a script-dispatched key, so the browser's default
// action is stood in for here: when nothing cancelled the Enter keydown, the form submits.)

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLElement | undefined

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    const url = String(path)
    if (url === '/api/presets' || url === '/api/agents') return new Response(JSON.stringify({ data: [] }), { status: 200 })
    return new Response(JSON.stringify({ error: 'unavailable' }), { status: 500 })
  }))
})
afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  vi.unstubAllGlobals()
})

const settle = async (): Promise<void> => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) }) }

async function openPicker(value: AgentChoice): Promise<{ submitted: () => number; enter: (input: HTMLInputElement) => boolean }> {
  let submits = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root!.render(createElement('form', { onSubmit: (e: Event) => { e.preventDefault(); submits += 1 } },
      createElement(AgentPicker, { value, onChange: () => undefined }),
      createElement('button', { type: 'submit', 'aria-label': 'Send' })))
  })
  act(() => { host!.querySelector<HTMLButtonElement>('button[aria-label="Agent settings"]')!.click() })
  await settle()
  const enter = (input: HTMLInputElement): boolean => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    act(() => { input.dispatchEvent(event) })
    if (!event.defaultPrevented) act(() => { host!.querySelector('form')!.requestSubmit() }) // what the browser does for an uncancelled Enter
    return event.defaultPrevented
  }
  return { submitted: () => submits, enter }
}

describe('u27-2: Enter in the picker\'s model boxes does not submit the enclosing form', () => {
  it('Model box (Codex, OpenCode, Antigravity)', async () => {
    const picker = await openPicker({ agent: 'codex', model: 'gpt-5.5', effort: '', permissionMode: 'manual' })
    const input = host!.querySelector<HTMLInputElement>('input[placeholder="Default model"]')!
    expect(input).not.toBeNull()
    expect(picker.enter(input)).toBe(true)
    expect(picker.submitted()).toBe(0)
  })

  it('Claude model id box', async () => {
    const picker = await openPicker({ agent: 'claude', model: 'claude-opus-9-9', effort: '', permissionMode: 'manual' })
    const input = host!.querySelector<HTMLInputElement>('input[aria-label="Claude model id"]')!
    expect(input).not.toBeNull()
    expect(picker.enter(input)).toBe(true)
    expect(picker.submitted()).toBe(0)
  })

  it('other keys still reach the box', async () => {
    await openPicker({ agent: 'codex', model: '', effort: '', permissionMode: 'manual' })
    const input = host!.querySelector<HTMLInputElement>('input[placeholder="Default model"]')!
    const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    act(() => { input.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(false)
  })
})
