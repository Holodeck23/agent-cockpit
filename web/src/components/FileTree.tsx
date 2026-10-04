import { useEffect, useState } from 'react'
import { api, type FileListing, type Project } from '../api.ts'
import { nextInFolder, type NewFileKind } from '../file-text.ts'
import { dropPin, renamePin, togglePin } from '../pins.ts'
import { useFileDrop } from '../useFileDrop.ts'
import { FileRow } from './FileRow.tsx'
import { back, canGoBack, canGoForward, currentFolder, forward, parentOf, startHistory, visit } from '../folder-history.ts'
import { ArrowUpLeftIcon, ChevronLeftIcon, ChevronRightIcon, FolderIcon, HomeIcon } from './icons.tsx'
import { NewFileMenu } from './NewFileMenu.tsx'

interface FileTreeProps {
  project: Project
  selected?: string
  /** Open files with unsaved changes. */
  dirty: ReadonlySet<string>
  onOpen: (path: string) => void
  /** Creates a file in the folder being shown; resolves true once it is open. */
  onCreate: (folder: string, name: string, kind: NewFileKind) => Promise<boolean>
  onRenamed: (from: string, to: string) => void
  onTrashed: (path: string) => void
  onError: (message: string) => void
  /** Files pinned to the navigation, in order, and how to change them. */
  pins: readonly string[]
  onPins: (pins: readonly string[]) => void
}

export function FileTree({ project, selected, dirty, onOpen, onCreate, onRenamed, onTrashed, onError, pins, onPins }: FileTreeProps) {
  const [history, setHistory] = useState(startHistory)
  const folder = currentFolder(history)
  const setFolder = (next: string): void => setHistory((h) => visit(h, next))
  const [listing, setListing] = useState<FileListing>()
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const reload = (): void => setRefresh((n) => n + 1)

  useEffect(() => {
    let active = true
    setListing(undefined)
    setError('')
    api.listFiles(project.path, folder).then(
      (next) => { if (active) setListing(next) },
      (e: unknown) => { if (active) setError(e instanceof Error ? e.message : String(e)) },
    )
    return () => { active = false }
  }, [project, folder, refresh])

  // Files dropped here are copied into this folder (F8); the list then shows them.
  const [dropNote, setDropNote] = useState('')
  const { dragging, dropProps } = useFileDrop({ projectPath: project.path, space: 'project', folder }, (result) => {
    setDropNote(result.note)
    reload()
    if (result.copied.length === 1) onOpen(result.copied[0]!)
  }, onError)
  const filePaths = listing?.entries.filter((e) => e.kind !== 'directory').map((e) => e.path) ?? []

  return (
    <div className={`file-drop${dragging ? ' dragging' : ''}`} {...dropProps}>
      {dragging ? <p className="file-drop-hint" aria-hidden>Drop to copy into {folder || 'the project top'}</p> : null}
      <div className="file-location">
        <div className="file-nav" role="group" aria-label="Folder navigation">
          <button type="button" aria-label="Home" title="Project top" disabled={!folder} onClick={() => setFolder('')}><HomeIcon /></button>
          <button type="button" aria-label="Back" title="Back" disabled={!canGoBack(history)} onClick={() => setHistory(back)}><ChevronLeftIcon /></button>
          <button type="button" aria-label="Forward" title="Forward" disabled={!canGoForward(history)} onClick={() => setHistory(forward)}><ChevronRightIcon /></button>
          <button type="button" aria-label="Up" title="Enclosing folder" disabled={!folder} onClick={() => setFolder(parentOf(folder))}><ArrowUpLeftIcon /></button>
        </div>
        <code className="file-path">{folder || '/'}</code>
        <NewFileMenu onCreate={async (name, kind) => { const ok = await onCreate(folder, name, kind); if (ok) reload(); return ok }} />
      </div>
      {!listing ? <p role="status">{error ? 'Folder unavailable' : 'Loading files…'}</p> : listing.entries.length === 0 ? <p>No files in this folder.</p> : null}
      {listing?.entries.map((entry) => entry.kind === 'directory' ? (
        <button type="button" key={entry.path} className="file-row" onClick={() => setFolder(entry.path)}>
          <FolderIcon />
          <span>{entry.name}</span>
          <span>›</span>
        </button>
      ) : (
        <FileRow key={entry.path} projectPath={project.path} path={entry.path} selected={selected === entry.path} dirty={dirty.has(entry.path)}
          pinned={pins.includes(entry.path)}
          extra={[{ label: pins.includes(entry.path) ? 'Unpin from navigation' : 'Pin to navigation', run: async () => onPins(togglePin(pins, entry.path)) }]}
          onOpen={() => onOpen(entry.path)} onError={onError}
          onRenamed={(to) => { onRenamed(entry.path, to); if (pins.includes(entry.path)) onPins(renamePin(pins, entry.path, to)); reload() }}
          onTrashed={() => {
            // The file you were looking at went to the Trash: show the next one in this folder.
            const next = selected === entry.path ? nextInFolder(filePaths, entry.path) : undefined
            onTrashed(entry.path)
            if (pins.includes(entry.path)) onPins(dropPin(pins, entry.path))
            reload()
            if (next) onOpen(next)
          }} />
      ))}
      {listing?.truncated ? <p>Showing the first 500 entries. Open a subfolder to narrow the list.</p> : null}
      {dropNote ? <p className="file-drop-note" role="status">{dropNote} <button type="button" className="link-button" onClick={() => setDropNote('')}>OK</button></p> : null}
    </div>
  )
}
