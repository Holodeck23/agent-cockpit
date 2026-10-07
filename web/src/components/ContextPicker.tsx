import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { focusComposer } from '../focus-composer.ts'
import { usePopover } from '../usePopover.ts'
import { useReferenceSearch, type ReferenceOption } from '../useReferenceSearch.ts'
import { PlusIcon } from './icons.tsx'
import { ReferenceList, referenceDisabled } from './ReferenceList.tsx'

interface ContextPickerProps {
  projectPath: string
  workspaceId?: string
  /** Tokens already in the draft, shown as added. */
  attached: ReadonlySet<string>
  filesFull: boolean
  onPick: (token: string) => void
  onBrowseFiles?: () => void
}

/** The composer's "+": search this project's files and workflows and add them to the message. */
export function ContextPicker({ projectPath, workspaceId, attached, filesFull, onPick, onBrowseFiles }: ContextPickerProps) {
  const { open, setOpen, ref } = usePopover<HTMLDivElement>({ onEscape: () => focusComposer(ref.current) })
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const { options, truncated, error, settled } = useReferenceSearch(projectPath, query, open, workspaceId)

  useEffect(() => { if (open) input.current?.focus() }, [open])

  // Stays open so several files and workflows can be added in a row; Escape returns to the message.
  const pick = (o: ReferenceOption | undefined): void => {
    if (!o || referenceDisabled(o, attached, filesFull)) return
    onPick(o.token)
    input.current?.focus()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (options.length ? (i + step + options.length) % options.length : 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      pick(options[active])
    }
  }

  return (
    <div className="picker" ref={ref}>
      <button type="button" className="icon-button" aria-label="Add context" title="Add files or workflows (or type @)" aria-expanded={open}
        onClick={() => { setOpen(!open); setActive(0) }}>
        <PlusIcon />
      </button>
      {open ? (
        <div className="picker-panel" role="dialog" aria-label="Add context">
          <input ref={input} aria-label="Search files and workflows" placeholder="Search files and workflows…" value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0) }} onKeyDown={onKeyDown} />
          {error ? <p className="picker-note" role="alert">{error}</p> : null}
          <ReferenceList options={options} active={active} attached={attached} filesFull={filesFull} truncated={truncated}
            empty={!error && settled ? `Nothing matches “${query}”.` : undefined} onActive={setActive} onPick={pick} />
          {filesFull ? <p className="picker-note">A message can attach up to 8 files.</p> : null}
          <p className="picker-note picker-hint">Add as many as you need. Esc returns to your message.</p>
          {onBrowseFiles ? <button type="button" className="picker-browse" onClick={() => { setOpen(false); onBrowseFiles() }}>Browse the Files panel…</button> : null}
        </div>
      ) : null}
    </div>
  )
}
