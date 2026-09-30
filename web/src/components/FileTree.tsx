import { useEffect, useState, type FormEvent } from 'react'
import { api, type FileListing, type Project } from '../api.ts'
import { FileIcon, FolderIcon, PlusIcon } from './icons.tsx'

interface FileTreeProps {
  project: Project
  selected?: string
  onOpen: (path: string) => void
  /** Creates an empty file in the folder being shown; resolves true once it is open. */
  onCreate: (folder: string, name: string) => Promise<boolean>
}

export function FileTree({ project, selected, onOpen, onCreate }: FileTreeProps) {
  const [folder, setFolder] = useState('')
  const [listing, setListing] = useState<FileListing>()
  const [error, setError] = useState('')
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [refresh, setRefresh] = useState(0)

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

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (await onCreate(folder, name)) {
      setNaming(false)
      setName('')
      setRefresh((n) => n + 1)
    }
  }

  return (
    <nav className="file-list" aria-label="Project files">
      <header>
        <span className="workflow-kicker">{project.name}</span>
        <h1>Files</h1>
        <p>Edit a text file, or add it to a conversation draft.</p>
      </header>
      <div className="file-location">
        <button type="button" disabled={!folder} onClick={() => setFolder(folder.split('/').slice(0, -1).join('/'))}>↑ Up</button>
        <code>{folder || '/'}</code>
        <button type="button" className="file-new" onClick={() => setNaming(!naming)} aria-expanded={naming}>
          <PlusIcon /> New file
        </button>
      </div>
      {naming ? (
        <form className="file-new-form" onSubmit={(e) => void submit(e)}>
          <input aria-label="New file name" placeholder="notes.md" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="button-primary" disabled={!name.trim()}>Create</button>
        </form>
      ) : null}
      {!listing ? <p role="status">{error ? 'Folder unavailable' : 'Loading files…'}</p> : listing.entries.length === 0 ? <p>No files in this folder.</p> : null}
      {listing?.entries.map((entry) => (
        <button type="button" key={entry.path} className={`file-row ${selected === entry.path ? 'selected' : ''}`}
          onClick={() => (entry.kind === 'directory' ? setFolder(entry.path) : onOpen(entry.path))}>
          {entry.kind === 'directory' ? <FolderIcon /> : <FileIcon />}
          <span>{entry.name}</span>
          {entry.kind === 'directory' ? <span>›</span> : null}
        </button>
      ))}
      {listing?.truncated ? <p>Showing the first 500 entries. Open a subfolder to narrow the list.</p> : null}
      <footer>Generated folders, dependencies and symbolic links are hidden. UTF-8 text files up to 100 KB can be edited.</footer>
    </nav>
  )
}
