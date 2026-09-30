import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'

// Clicking the box in front of a task item ticks or unticks it. The box is drawn by CSS
// (styles/document.css) in the item's left padding, so a click there lands on the <li> itself.
export const taskToggle = $prose(() => new Plugin({
  key: new PluginKey('cockpit-task-toggle'),
  props: {
    handleDOMEvents: {
      mousedown(view, event) {
        const item = event.target instanceof HTMLElement ? event.target : undefined
        if (!item || item.tagName !== 'LI' || item.dataset.itemType !== 'task' || !view.editable) return false
        if (event.clientX - item.getBoundingClientRect().left > 26) return false
        const pos = view.posAtDOM(item, 0) - 1
        const node = view.state.doc.nodeAt(pos)
        if (node?.type.name !== 'list_item' || node.attrs.checked == null) return false
        event.preventDefault()
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !node.attrs.checked }))
        return true
      },
    },
  },
}))
