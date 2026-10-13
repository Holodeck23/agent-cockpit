import { useCallback, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import type { Project } from '../api.ts'
import type { Projects } from '../useProjects.ts'
import type { ThreadMeta } from '../api.ts'
import { Bars, ChatIcon, CloseIcon, Mark, PinIcon } from './icons.tsx'
import { ProjectAvatar } from './ProjectAvatar.tsx'
import { ProjectsMenu } from './ProjectsMenu.tsx'
import { ProjectSettings } from './ProjectSettings.tsx'
import { TabMenu } from './TabMenu.tsx'
import { moveTab, nextAfterClose } from '../project-tabs.ts'
import { projectHint } from '../shortcuts.ts'
import { useTabDrag, type TabDrag } from '../useTabDrag.ts'

// The project tabs. A tab is a pinned project (plus the active one if it isn't pinned). × closes the
// tab: it unpins, and the project stays in Cockpit (Projects menu). Pinned tabs drag to reorder, or
// move with ⌥⇧←/→; right-click or Shift+F10 opens the tab's menu.

interface ProjectTabBarProps {
  projects: Projects
  onImported?: (meta: ThreadMeta) => void
}

interface TabProps {
  project: Project
  active: boolean
  projects: Projects
  hint?: string
  /** Closing would leave nothing to show (the only tab): no ×. */
  closable: boolean
  drag?: ReturnType<TabDrag['handlers']>
  dropMark?: 'before' | 'after'
  dragging: boolean
  setRef: (el: HTMLDivElement | null) => void
  onClose: () => void
  onMenu: (at: { x: number; y: number }) => void
  onMove: (step: -1 | 1) => void
}

function Tab({ project, active, projects, hint, closable, drag, dropMark, dragging, setRef, onClose, onMenu, onMove }: TabProps) {
  const { working, needsYou } = projects.countsFor(project.path)
  const onKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      event.preventDefault()
      const box = event.currentTarget.getBoundingClientRect()
      onMenu({ x: box.left, y: box.bottom + 4 })
    } else if (event.altKey && event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault()
      onMove(event.key === 'ArrowLeft' ? -1 : 1)
    }
  }
  const onContext = (event: MouseEvent): void => {
    event.preventDefault()
    onMenu({ x: event.clientX, y: event.clientY })
  }
  const classes = ['tab', `tint-${project.color}`, active ? 'active' : '', dragging ? 'dragging' : '', dropMark ? `drop-${dropMark}` : ''].filter(Boolean).join(' ')
  return (
    <div ref={setRef} className={classes} role="presentation" data-path={project.path} onContextMenu={onContext} {...drag}>
      <button
        type="button"
        role="tab"
        aria-selected={active}
        className="tab-main"
        title={hint ? `${project.path}  (${hint})` : project.path}
        onClick={() => projects.select(project.path)}
        onKeyDown={onKey}
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
      {closable ? (
        <button type="button" className="tab-close" aria-label={`Close ${project.name}`} title="Close tab (stays in Projects)" onClick={onClose}>
          <CloseIcon />
        </button>
      ) : null}
    </div>
  )
}

export function ProjectTabBar({ projects, onImported }: ProjectTabBarProps) {
  const boxes = useRef(new Map<string, HTMLDivElement>())
  const [menu, setMenu] = useState<{ path: string; at: { x: number; y: number } }>()
  const [settingsFor, setSettingsFor] = useState<string>()
  const tabs = projects.tabs
  const pinned = tabs.filter((p) => p.pinned).map((p) => p.path)
  const drag = useTabDrag(pinned, (path) => boxes.current.get(path)?.getBoundingClientRect(), (paths) => void projects.reorder(paths))

  const close = async (project: Project): Promise<void> => {
    if (project.path === projects.active?.path) {
      const next = nextAfterClose(tabs, project.path)
      if (next) projects.select(next.path)
    }
    if (project.pinned) await projects.togglePin(project)
  }
  const move = (project: Project, step: -1 | 1): void => {
    const from = pinned.indexOf(project.path)
    const to = from + step
    if (from < 0 || to < 0 || to >= pinned.length) return
    void projects.reorder(moveTab(pinned, from, to)).then(() => boxes.current.get(project.path)?.querySelector<HTMLElement>('.tab-main')?.focus())
  }
  const dismiss = useCallback(() => setMenu(undefined), [])

  // Where the dragged tab would land, drawn as a line on the neighbouring tab.
  const others = drag.dragging ? pinned.filter((p) => p !== drag.dragging!.path) : []
  const dropMark = (path: string): 'before' | 'after' | undefined => {
    if (!drag.dragging) return undefined
    const to = drag.dragging.to
    if (others[to] === path) return 'before'
    return to === others.length && others[others.length - 1] === path ? 'after' : undefined
  }

  const menuProject = menu ? projects.all.find((p) => p.path === menu.path) : undefined
  const settingsProject = settingsFor ? projects.all.find((p) => p.path === settingsFor) : undefined
  return (
    <header className="tabbar">
      <Mark className="tabbar-mark" />
      <div className="tabs" role="tablist" aria-label="Projects">
        {tabs.map((project, index) => (
          <Tab key={project.path} project={project} active={project.path === projects.active?.path} projects={projects}
            hint={projectHint(index, tabs.length)} closable={tabs.length > 1 || project.path !== projects.active?.path}
            {...(project.pinned ? { drag: drag.handlers(project.path) } : {})}
            {...(dropMark(project.path) ? { dropMark: dropMark(project.path)! } : {})}
            dragging={drag.dragging?.path === project.path}
            setRef={(el) => { if (el) boxes.current.set(project.path, el); else boxes.current.delete(project.path) }}
            onClose={() => void close(project)} onMenu={(at) => setMenu({ path: project.path, at })} onMove={(step) => move(project, step)} />
        ))}
      </div>
      <div className="tabbar-spacer" />
      <ProjectsMenu projects={projects} onImported={onImported} />
      <div className="tabbar-overlays">
      {menu && menuProject ? (
        <TabMenu project={menuProject} at={menu.at} onDismiss={dismiss}
          onColor={(color) => { dismiss(); void projects.setColor(menuProject, color) }}
          onTogglePin={() => { dismiss(); void projects.togglePin(menuProject) }}
          onCloseTab={() => { dismiss(); void close(menuProject) }}
          onSettings={() => { dismiss(); setSettingsFor(menuProject.path) }}
          onRemove={async () => {
            try { await projects.remove(menuProject); dismiss() }
            catch (e: unknown) { projects.reportError(e instanceof Error ? e.message : String(e)) }
          }} />
      ) : null}
      {settingsProject ? (
        <ProjectSettings key={settingsProject.path} project={settingsProject} onSave={(patch) => projects.saveSettings(settingsProject, patch)}
          onImage={(image) => projects.setImage(settingsProject, image)} onRemove={() => projects.remove(settingsProject)} onClose={() => setSettingsFor(undefined)} />
      ) : null}
      </div>
    </header>
  )
}
