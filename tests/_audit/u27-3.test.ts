// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentPicker, type AgentChoice } from '../../web/src/components/AgentPicker.tsx'

// u27-3: the Effort chip beside the picker builds its menu from the generic effort list. Antigravity
// models come in the efforts agy lists for them, and some only in Low and High; the panel's Effort box
// knows that, the chip did not. Picking Medium there is stored, and the next message is refused at
// launch ("Gemini ... offers Low or High effort, not Medium").
// CORRECT behaviour: once agy has listed the model, the chip offers only the efforts that model comes in.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const caps = {
  agent: 'antigravity', context: 'default', executable: { state: 'missing', reason: 'not needed here' },
  models: { state: 'supported', value: [{ id: 'gemini-x-low', label: 'Gemini X (Low)' }, { id: 'gemini-x-high', label: 'Gemini X (High)' }] },
  settings: {}, auth: { state: 'not_checked' },
}

let root: Root | undefined
let host: HTMLElement | undefined

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    const url = String(path)
    if (url === '/api/agents/antigravity/capabilities') return new Response(JSON.stringify({ data: caps }), { status: 200 })
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

describe('u27-3: the Effort chip offers the efforts the Antigravity model comes in', () => {
  it('a Low and High model gets no Medium, and a pick is one of its own', async () => {
    const picked: AgentChoice[] = []
    const value: AgentChoice = { agent: 'antigravity', model: 'gemini-x', effort: 'high', permissionMode: 'manual' }
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => { root!.render(createElement(AgentPicker, { value, onChange: (choice: AgentChoice) => { picked.push(choice) } })) })
    await settle() // agy's listing arrives

    act(() => { host!.querySelector<HTMLButtonElement>('button.effort-button')!.click() })
    const items = [...host.querySelectorAll<HTMLButtonElement>('.effort-menu [role="menuitemradio"]')]
    const labels = items.map((item) => item.textContent)
    expect(labels).toContain('Low')
    expect(labels).toContain('High')
    expect(labels).not.toContain('Medium')
    expect(labels).not.toContain('Xhigh')
    expect(labels).not.toContain('Max')

    act(() => { items.find((item) => item.textContent === 'Low')!.click() })
    expect(picked.at(-1)).toMatchObject({ agent: 'antigravity', model: 'gemini-x', effort: 'low' })
  })

  it('without a listing the generic efforts stay', async () => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    // A model agy does not list (or no listing yet): nothing to narrow by.
    act(() => { root!.render(createElement(AgentPicker, { value: { agent: 'antigravity', model: '', effort: '', permissionMode: 'manual' }, onChange: () => undefined })) })
    await settle()
    act(() => { host!.querySelector<HTMLButtonElement>('button.effort-button')!.click() })
    const labels = [...host.querySelectorAll('.effort-menu [role="menuitemradio"]')].map((item) => item.textContent)
    expect(labels).toEqual(['Default', 'Low', 'Medium', 'High', 'Xhigh', 'Max'])
  })
})
