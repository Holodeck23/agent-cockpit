// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AntigravityTools } from '../../web/src/components/AntigravityTools.tsx'
import type { Project } from '../../web/src/api.ts'

// u26-1: the "Give Antigravity Cockpit's tools" box applies on the server at once, but it seeds its
// state from `project.antigravityMcp` at mount and nothing refreshes the project list afterwards.
// Project settings is unmounted by Done/Escape, so reopening it remounts the box from the stale
// `active` project: it shows "off" although the plugin is installed (and "on" after turning it off).
// CORRECT behaviour: reopening shows what the server holds now.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OWNED = { entryHash: 'a'.repeat(64), created: [] as const }
const stale = { name: 'demo', path: '/proj', color: 'blue', pinned: true } as unknown as Project // what the project list still holds
let serverMcp: typeof OWNED | undefined
let root: Root | undefined
let host: HTMLElement | undefined

beforeEach(() => {
  serverMcp = undefined
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    const reply = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })
    if (path === '/api/projects/agy-mcp') {
      serverMcp = (JSON.parse(init!.body!) as { connected: boolean }).connected ? OWNED : undefined
      return reply({ project: { ...stale, antigravityMcp: serverMcp } })
    }
    if (path === '/api/projects') return reply([{ ...stale, antigravityMcp: serverMcp }])
    return new Response(JSON.stringify({ error: 'unexpected' }), { status: 500 })
  }))
})
afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  vi.unstubAllGlobals()
})

const settle = async (): Promise<void> => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) }) }
const box = (): HTMLInputElement => host!.querySelector('input[type=checkbox]') as HTMLInputElement
// Project settings closing and opening again: a new mount from the same, never-refreshed project.
const open = async (): Promise<void> => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => { root!.render(createElement(AntigravityTools, { project: stale })) })
  await settle()
}
const close = (): void => { act(() => { root?.unmount() }); host?.remove() }

describe('u26-1: the Antigravity tools box survives closing and reopening Project settings', () => {
  it('shows on after it was turned on and settings were reopened without a project refresh', async () => {
    await open()
    expect(box().checked).toBe(false)
    act(() => { box().click() })
    await settle()
    expect(serverMcp).toBeDefined()
    expect(box().checked).toBe(true)
    close()
    await open()
    expect(box().checked).toBe(true)
  })

  it('shows off after it was turned off and settings were reopened', async () => {
    serverMcp = OWNED
    const project = { ...stale, antigravityMcp: OWNED } as unknown as Project
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => { root!.render(createElement(AntigravityTools, { project })) })
    await settle()
    expect(box().checked).toBe(true)
    act(() => { box().click() })
    await settle()
    expect(serverMcp).toBeUndefined()
    close()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => { root!.render(createElement(AntigravityTools, { project })) }) // the list still says "on"
    await settle()
    expect(box().checked).toBe(false)
  })
})
