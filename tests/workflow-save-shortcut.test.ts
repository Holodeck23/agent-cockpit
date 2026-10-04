// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowEditor } from '../web/src/components/Workflows.tsx'
import type { WorkflowInput } from '../web/src/api.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)) })
async function until(test: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!test()) {
    if (Date.now() > end) throw new Error('timed out')
    await wait(20)
  }
}

describe('⌘S in a workflow document (R2)', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    // The agent picker asks the server for agents and presets; there is none here.
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
    host = document.body.appendChild(document.createElement('div'))
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  })

  it('saves once, with the text on screen, even before the editor reported the edit', async () => {
    const saves: WorkflowInput[] = []
    const onSave = vi.fn(async (input: WorkflowInput) => { saves.push(input) })
    await act(async () => {
      root.render(createElement(WorkflowEditor, { projectPath: '/p', busy: false, onSave, onPause: async () => {}, onArchive: async () => {}, onOpenThread: () => {} }))
    })
    const name = host.querySelector<HTMLInputElement>('input[pattern]')!
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setValue.call(name, 'daily-review')
      name.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await until(() => host.querySelector('.ProseMirror') !== null)
    const editor = host.querySelector('.ProseMirror')!
    // Type into the document; ProseMirror reads the change from the DOM at once, while the
    // Markdown listener only reports it later.
    const type = (text: string) => act(async () => {
      const paragraph = editor.querySelector('p') ?? editor.appendChild(document.createElement('p'))
      paragraph.textContent = text
      await Promise.resolve()
    })
    await type('First draft')
    await wait(600) // the listener reports this one
    await type('Check the logs every morning')
    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true }))
    })
    await wait(400)
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(saves[0]?.prompt.trim()).toBe('Check the logs every morning')
    expect(saves[0]?.name).toBe('daily-review')
  })
})
