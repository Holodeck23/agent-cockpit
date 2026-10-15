// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentPicker, settingsFromChoice, type AgentChoice } from '../web/src/components/AgentPicker.tsx'
import { resolveClaudeSetup } from '../server/agents/claude/setup.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<{ unmount: () => void; host: HTMLElement }> = []
afterEach(() => {
  for (const { unmount, host } of roots.splice(0)) { act(unmount); host.remove() }
  vi.unstubAllGlobals()
})

it('offers independent per-conversation overrides and serializes Off without changing project defaults', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })))
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push({ unmount: () => root.unmount(), host })
  let selected: AgentChoice = { agent: 'claude', model: '', effort: '', permissionMode: 'manual', hooksSetup: 'inherit', mcpSetup: 'inherit' }
  const Wrapper = () => {
    const [choice, setChoice] = useState(selected)
    return createElement(AgentPicker, { value: choice, onChange: (next: AgentChoice) => { selected = next; setChoice(next) } })
  }
  act(() => root.render(createElement(Wrapper)))
  act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Agent settings"]')!.click())
  const select = (name: string) => [...host.querySelectorAll<HTMLLabelElement>('label.field')]
    .find((label) => label.firstChild?.textContent?.trim() === name)!.querySelector('select')!
  expect(select('Claude hooks for this conversation').value).toBe('inherit')
  expect(select('Claude MCP connectors for this conversation').value).toBe('inherit')
  const hooks = select('Claude hooks for this conversation')
  act(() => { hooks.value = 'off'; hooks.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(selected.hooksSetup).toBe('off')
  expect(selected.mcpSetup).toBe('inherit')
  const settings = threadSettingsSchema.parse(settingsFromChoice(selected))
  expect(resolveClaudeSetup(settings, { claudeHooks: true, claudeMcp: true }, {}))
    .toMatchObject({ hooks: false, connectors: true })
})
