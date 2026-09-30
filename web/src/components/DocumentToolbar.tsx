import type { Editor } from '@milkdown/kit/core'
import { editorViewCtx } from '@milkdown/kit/core'
import {
  createCodeBlockCommand, toggleEmphasisCommand, toggleInlineCodeCommand, toggleStrongCommand, turnIntoTextCommand,
  wrapInBlockquoteCommand, wrapInBulletListCommand, wrapInHeadingCommand, wrapInOrderedListCommand,
} from '@milkdown/kit/preset/commonmark'
import { callCommand } from '@milkdown/kit/utils'

/** Turns the list item at the cursor into a to-do item, or back into a plain one. */
function toggleTask(editor: Editor): void {
  editor.action((ctx) => {
    const find = () => {
      const { $from } = ctx.get(editorViewCtx).state.selection
      for (let depth = $from.depth; depth > 0; depth -= 1) {
        const node = $from.node(depth)
        if (node.type.name === 'list_item') return { pos: $from.before(depth), node }
      }
      return undefined
    }
    if (!find()) callCommand(wrapInBulletListCommand.key)(ctx)
    const item = find()
    if (!item) return
    const view = ctx.get(editorViewCtx)
    view.dispatch(view.state.tr.setNodeMarkup(item.pos, undefined, { ...item.node.attrs, checked: item.node.attrs.checked == null ? false : null }))
  })
}

export function DocumentToolbar({ editor }: { editor: Editor }) {
  const run = (action: () => void) => (event: React.MouseEvent) => {
    event.preventDefault() // keep the editor's selection
    action()
    editor.action((ctx) => ctx.get(editorViewCtx).focus())
  }
  const command = (key: Parameters<typeof callCommand>[0], payload?: unknown) => run(() => editor.action(callCommand(key, payload)))
  return (
    <div className="doc-toolbar" role="toolbar" aria-label="Formatting">
      <select aria-label="Text style" value="" onChange={(e) => {
        const level = Number(e.target.value)
        editor.action(level ? callCommand(wrapInHeadingCommand.key, level) : callCommand(turnIntoTextCommand.key))
        editor.action((ctx) => ctx.get(editorViewCtx).focus())
      }}>
        <option value="" disabled>Style</option>
        <option value="0">Text</option>
        <option value="1">Heading 1</option>
        <option value="2">Heading 2</option>
        <option value="3">Heading 3</option>
      </select>
      <button type="button" aria-label="Bold" title="Bold (⌘B)" onMouseDown={command(toggleStrongCommand.key)}><b>B</b></button>
      <button type="button" aria-label="Italic" title="Italic (⌘I)" onMouseDown={command(toggleEmphasisCommand.key)}><i>I</i></button>
      <button type="button" aria-label="Inline code" title="Inline code" onMouseDown={command(toggleInlineCodeCommand.key)}><code>{'<>'}</code></button>
      <span className="doc-toolbar-gap" />
      <button type="button" aria-label="Bullet list" title="Bullet list" onMouseDown={command(wrapInBulletListCommand.key)}>•</button>
      <button type="button" aria-label="Numbered list" title="Numbered list" onMouseDown={command(wrapInOrderedListCommand.key)}>1.</button>
      <button type="button" aria-label="To-do" title="To-do item" onMouseDown={run(() => toggleTask(editor))}>☑</button>
      <button type="button" aria-label="Quote" title="Quote" onMouseDown={command(wrapInBlockquoteCommand.key)}>❝</button>
      <button type="button" aria-label="Code block" title="Code block" onMouseDown={command(createCodeBlockCommand.key)}>{'{ }'}</button>
    </div>
  )
}
