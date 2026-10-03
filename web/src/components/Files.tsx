import { useEffect, useMemo, useState } from 'react'
import type { Project } from '../api.ts'
import { isDirty, spaceOf } from '../file-text.ts'
import { useOpenFiles } from '../useOpenFiles.ts'
import { DocumentList } from './DocumentList.tsx'
import { FileEditor, type Jump } from './FileEditor.tsx'
import type { FileTarget } from '../markdown/file-links.ts'
import { FileTree } from './FileTree.tsx'
import { FolderIcon } from './icons.tsx'

type Space = 'project' | 'documents'
const SPACE_KEY = 'cockpit:files-space'
const EXPLORER_KEY = 'cockpit:files-explorer-hidden'
const loadHidden = (): boolean => { try { return localStorage.getItem(EXPLORER_KEY) === '1' } catch { return false } }
const loadSpace = (): Space => { try { return localStorage.getItem(SPACE_KEY) === 'documents' ? 'documents' : 'project' } catch { return 'project' } }

export function Files({ project, onAttach, reveal }: { project?: Project; onAttach: (reference: string) => void; reveal?: { target: FileTarget; nonce: number } }) {
  const open = useOpenFiles(project?.path)
  const [space, setSpace] = useState<Space>(loadSpace)
  const [jump, setJump] = useState<Jump>()
  const [hidden, setHidden] = useState(loadHidden)
  const toggleExplorer = (): void => {
    setHidden(!hidden)
    try { localStorage.setItem(EXPLORER_KEY, hidden ? '0' : '1') } catch { /* not remembered */ }
  }
  // A reply's file link: open the file in Project files, then select its lines.
  const { open: openPath } = open
  useEffect(() => {
    if (!reveal) return
    setSpace('project')
    const { path, line, endLine } = reveal.target
    void openPath(path).then(() => { if (line) setJump({ path, line, endLine, nonce: reveal.nonce }) })
  }, [reveal, openPath])
  const dirty = useMemo(() => new Set(open.files.filter(isDirty).map((f) => f.path)), [open.files])
  const choose = (next: Space): void => {
    setSpace(next)
    try { localStorage.setItem(SPACE_KEY, next) } catch { /* not remembered */ }
  }
  if (!project) return <main className="workflow-empty"><FolderIcon /><h1>Files</h1><p>Open a project to browse its files.</p></main>
  const shared = {
    project, selected: open.active, dirty, onOpen: (path: string) => void open.open(path),
    onRenamed: open.renamed, onTrashed: open.removed, onError: open.setError,
  }
  return (
    <div className={`files-layout${hidden ? ' explorer-hidden' : ''}`}>
      <nav className="file-list" hidden={hidden} aria-label={space === 'project' ? 'Project files' : 'Your documents'}>
        <header>
          <span className="workflow-kicker">{project.name}</span>
          <h1>Files</h1>
          <div className="file-spaces" role="tablist" aria-label="Where">
            <button type="button" role="tab" aria-selected={space === 'project'} onClick={() => choose('project')}>Project files</button>
            <button type="button" role="tab" aria-selected={space === 'documents'} onClick={() => choose('documents')}>Your documents</button>
          </div>
          <p>{space === 'project' ? 'Edit a text file, or add it to a conversation draft.' : 'Notes and drafts Cockpit keeps for this project, outside the repository.'}</p>
        </header>
        {space === 'project'
          ? <FileTree key={project.path} {...shared} onCreate={(folder, name, kind) => open.create(folder, name, kind, 'project')} />
          : <DocumentList {...shared} onCreate={(name, kind) => open.create('', name, kind, 'documents')} />}
        <footer>Generated folders, dependencies and symbolic links are hidden. UTF-8 text files up to 100 KB can be edited.</footer>
      </nav>
      <FileEditor
        files={open.files}
        active={open.active}
        error={open.error}
        onSelect={(path) => void open.open(path)}
        onClose={open.close}
        onCloseMany={open.closeMany}
        onChange={open.edit}
        onSave={(path, draft) => void open.save(path, { draft })}
        onReload={(path) => void open.reload(path)}
        onOverwrite={(path) => void open.overwrite(path)}
        onSaveCopy={(path) => void open.saveCopy(path)}
        onAttach={(path) => { if (spaceOf(path).space === 'project') onAttach(`@file:${encodeURIComponent(path)}`) }}
        jump={jump}
        explorer={{ hidden, toggle: toggleExplorer }}
      />
    </div>
  )
}
