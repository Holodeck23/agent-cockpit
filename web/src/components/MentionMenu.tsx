import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import { completeMention, mentionAt } from '../draft-references.ts'
import { useReferenceSearch } from '../useReferenceSearch.ts'
import { ReferenceList, referenceDisabled } from './ReferenceList.tsx'

interface MentionMenuOptions {
  projectPath?: string
  text: string
  /** Where the caret is, or undefined while the message box isn't focused. */
  caret?: number
  attached: ReadonlySet<string>
  filesFull: boolean
  /** The draft with the @word replaced, and where the caret goes. */
  onComplete: (text: string, caret: number) => void
}

/**
 * Typing @ in the message box lists matching files and workflows right there; Enter or Tab
 * swaps the @word for the reference, Escape hides the list until the next @.
 */
export function useMentionMenu({ projectPath, text, caret, attached, filesFull, onComplete }: MentionMenuOptions): {
  menu: ReactNode
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean
} {
  const mention = caret === undefined ? undefined : mentionAt(text, caret)
  const [dismissed, setDismissed] = useState<number>()
  const [active, setActive] = useState(0)
  const open = Boolean(projectPath && mention && mention.start !== dismissed)
  const query = mention?.query ?? ''
  const { options, truncated, settled } = useReferenceSearch(projectPath ?? '', query, open)

  useEffect(() => { setActive(0) }, [query, mention?.start])
  const typing = mention !== undefined
  useEffect(() => { if (!typing) setDismissed(undefined) }, [typing])

  const pick = (index: number): boolean => {
    const option = options[index]
    if (!mention || !option || referenceDisabled(option, attached, filesFull)) return false
    const next = completeMention(text, mention, option.token)
    onComplete(next.text, next.caret)
    return true
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || event.nativeEvent.isComposing) return false
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && options.length) {
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (i + step + options.length) % options.length)
    } else if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
      // Nothing to pick: Enter still sends, Tab still moves focus.
      if (!pick(active)) return false
    } else if (event.key === 'Escape') {
      setDismissed(mention?.start)
    } else {
      return false
    }
    event.preventDefault()
    event.stopPropagation()
    return true
  }

  const menu = open ? (
    <div className="picker-panel mention-panel" role="dialog" aria-label="Files and workflows for @">
      <ReferenceList options={options} active={active} attached={attached} filesFull={filesFull} truncated={truncated}
        empty={settled ? (query ? `No file or workflow matches “${query}”.` : 'Type to search files and workflows.') : undefined}
        onActive={setActive} onPick={(o) => { pick(options.indexOf(o)) }} />
      <p className="picker-note picker-hint">↑↓ to choose · Enter or Tab to add · Esc to hide</p>
    </div>
  ) : null
  return { menu, onKeyDown }
}
