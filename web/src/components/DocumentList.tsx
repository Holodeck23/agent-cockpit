import { useCallback, useEffect, useState } from 'react'
import { api, type DocumentEntry, type Project } from '../api.ts'
import { inSpace, nextInFolder, type NewFileKind } from '../file-text.ts'
import { FileRow } from './FileRow.tsx'
import { NewFileMenu } from './NewFileMenu.tsx'

interface DocumentListProps {
  project: Project
  selected?: string
  dirty: ReadonlySet<string>
  onOpen: (path: string) => void
  onCreate: (name: string, kind: NewFileKind) => Promise<boolean>
  onRenamed: (from: string, to: string) => void
  onTrashed: (path: string) => void
  onError: (message: string) => void
}

/** Your documents: kept by Cockpit for this project, outside the repository. Pinned first; archived ones have their own view. */
export function DocumentList({ project, selected, dirty, onOpen, onCreate, onRenamed, onTrashed, onError }: DocumentListProps) {
  const [docs, setDocs] = useState<DocumentEntry[]>()
  const [showArchived, setShowArchived] = useState(false)
  const reload = useCallback((): void => {
    api.listDocuments(project.path).then(setDocs, (e: unknown) => onError(e instanceof Error ? e.message : String(e)))
  }, [project.path, onError])
  useEffect(reload, [reload])
  const mark = (path: string, change: { pinned?: boolean; archived?: boolean }) => async (): Promise<void> => {
    setDocs(await api.markDocument(project.path, path, change))
  }
  const archivedCount = docs?.filter((d) => d.archived).length ?? 0
  const shown = docs?.filter((d) => d.archived === showArchived) ?? []

  return (
    <>
      <div className="file-location">
        <div className="doc-views" role="tablist" aria-label="Documents">
          <button type="button" role="tab" aria-selected={!showArchived} onClick={() => setShowArchived(false)}>Current</button>
          <button type="button" role="tab" aria-selected={showArchived} onClick={() => setShowArchived(true)}>Archived <span>{archivedCount}</span></button>
        </div>
        {showArchived ? null : <NewFileMenu onCreate={async (name, kind) => { const ok = await onCreate(name, kind); if (ok) reload(); return ok }} />}
      </div>
      {!docs ? <p role="status">Loading documents…</p> : shown.length === 0 ? (
        <p>{showArchived ? 'Nothing archived.' : 'No documents yet. Notes, plans and drafts you keep here stay out of the repository.'}</p>
      ) : null}
      {shown.map((doc) => {
        const path = inSpace('documents', doc.path)
        const extra = doc.archived
          ? [{ label: 'Unarchive', run: mark(doc.path, { archived: false }) }]
          : [{ label: doc.pinned ? 'Unpin' : 'Pin', run: mark(doc.path, { pinned: !doc.pinned }) }, { label: 'Archive', run: mark(doc.path, { archived: true }) }]
        return (
          <FileRow key={doc.path} projectPath={project.path} path={path} selected={selected === path} pinned={doc.pinned} dirty={dirty.has(path)}
            extra={extra} onOpen={() => onOpen(path)} onError={onError}
            onRenamed={(to) => { onRenamed(path, to); reload() }} onTrashed={() => {
              const next = selected === path ? nextInFolder(shown.map((d) => inSpace('documents', d.path)), path) : undefined
              onTrashed(path)
              reload()
              if (next) onOpen(next)
            }} />
        )
      })}
    </>
  )
}
