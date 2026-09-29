import { useEffect, useRef, useState } from 'react'
import { api, type FileListing, type FilePreview, type Project } from '../api.ts'
import { FileIcon, FolderIcon } from './icons.tsx'

export function Files({ project, onAttach }: { project?: Project; onAttach: (reference: string) => void }) {
  const [path, setPath] = useState('')
  const [listing, setListing] = useState<FileListing>()
  const [preview, setPreview] = useState<FilePreview>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const version = useRef(0)
  useEffect(() => {
    if (!project) return
    let active = true
    setListing(undefined)
    api.listFiles(project.path, path).then((next) => { if (active) setListing(next) }, (e: unknown) => { if (active) setError(String(e)) })
    return () => { active = false }
  }, [project, path])
  useEffect(() => () => { ++version.current }, [])
  const browse = (path: string) => { ++version.current; setLoading(false); setPreview(undefined); setError(''); setPath(path) }
  const read = async (path: string) => {
    if (!project) return
    const request = ++version.current
    setLoading(true); setError(''); setPreview(undefined)
    try { const file = await api.readFile(project.path, path); if (request === version.current) setPreview(file) }
    catch (e) { if (request === version.current) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (request === version.current) setLoading(false) }
  }
  if (!project) return <main className="workflow-empty"><FolderIcon /><h1>Files</h1><p>Open a project to browse its files.</p></main>
  return <div className="files-layout">
    <nav className="file-list" aria-label="Project files"><header><span className="workflow-kicker">{project.name}</span><h1>Files</h1>
      <p>Preview a text file, then add it to a conversation draft.</p></header>
      <div className="file-location"><button type="button" disabled={!path} onClick={() => browse(path.split('/').slice(0, -1).join('/'))}>↑ Up</button><code>{path || '/'}</code></div>
      {!listing ? <p role="status">{error ? 'Folder unavailable' : 'Loading files…'}</p> : listing.entries.length === 0 ? <p>No files in this folder.</p> : null}
      {listing?.entries.map((entry) => <button type="button" key={entry.path} className={`file-row ${preview?.path === entry.path ? 'selected' : ''}`}
        onClick={() => entry.kind === 'directory' ? browse(entry.path) : void read(entry.path)}>
        {entry.kind === 'directory' ? <FolderIcon /> : <FileIcon />}<span>{entry.name}</span>{entry.kind === 'directory' ? <span>›</span> : null}</button>)}
      {listing?.truncated ? <p>Showing the first 500 entries. Open a subfolder to narrow the list.</p> : null}
      <footer>Generated folders, dependencies and symbolic links are hidden. Text previews support UTF-8 files up to 100 KB.</footer>
    </nav>
    <main className="file-preview">
      {error ? <div className="workflow-notice" role="alert">{error}</div> : null}
      {loading ? <p role="status">Loading preview…</p> : preview ? <>
        <header><div><h2>{preview.path}</h2><span>{preview.bytes.toLocaleString()} bytes · Text preview</span></div>
          <button type="button" className="button-primary" onClick={() => onAttach(`@file:${encodeURIComponent(preview.path)}`)}>Add to conversation</button></header>
        <p className="file-help">The file is read again when you send the message. Its contents will be included in the agent conversation.</p>
        <pre tabIndex={0} aria-label="File contents">{preview.text}</pre>
      </> : !error ? <div className="workflow-empty"><FileIcon /><h2>Keep the relevant file close.</h2><p>Select a text file to read it here and add its contents to your conversation draft.</p></div> : null}
    </main>
  </div>
}
