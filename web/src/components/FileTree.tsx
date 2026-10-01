import { useEffect, useState } from 'react'
import { api, type FileListing, type Project } from '../api.ts'
import type { NewFileKind } from '../file-text.ts'
import { FileRow } from './FileRow.tsx'
import { FolderIcon } from './icons.tsx'
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
}

export function FileTree({ project, selected, dirty, onOpen, onCreate, onRenamed, onTrashed, onError }: FileTreeProps) {
  const [folder, setFolder] = useState('')
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

  return (
    <>
      <div className="file-location">
        <button type="button" disabled={!folder} onClick={() => setFolder(folder.split('/').slice(0, -1).join('/'))}>↑ Up</button>
        <code>{folder || '/'}</code>
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
          onOpen={() => onOpen(entry.path)} onError={onError}
          onRenamed={(to) => { onRenamed(entry.path, to); reload() }}
          onTrashed={() => { onTrashed(entry.path); reload() }} />
      ))}
      {listing?.truncated ? <p>Showing the first 500 entries. Open a subfolder to narrow the list.</p> : null}
    </>
  )
}
