import { useCallback, useEffect, useState } from 'react'
import { api, type DocumentEntry, type DocumentMatch, type Project } from '../api.ts'
import { inSpace, nextInFolder, type NewFileKind } from '../file-text.ts'
import { FileRow } from './FileRow.tsx'
import { SearchIcon } from './icons.tsx'
import { announceDocuments } from '../usePinnedDocuments.ts'
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
  // Searching looks through current and archived documents, by name and by text.
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<DocumentMatch[]>()
  const searching = query.trim().length > 0
  useEffect(() => {
    if (!searching) { setMatches(undefined); return }
    let active = true
    const timer = setTimeout(() => {
      api.searchDocuments(project.path, query).then((found) => { if (active) setMatches(found) }, (e: unknown) => onError(e instanceof Error ? e.message : String(e)))
    }, 150)
    return () => { active = false; clearTimeout(timer) }
  }, [project.path, query, searching, docs, onError])
  const reload = useCallback((): void => {
    api.listDocuments(project.path).then((next) => { setDocs(next); announceDocuments() }, (e: unknown) => onError(e instanceof Error ? e.message : String(e)))
  }, [project.path, onError])
  useEffect(reload, [reload])
  const mark = (path: string, change: { pinned?: boolean; archived?: boolean }) => async (): Promise<void> => {
    setDocs(await api.markDocument(project.path, path, change))
    announceDocuments()
  }
  const archivedCount = docs?.filter((d) => d.archived).length ?? 0
  const shown: readonly DocumentMatch[] = searching ? matches ?? [] : docs?.filter((d) => d.archived === showArchived) ?? []

  return (
    <>
      <label className="search doc-search">
        <SearchIcon />
        <input type="search" placeholder="Search documents and the archive…" aria-label="Search documents" value={query}
          onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setQuery('') }} />
      </label>
      <div className="file-location" hidden={searching}>
        <div className="doc-views" role="tablist" aria-label="Documents">
          <button type="button" role="tab" aria-selected={!showArchived} onClick={() => setShowArchived(false)}>Current</button>
          <button type="button" role="tab" aria-selected={showArchived} onClick={() => setShowArchived(true)}>Archived <span>{archivedCount}</span></button>
        </div>
        {showArchived ? null : <NewFileMenu onCreate={async (name, kind) => { const ok = await onCreate(name, kind); if (ok) reload(); return ok }} />}
      </div>
      {searching ? (
        <p role="status" className="doc-search-status">{!matches ? 'Searching…' : matches.length === 0 ? `No documents match “${query.trim()}”.` : `${matches.length} ${matches.length === 1 ? 'document matches' : 'documents match'}`}</p>
      ) : !docs ? <p role="status">Loading documents…</p> : shown.length === 0 ? (
        <p>{showArchived ? 'Nothing archived.' : 'No documents yet. Notes, plans and drafts you keep here stay out of the repository.'}</p>
      ) : null}
      {shown.map((doc) => {
        const path = inSpace('documents', doc.path)
        const extra = doc.archived
          ? [{ label: 'Unarchive', run: mark(doc.path, { archived: false }) }]
          : [{ label: doc.pinned ? 'Unpin from navigation' : 'Pin to navigation', run: mark(doc.path, { pinned: !doc.pinned }) }, { label: 'Archive', run: mark(doc.path, { archived: true }) }]
        return (
          <FileRow key={doc.path} projectPath={project.path} path={path} selected={selected === path} pinned={doc.pinned} dirty={dirty.has(path)}
            extra={extra} onOpen={() => onOpen(path)} onError={onError}
            detail={searching ? <span className="doc-match">{doc.archived ? <span className="doc-archived-tag">Archived</span> : null}{doc.excerpt ? <span className="doc-excerpt">{doc.excerpt}</span> : null}</span> : undefined}
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
