// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentPicker, type AgentChoice } from '../../web/src/components/AgentPicker.tsx'

// u27-5: changing a Codex conversation from gpt-5.6-sol (effort Ultra) to gpt-5.5 (tops out at Xhigh)
// kept "ultra". The panel's Effort box lists only gpt-5.5's levels, so it read "Default"; the chip
// beside the picker still read "Ultra"; the run actually used Xhigh (codexEffort clamps).
// CORRECT behaviour: the model change takes the effort the run would use, so the box, the chip and the
// run agree. Typing a model name letter by letter must not throw an Ultra away on the way to a model
// that has it.

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
const sol: AgentChoice = { agent: 'codex', model: 'gpt-5.6-sol', effort: 'ultra', permissionMode: 'manual' }
const typeModel = (text: string): void => {
  const input = host!.querySelector<HTMLInputElement>('input[placeholder="Default model"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const effortBox = (): HTMLSelectElement => [...host!.querySelectorAll('label.field')].find((l) => l.firstChild?.textContent?.trim() === 'Effort')!.querySelector('select')!

async function mount(element: ReturnType<typeof createElement>): Promise<void> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => { root!.render(element) })
  act(() => { host!.querySelector<HTMLButtonElement>('button[aria-label="Agent settings"]')!.click() })
  await settle()
}

describe('u27-5: a Codex model change takes the effort the run would use', () => {
  it('existing conversation: the Effort box shows Xhigh, and Apply sends it', async () => {
    const applied: AgentChoice[] = []
    await mount(createElement(AgentPicker, { value: sol, onApply: (choice: AgentChoice) => { applied.push(choice) } }))
    expect(effortBox().value).toBe('ultra')

    typeModel('gpt-5.5')
    expect(effortBox().value).toBe('xhigh')
    act(() => { [...host!.querySelectorAll('button')].find((b) => b.textContent === 'Apply')!.click() })
    expect(applied).toHaveLength(1)
    expect(applied[0]).toMatchObject({ model: 'gpt-5.5', effort: 'xhigh' })
  })

  it('new conversation: the chip and the box agree', async () => {
    const Wrapper = () => {
      const [choice, setChoice] = useState<AgentChoice>(sol)
      return createElement(AgentPicker, { value: choice, onChange: setChoice })
    }
    await mount(createElement(Wrapper))
    typeModel('gpt-5.5')
    expect(host!.querySelector('button.effort-button')!.getAttribute('aria-label')).toBe('Effort: Xhigh')
    expect(effortBox().value).toBe('xhigh')
  })

  it('typing toward a model that has Ultra keeps it', async () => {
    await mount(createElement(AgentPicker, { value: sol, onApply: () => undefined }))
    // Not models yet: gpt-5.6- is on the way to gpt-5.6-terra, which has Ultra.
    typeModel('gpt-5.6-')
    typeModel('gpt-5.6-terra')
    expect(effortBox().value).toBe('ultra')
  })

  it('a model with a lower top takes the nearest level at or below the saved one', async () => {
    await mount(createElement(AgentPicker, { value: sol, onApply: () => undefined }))
    typeModel('gpt-5.6-luna')
    expect(effortBox().value).toBe('max')
  })
})
