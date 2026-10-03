import { useState, type FormEvent } from 'react'
import { native } from '../native.ts'
import type { Projects } from '../useProjects.ts'
import { usePopover } from '../usePopover.ts'
import { ChatIcon, ChevronDownIcon, FolderIcon, PinIcon, PlusIcon, TrashIcon } from './icons.tsx'
import { ImportConversations } from './ImportConversations.tsx'
import type { Project, ThreadMeta } from '../api.ts'
import { ProjectAvatar } from './ProjectAvatar.tsx'
import { ProjectSettings } from './ProjectSettings.tsx'

interface ProjectsMenuProps {
  projects: Projects
  /** A session was imported as a conversation: show it. */
  onImported?: (meta: ThreadMeta) => void
}

export function ProjectsMenu({ projects, onImported }: ProjectsMenuProps) {
  const { open, setOpen, ref: rootRef } = usePopover<HTMLDivElement>()
  const [typedPath, setTypedPath] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  // The row asking "Remove … from Cockpit?" inside the menu, and whether that removal is running.
  const [removing, setRemoving] = useState<string>()
  const [busy, setBusy] = useState(false)
  const active = projects.active

  const remove = async (project: Project): Promise<void> => {
    setBusy(true)
    try {
      await projects.remove(project)
      setRemoving(undefined)
    } catch (e: unknown) {
      projects.reportError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const openPath = (path: string): void => {
    setOpen(false)
    void projects.open(path)
  }

  const newProject = async (): Promise<void> => {
    setOpen(false)
    const created = await native?.newProject(active?.path)
    if (!created) return
    if ('error' in created) projects.reportError(created.error)
    else void projects.open(created.path)
  }

  const pickFolder = async (): Promise<void> => {
    const path = await native?.pickFolder()
    if (path) openPath(path)
  }

  const submitTyped = (event: FormEvent): void => {
    event.preventDefault()
    const path = typedPath.trim()
    if (!path) return
    setTypedPath('')
    openPath(path)
  }

  return (
    <div className="projects-menu" ref={rootRef}>
      <button type="button" className="projects-button" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}>
        <FolderIcon />
        Projects
        <ChevronDownIcon className="chevron" />
      </button>
      {open ? (
        <div className="menu" role="menu" aria-label="Projects">
          {native ? (
            <>
              <button type="button" role="menuitem" className="menu-item" onClick={() => void newProject()}>
                <PlusIcon />
                New project…
              </button>
              <button type="button" role="menuitem" className="menu-item" onClick={() => void pickFolder()}>
                <FolderIcon />
                Open folder…
              </button>
            </>
          ) : (
            <form className="menu-path" onSubmit={submitTyped}>
              <input
                aria-label="Folder path"
                placeholder="/path/to/project"
                value={typedPath}
                onChange={(e) => setTypedPath(e.target.value)}
              />
              <button type="submit">Open</button>
            </form>
          )}
          {active ? (
            <button type="button" role="menuitem" className="menu-item" onClick={() => { setOpen(false); setSettingsOpen(true) }}>
              <FolderIcon />
              {active.name} settings…
            </button>
          ) : null}
          {active && onImported ? (
            <button type="button" role="menuitem" className="menu-item" onClick={() => { setOpen(false); setImportOpen(true) }}>
              <ChatIcon />
              Import conversations…
            </button>
          ) : null}
          {projects.all.length > 0 ? <p className="menu-label">Recent</p> : null}
          <ul className="menu-list">
            {projects.all.map((project) => (
              <li key={project.path} className="project-row">
                {removing === project.path ? (
                  <div className="project-remove" role="alertdialog" aria-label={`Remove ${project.name} from Cockpit`}>
                    <span>Remove <strong>{project.name}</strong> from Cockpit? The folder and its conversations stay; schedules in it are paused.</span>
                    <div>
                      <button type="button" className="button-soft" disabled={busy} onClick={() => setRemoving(undefined)}>Cancel</button>
                      <button type="button" className="button-danger" disabled={busy} onClick={() => void remove(project)}>Remove</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <button type="button" role="menuitem" className="menu-item project-item" title={project.path} onClick={() => openPath(project.path)}>
                      <ProjectAvatar project={project} solid={project.path === projects.active?.path} />
                      <span className="project-item-text">
                        <span className="project-item-name">{project.name}</span>
                        <span className="project-item-path"><bdi dir="ltr">{project.path}</bdi></span>
                      </span>
                      {project.pinned ? <PinIcon className="pinned-mark" title="Pinned" /> : null}
                    </button>
                    <button type="button" className="project-remove-button" aria-label={`Remove ${project.name} from Cockpit`} title="Remove from Cockpit"
                      onClick={() => setRemoving(project.path)}><TrashIcon /></button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {importOpen && active && onImported ? (
        <ImportConversations project={active} onClose={() => setImportOpen(false)} onImported={(meta) => { setImportOpen(false); onImported(meta) }} />
      ) : null}
      {settingsOpen && active ? (
        <ProjectSettings key={active.path} project={active} onSave={(patch) => projects.saveSettings(active, patch)}
          onImage={(image) => projects.setImage(active, image)} onRemove={() => projects.remove(active)} onClose={() => setSettingsOpen(false)} />
      ) : null}
    </div>
  )
}
