import { useState, type FormEvent, type ReactNode } from 'react'
import { api } from '../api.ts'
import { fileName, spaceOf } from '../file-text.ts'
import { native } from '../native.ts'
import { usePopover } from '../usePopover.ts'
import { FileIcon, MoreIcon, PinIcon } from './icons.tsx'

export interface ExtraAction { readonly label: string; run(): Promise<unknown> }

interface FileRowProps {
  projectPath: string
  /** The tab path: plain for project files, "documents:<name>" for your documents. */
  path: string
  selected: boolean
  pinned?: boolean
  /** Open with unsaved changes: renaming waits until they are saved or discarded. */
  dirty: boolean
  /** Pin and archive, for documents. */
  extra?: readonly ExtraAction[]
  detail?: ReactNode
  onOpen: () => void
  onRenamed: (to: string) => void
  onTrashed: () => void
  onError: (message: string) => void
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** One file in a list, with Rename, Open in default app, Reveal in Finder and Move to Trash behind ⋯. */
export function FileRow({ projectPath, path, selected, pinned, dirty, extra = [], detail, onOpen, onRenamed, onTrashed, onError }: FileRowProps) {
  const { open, setOpen, ref } = usePopover<HTMLDivElement>()
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(fileName(path))
  const [trashing, setTrashing] = useState(false)
  const label = fileName(path)
  const { space, path: plain } = spaceOf(path)
  const act = (run: () => Promise<unknown>): void => { setOpen(false); run().catch((e: unknown) => onError(message(e))) }
  const desktop = (action: 'open' | 'reveal' | 'trash') => async (): Promise<void> => {
    const failure = await native?.fileAction({ projectPath, space, path: plain, action })
    if (failure) throw new Error(failure)
  }
  const rename = (event: FormEvent): void => {
    event.preventDefault()
    if (name.trim() === label) { setRenaming(false); return }
    api.renameFile(projectPath, path, name).then((to) => { setRenaming(false); onRenamed(to) }, (e: unknown) => onError(message(e)))
  }

  if (renaming) {
    return (
      <form className="file-row file-rename" onSubmit={rename}>
        <FileIcon />
        <input aria-label={`New name for ${label}`} value={name} autoFocus onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') { setRenaming(false); setName(label) } }} />
        <button type="submit" className="button-soft">Rename</button>
      </form>
    )
  }
  return (
    <div className={`file-row-wrap${selected ? ' selected' : ''}`} ref={ref}>
      <button type="button" className={`file-row ${selected ? 'selected' : ''}`} onClick={onOpen}>
        <FileIcon />
        <span>{label}</span>
        {pinned ? <PinIcon className="file-pin" title="Pinned" /> : null}
        {detail}
      </button>
      <button type="button" className="file-more" aria-label={`More for ${label}`} aria-expanded={open} onClick={() => setOpen(!open)}><MoreIcon /></button>
      {open ? (
        <div className="menu file-menu" role="menu" aria-label={`${label} actions`}>
          <button type="button" role="menuitem" className="menu-item" onClick={() => {
            setOpen(false)
            if (dirty) onError(`Save or discard the changes to ${label} before renaming it`)
            else { setName(label); setRenaming(true) }
          }}>Rename…</button>
          {extra.map((a) => <button key={a.label} type="button" role="menuitem" className="menu-item" onClick={() => act(a.run)}>{a.label}</button>)}
          {native ? <>
            <button type="button" role="menuitem" className="menu-item" onClick={() => act(desktop('open'))}>Open in default app</button>
            <button type="button" role="menuitem" className="menu-item" onClick={() => act(desktop('reveal'))}>Reveal in Finder</button>
            <button type="button" role="menuitem" className="menu-item danger" onClick={() => { setOpen(false); setTrashing(true) }}>Move to Trash…</button>
          </> : null}
        </div>
      ) : null}
      {trashing ? (
        <div className="file-confirm" role="alertdialog" aria-label={`Move ${label} to the Trash`}>
          <span>Move {label} to the Trash? You can put it back from the Trash in Finder.</span>
          <button type="button" className="button-soft" onClick={() => setTrashing(false)}>Cancel</button>
          <button type="button" className="button-danger" onClick={() => {
            setTrashing(false)
            desktop('trash')().then(onTrashed, (e: unknown) => onError(message(e)))
          }}>Move to Trash</button>
        </div>
      ) : null}
    </div>
  )
}
