// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { defaultValueCtx, Editor, editorViewCtx, rootCtx } from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { taskToggle } from '../../web/src/markdown/task-toggle.ts'

// u30-5: the task checkbox handler ran on every mousedown in the left 26px of a task item, whatever
// the button or modifiers, so a right-click (or a ctrl-click on a Mac, which opens the context menu)
// in the checkbox gutter ticked or unticked the task.
// CORRECT behaviour: only a plain primary-button press toggles; anything else is left to the editor.

let host: HTMLElement | undefined
afterEach(() => { host?.remove(); host = undefined })
// When the plugin lets a press through, ProseMirror's own handler asks for the element under the pointer; jsdom has no layout.
;(document as { elementFromPoint?: unknown }).elementFromPoint = () => null

async function press(init: MouseEventInit): Promise<{ checked: boolean; prevented: boolean }> {
  host = document.createElement('div')
  document.body.append(host)
  const editor = await Editor.make().config((ctx) => { ctx.set(rootCtx, host!); ctx.set(defaultValueCtx, '- [ ] Open task\n') }).use(commonmark).use(gfm).use(taskToggle).create()
  const li = host.querySelector('li[data-item-type="task"]')
  if (!li) throw new Error(`no task item in ${host.innerHTML}`)
  const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: 5, clientY: 5, ...init })
  li.dispatchEvent(event)
  const checked = editor.action((ctx) => {
    let value = false
    ctx.get(editorViewCtx).state.doc.descendants((node) => { if (node.type.name === 'list_item') value = node.attrs.checked === true; return true })
    return value
  })
  return { checked, prevented: event.defaultPrevented }
}

describe('pressing in the checkbox gutter of a task', () => {
  it('a plain left press ticks it', async () => {
    expect(await press({ button: 0 })).toEqual({ checked: true, prevented: true })
  })
  it('a right press leaves it alone', async () => {
    expect((await press({ button: 2 })).checked).toBe(false)
  })
  it('a middle press leaves it alone', async () => {
    expect((await press({ button: 1 })).checked).toBe(false)
  })
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) {
    it(`a left press with ${modifier} leaves it alone`, async () => {
      expect((await press({ button: 0, [modifier]: true })).checked).toBe(false)
    })
  }
})
