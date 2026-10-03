import type { Project } from '../api.ts'
import type { Projects } from '../useProjects.ts'
import type { ThreadMeta } from '../api.ts'
import { Bars, ChatIcon, Mark, PinIcon } from './icons.tsx'
import { ProjectAvatar } from './ProjectAvatar.tsx'
import { ProjectsMenu } from './ProjectsMenu.tsx'
import { projectHint } from '../shortcuts.ts'

interface ProjectTabBarProps {
  projects: Projects
  onImported?: (meta: ThreadMeta) => void
}

function Tab({ project, active, projects, hint }: { project: Project; active: boolean; projects: Projects; hint?: string }) {
  const { working, needsYou } = projects.countsFor(project.path)
  return (
    <div className={`tab tint-${project.color}${active ? ' active' : ''}`} role="presentation">
      <button
        type="button"
        role="tab"
        aria-selected={active}
        className="tab-main"
        title={hint ? `${project.path}  (${hint})` : project.path}
        onClick={() => projects.select(project.path)}
      >
        <ProjectAvatar project={project} solid={active} />
        <span className="tab-name">{project.name}</span>
        {working > 0 ? (
          <span className="tab-badge" aria-label={`${working} working`}>
            <Bars live />
            {working}
          </span>
        ) : null}
        {needsYou > 0 ? (
          <span className="tab-needs" aria-label={`${needsYou} need you`}>
            <ChatIcon />
            <span className="count-dot">{needsYou}</span>
          </span>
        ) : null}
      </button>
      {active ? (
        <button
          type="button"
          className={`tab-pin${project.pinned ? ' pinned' : ''}`}
          aria-label={project.pinned ? `Unpin ${project.name}` : `Pin ${project.name}`}
          title={project.pinned ? 'Unpin tab' : 'Pin tab'}
          onClick={() => void projects.togglePin(project)}
        >
          <PinIcon />
        </button>
      ) : null}
    </div>
  )
}

export function ProjectTabBar({ projects, onImported }: ProjectTabBarProps) {
  return (
    <header className="tabbar">
      <Mark className="tabbar-mark" />
      <div className="tabs" role="tablist" aria-label="Projects">
        {projects.tabs.map((project, index) => (
          <Tab key={project.path} project={project} active={project.path === projects.active?.path} projects={projects}
            hint={projectHint(index, projects.tabs.length)} />
        ))}
      </div>
      <div className="tabbar-spacer" />
      <ProjectsMenu projects={projects} onImported={onImported} />
    </header>
  )
}
