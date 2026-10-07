import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import { completeMention, mentionAt } from '../draft-references.ts'
import { useReferenceSearch } from '../useReferenceSearch.ts'
import { ReferenceList, referenceDisabled } from './ReferenceList.tsx'

interface MentionMenuOptions {
  projectPath?: string
  /** A worktree's ID: files are searched in that worktree. */
  workspaceId?: string
  text: string
  /** Where the caret is, or undefined while the message box isn't focused. */
  caret?: number
  attached: ReadonlySet<string>
  filesFull: boolean
  /** The draft with the @word replaced, and where the caret goes. */
  onComplete: (text: string, caret: number) => void
}

/** One key the @ list may take: the arrows, Enter/Tab to pick, Escape to hide. */
export interface MenuKey { key: string; shiftKey: boolean; isComposing: boolean; preventDefault(): void; stopPropagation(): void }

interface ReferenceMenuOptions {
  projectPath?: string
  workspaceId?: string
  /** The @word being typed (without the @), or undefined when there is none. */
  query: string | undefined
  /** Changes with each new @word, so Escape hides only that one. */
  anchor: number | undefined
  attached: ReadonlySet<string>
  filesFull: boolean
  /** Swap the @word for this reference token. */
  onPick: (token: string) => void
}

/**
 * The @ list itself, for any editor: matching files and workflows, keyboard choice, Escape to
 * hide until the next @. The message box and the workflow editors each find the @word their own way.
 */
export function useReferenceMenu({ projectPath, workspaceId, query, anchor, attached, filesFull, onPick }: ReferenceMenuOptions): {
  menu: ReactNode
  /** Handles the key if the list is open; returns true when it did. */
  onKey: (event: MenuKey) => boolean
} {
  const [dismissed, setDismissed] = useState<number>()
  const [active, setActive] = useState(0)
  const open = Boolean(projectPath && query !== undefined && anchor !== dismissed)
  const search = query ?? ''
  const { options, truncated, settled } = useReferenceSearch(projectPath ?? '', search, open, workspaceId)

  useEffect(() => { setActive(0) }, [search, anchor])
  const typing = query !== undefined
  useEffect(() => { if (!typing) setDismissed(undefined) }, [typing])

  const pick = (index: number): boolean => {
    const option = options[index]
    if (query === undefined || !option || referenceDisabled(option, attached, filesFull)) return false
    onPick(option.token)
    return true
  }

  const onKey = (event: MenuKey): boolean => {
    if (!open || event.isComposing) return false
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && options.length) {
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (i + step + options.length) % options.length)
    } else if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
      // Nothing to pick: Enter and Tab keep their usual meaning.
      if (!pick(active)) return false
    } else if (event.key === 'Escape') {
      setDismissed(anchor)
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
        empty={settled ? (search ? `No file or workflow matches “${search}”.` : 'Type to search files and workflows.') : undefined}
        onActive={setActive} onPick={(o) => { pick(options.indexOf(o)) }} />
      <p className="picker-note picker-hint">↑↓ to choose · Enter or Tab to add · Esc to hide</p>
    </div>
  ) : null
  return { menu, onKey }
}

/**
 * Typing @ in a text box lists matching files and workflows right there; Enter or Tab
 * swaps the @word for the reference, Escape hides the list until the next @.
 */
export function useMentionMenu({ projectPath, workspaceId, text, caret, attached, filesFull, onComplete }: MentionMenuOptions): {
  menu: ReactNode
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean
} {
  const mention = caret === undefined ? undefined : mentionAt(text, caret)
  const { menu, onKey } = useReferenceMenu({
    projectPath, workspaceId, query: mention?.query, anchor: mention?.start, attached, filesFull,
    onPick: (token) => {
      if (!mention) return
      const next = completeMention(text, mention, token)
      onComplete(next.text, next.caret)
    },
  })
  return { menu, onKeyDown: (event) => onKey({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing,
    preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation() }) }
}
