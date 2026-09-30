import type { Project } from '../api.ts'
import { useOpenFiles } from '../useOpenFiles.ts'
import { FileEditor } from './FileEditor.tsx'
import { FileTree } from './FileTree.tsx'
import { FolderIcon } from './icons.tsx'

export function Files({ project, onAttach }: { project?: Project; onAttach: (reference: string) => void }) {
  const open = useOpenFiles(project?.path)
  if (!project) return <main className="workflow-empty"><FolderIcon /><h1>Files</h1><p>Open a project to browse its files.</p></main>
  return (
    <div className="files-layout">
      <FileTree project={project} selected={open.active} onOpen={(path) => void open.open(path)} onCreate={open.create} />
      <FileEditor
        files={open.files}
        active={open.active}
        error={open.error}
        onSelect={(path) => void open.open(path)}
        onClose={open.close}
        onChange={open.edit}
        onSave={(path) => void open.save(path)}
        onReload={(path) => void open.reload(path)}
        onOverwrite={(path) => void open.overwrite(path)}
        onAttach={(path) => onAttach(`@file:${encodeURIComponent(path)}`)}
      />
    </div>
  )
}
