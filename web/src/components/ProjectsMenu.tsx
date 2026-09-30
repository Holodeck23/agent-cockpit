import { useState, type FormEvent } from 'react'
import { native } from '../native.ts'
import type { Projects } from '../useProjects.ts'
import { usePopover } from '../usePopover.ts'
import { ChevronDownIcon, FolderIcon, PinIcon, PlusIcon } from './icons.tsx'
import { ProjectAvatar } from './ProjectAvatar.tsx'
import { ProjectSettings } from './ProjectSettings.tsx'

interface ProjectsMenuProps {
  projects: Projects
}

export function ProjectsMenu({ projects }: ProjectsMenuProps) {
  const { open, setOpen, ref: rootRef } = usePopover<HTMLDivElement>()
  const [typedPath, setTypedPath] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const active = projects.active

  const openPath = (path: string): void => {
    setOpen(false)
    void projects.open(path)
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
            <button type="button" role="menuitem" className="menu-item" onClick={() => void pickFolder()}>
              <PlusIcon />
              Open folder…
            </button>
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
          {projects.all.length > 0 ? <p className="menu-label">Recent</p> : null}
          <ul className="menu-list">
            {projects.all.map((project) => (
              <li key={project.path}>
                <button type="button" role="menuitem" className="menu-item project-item" title={project.path} onClick={() => openPath(project.path)}>
                  <ProjectAvatar project={project} solid={project.path === projects.active?.path} />
                  <span className="project-item-text">
                    <span className="project-item-name">{project.name}</span>
                    <span className="project-item-path"><bdi dir="ltr">{project.path}</bdi></span>
                  </span>
                  {project.pinned ? <PinIcon className="pinned-mark" title="Pinned" /> : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {settingsOpen && active ? (
        <ProjectSettings key={active.path} project={active} onSave={(text) => projects.saveInstructions(active, text)} onClose={() => setSettingsOpen(false)} />
      ) : null}
    </div>
  )
}
