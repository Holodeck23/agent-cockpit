import { useState, type FormEvent } from 'react'
import { NEW_FILE_KINDS, withExtension, type NewFileKind } from '../file-text.ts'
import { usePopover } from '../usePopover.ts'
import { PlusIcon } from './icons.tsx'

/** "New file" with a choice of kind (Markdown, JSON, plain text, or any name), then the name. */
export function NewFileMenu({ onCreate }: { onCreate: (name: string, kind: NewFileKind) => Promise<boolean> }) {
  const { open, setOpen, ref } = usePopover<HTMLDivElement>()
  const [kind, setKind] = useState<NewFileKind>()
  const [name, setName] = useState('')
  const chosen = NEW_FILE_KINDS.find((k) => k.id === kind)
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (kind && await onCreate(name, kind)) { setKind(undefined); setName('') }
  }
  return (
    <div className="new-file" ref={ref}>
      <button type="button" className="file-new" aria-expanded={open} onClick={() => setOpen(!open)}><PlusIcon /> New file</button>
      {open ? (
        <div className="menu new-file-menu" role="menu" aria-label="New file">
          {NEW_FILE_KINDS.map((k) => (
            <button key={k.id} type="button" role="menuitem" className="menu-item" onClick={() => { setKind(k.id); setOpen(false) }}>
              <span>{k.label}</span>{k.ext ? <span className="menu-note">{k.ext}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      {chosen ? (
        <form className="file-new-form" onSubmit={(e) => void submit(e)}>
          <input aria-label="New file name" placeholder={chosen.ext ? `notes${chosen.ext}` : 'name.ext'} value={name} autoFocus
            onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setKind(undefined) }} />
          <button type="submit" className="button-primary" disabled={!name.trim()}>Create</button>
          {name.trim() && chosen.ext ? <small>Creates {withExtension(name, chosen.id)}</small> : null}
        </form>
      ) : null}
    </div>
  )
}
