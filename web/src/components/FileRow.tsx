import { useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { api } from '../api.ts'
import { fileName, joinName, spaceOf, splitName, visibleName } from '../file-text.ts'
import { native } from '../native.ts'
import { usePopover } from '../usePopover.ts'
import { nativeFolder, type WorkspaceRef } from '../workspaces.ts'
import { FileIcon, MoreIcon, PinIcon } from './icons.tsx'

export interface ExtraAction { readonly label: string; run(): Promise<unknown> }

interface FileRowProps {
  projectPath: string
  /** The workspace the file lives in, when it is a worktree (project files only; documents are the project's). */
  workspace?: WorkspaceRef
  /** The tab path: plain for project files, "documents:<name>" for your documents. */
  path: string
  selected: boolean
  pinned?: boolean
  /** Open with unsaved changes: renaming waits until they are saved or discarded. */
  dirty: boolean
  /** Pin and archive, for documents. */
  extra?: readonly ExtraAction[]
  detail?: ReactNode
  status?: 'Archived'
  onOpen: () => void
  onRenamed: (to: string) => void
  onTrashed: () => void
  onError: (message: string) => void
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** One file in a list, with Rename, Open in default app, Reveal in Finder and Move to Trash behind ⋯. */
export function FileRow({ projectPath, workspace, path, selected, pinned, dirty, extra = [], detail, status, onOpen, onRenamed, onTrashed, onError }: FileRowProps) {
  const { open, setOpen, ref } = usePopover<HTMLDivElement>()
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(() => splitName(fileName(path)))
  const [trashing, setTrashing] = useState(false)
  const label = fileName(path)
  // What is shown; `label` stays the real name for renaming.
  const shown = visibleName(label)
  const { space, path: plain } = spaceOf(path)
  const act = (run: () => Promise<unknown>): void => { setOpen(false); run().catch((e: unknown) => onError(message(e))) }
  const desktop = (action: 'open' | 'reveal' | 'trash') => async (): Promise<void> => {
    const failure = await native?.fileAction({ projectPath: nativeFolder(projectPath, space, workspace), space, path: plain, action })
    if (failure) throw new Error(failure)
  }
  const rename = (event: FormEvent): void => {
    event.preventDefault()
    const next = joinName(name.stem, name.ext)
    if (next === label) { setRenaming(false); return }
    api.renameFile(projectPath, path, next, workspace?.scope).then((to) => { setRenaming(false); onRenamed(to) }, (e: unknown) => onError(message(e)))
  }

  const cancelOnEscape = (e: KeyboardEvent<HTMLInputElement>): void => { if (e.key === 'Escape') { setRenaming(false); setName(splitName(label)) } }

  if (renaming) {
    return (
      <form className="file-row file-rename" onSubmit={rename}>
        <FileIcon />
        <input aria-label={`New name for ${shown}`} value={name.stem} autoFocus onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setName({ ...name, stem: e.target.value })} onKeyDown={cancelOnEscape} />
        <span className="file-rename-dot" aria-hidden>.</span>
        <input className="file-rename-ext" aria-label={`Extension for ${shown}`} value={name.ext} placeholder="ext"
          onChange={(e) => setName({ ...name, ext: e.target.value })} onKeyDown={cancelOnEscape} />
        <button type="submit" className="button-soft">Rename</button>
      </form>
    )
  }
  return (
    <div className={`file-row-wrap${selected ? ' selected' : ''}`} ref={ref}>
      <button type="button" className={`file-row ${selected ? 'selected' : ''}`} onClick={onOpen}>
        <FileIcon />
        <span>{shown}</span>
        {pinned ? <PinIcon className="file-pin" title="Pinned" /> : null}
        {detail}
        {dirty || status ? <span className={`file-row-status${dirty ? ' unsaved' : ''}`}>{dirty ? 'Unsaved' : status}</span> : null}
      </button>
      <button type="button" className="file-more" aria-label={`More for ${shown}`} aria-expanded={open} onClick={() => setOpen(!open)}><MoreIcon /></button>
      {open ? (
        <div className="menu file-menu" role="menu" aria-label={`${shown} actions`}>
          <button type="button" role="menuitem" className="menu-item" onClick={() => {
            setOpen(false)
            if (dirty) onError(`Save or discard the changes to ${shown} before renaming it`)
            else { setName(splitName(label)); setRenaming(true) }
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
        <div className="file-confirm" role="alertdialog" aria-label={`Move ${shown} to the Trash`}>
          <span>Move {shown} to the Trash? You can put it back from the Trash in Finder.</span>
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
