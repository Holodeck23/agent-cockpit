import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { Project, ThreadMeta } from '../api.ts'
import type { Projects } from '../useProjects.ts'
import { Bars, ChatIcon, CloseIcon, Mark, MoreIcon, PinIcon } from './icons.tsx'
import { ProjectAvatar } from './ProjectAvatar.tsx'
import { ProjectSettings } from './ProjectSettings.tsx'
import { ProjectsMenu } from './ProjectsMenu.tsx'
import { projectHint } from '../shortcuts.ts'
import { usePopover } from '../usePopover.ts'

interface ProjectTabBarProps {
  projects: Projects
  onImported?: (meta: ThreadMeta) => void
}
const TINTS: readonly Project['color'][] = ['blue', 'pink', 'orange', 'green', 'purple', 'gray']
const DRAG_TYPE = 'application/x-cockpit-project-tab'
type Drop = { path: string; after: boolean }

function Tab({ project, active, projects, hint, busy, run, onSettings, onDragStart, onDragEnd, onDragOver, onDrop, drop }: {
  project: Project; active: boolean; projects: Projects; hint?: string; busy: boolean
  run: (action: () => Promise<unknown>) => void; onSettings: () => void
  onDragStart: (event: DragEvent) => void; onDragEnd: () => void
  onDragOver: (event: DragEvent) => void; onDrop: (event: DragEvent) => void; drop?: Drop
}) {
  const { working, needsYou } = projects.countsFor(project.path)
  const more = useRef<HTMLButtonElement>(null)
  const menu = usePopover<HTMLDivElement>({ onEscape: () => more.current?.focus() })
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const menuRef = useRef<HTMLDivElement>(null)
  const index = projects.tabs.findIndex((p) => p.path === project.path)
  const showMenu = (): void => {
    const rect = menu.ref.current?.getBoundingClientRect()
    if (rect) setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 248)), top: rect.bottom + 6 })
    menu.setOpen(true)
  }
  useEffect(() => { if (menu.open) menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus() }, [menu.open])
  // A resize or scroll can move the anchor. Close rather than leave a detached menu floating over another tab.
  useEffect(() => {
    if (!menu.open) return
    const close = (): void => menu.setOpen(false)
    window.addEventListener('resize', close)
    document.addEventListener('scroll', close, true)
    return () => { window.removeEventListener('resize', close); document.removeEventListener('scroll', close, true) }
  }, [menu.open])
  const action = (fn: () => Promise<unknown>): void => { menu.setOpen(false); more.current?.focus(); run(fn) }
  const move = (direction: -1 | 1): void => action(() => projects.moveTab(project,
    projects.tabs[index + direction]!.path, direction > 0))
  return (
    <div ref={menu.ref} className={`tab tint-${project.color}${active ? ' active' : ''}${drop?.path === project.path ? drop.after ? ' drop-after' : ' drop-before' : ''}`} role="presentation"
      onContextMenu={(event) => { event.preventDefault(); if (!busy) showMenu() }}
      onKeyDown={(event) => {
        if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') { event.preventDefault(); if (!busy) showMenu() }
      }} onDragOver={onDragOver} onDrop={onDrop}>
      <button type="button" role="tab" aria-selected={active} className="tab-main" draggable={!busy}
        title={`${project.path}\nDrag to reorder · Right-click for project controls${hint ? `  (${hint})` : ''}`}
        onClick={() => projects.select(project.path)} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <ProjectAvatar project={project} solid={active} />
        <span className="tab-name">{project.name}</span>
        {working > 0 ? <span className="tab-badge" aria-label={`${working} working`}><Bars live />{working}</span> : null}
        {needsYou > 0 ? <span className="tab-needs" aria-label={`${needsYou} need you`}><ChatIcon /><span className="count-dot">{needsYou}</span></span> : null}
      </button>
      <button ref={more} type="button" className="tab-control" aria-label={`Project controls for ${project.name}`} title="Project controls"
        aria-haspopup="menu" aria-expanded={menu.open} disabled={busy} onClick={() => menu.open ? menu.setOpen(false) : showMenu()}><MoreIcon /></button>
      <button type="button" className="tab-control tab-close" aria-label={`Close ${project.name} tab`} title="Close tab · project stays in Projects"
        disabled={busy} onClick={() => run(() => projects.closeTab(project))}><CloseIcon /></button>
      {menu.open ? <div ref={menuRef} className="menu tab-menu" role="menu" aria-label={`${project.name} controls`} style={position}
        onContextMenu={(event) => event.stopPropagation()} onKeyDown={(event) => {
          event.stopPropagation()
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape'].includes(event.key)) return
          event.preventDefault()
          if (event.key === 'Escape') { menu.setOpen(false); more.current?.focus(); return }
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
          const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : (at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
          buttons[next]?.focus()
        }}>
        <p className="menu-label">Project colour</p>
        <div className="tab-colours" role="group" aria-label="Project colour">
          {TINTS.map((color) => <button key={color} type="button" role="menuitemradio" aria-checked={project.color === color}
            aria-label={`Set ${project.name} colour to ${color}`} title={color[0]!.toUpperCase() + color.slice(1)}
            className={`tint-swatch avatar-${color}`} onClick={() => action(() => projects.setColor(project, color))} />)}
        </div>
        <button type="button" role="menuitem" className="menu-item" onClick={() => { menu.setOpen(false); onSettings() }}>Project settings…</button>
        <button type="button" role="menuitem" className="menu-item" disabled={index === 0} onClick={() => move(-1)}>Move left</button>
        <button type="button" role="menuitem" className="menu-item" disabled={index === projects.tabs.length - 1} onClick={() => move(1)}>Move right</button>
        <button type="button" role="menuitem" className="menu-item" onClick={() => action(() => projects.togglePin(project))}>
          <PinIcon />{project.pinned ? 'Unpin project' : 'Pin project'}</button>
        <button type="button" role="menuitem" className="menu-item" onClick={() => action(() => projects.closeTab(project))}><CloseIcon />Close tab</button>
      </div> : null}
    </div>
  )
}

export function ProjectTabBar({ projects, onImported }: ProjectTabBarProps) {
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const dragging = useRef<string | undefined>(undefined)
  const [drop, setDrop] = useState<Drop>()
  const [settingsPath, setSettingsPath] = useState<string>()
  const settings = projects.all.find((p) => p.path === settingsPath)
  const run = (action: () => Promise<unknown>): void => {
    if (pending.current) return
    pending.current = true; setBusy(true)
    void action().catch((error: unknown) => projects.reportError(error instanceof Error ? error.message : String(error)))
      .finally(() => { pending.current = false; setBusy(false) })
  }
  const endDrag = (): void => { dragging.current = undefined; setDrop(undefined) }
  return (
    <>
    <header className="tabbar">
      <Mark className="tabbar-mark" />
      <div className="tabs" role="tablist" aria-label="Projects" onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(undefined)
      }}>
        {projects.tabs.map((project, index) => (
          <Tab key={project.path} project={project} active={project.path === projects.active?.path} projects={projects}
            hint={projectHint(index, projects.tabs.length)} busy={busy} run={run} onSettings={() => setSettingsPath(project.path)} drop={drop}
            onDragStart={(event) => {
              dragging.current = project.path
              event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData(DRAG_TYPE, project.path)
            }} onDragEnd={endDrag} onDragOver={(event) => {
              if (busy || !dragging.current || dragging.current === project.path) return
              event.preventDefault(); event.dataTransfer.dropEffect = 'move'
              const rect = event.currentTarget.getBoundingClientRect()
              setDrop({ path: project.path, after: event.clientX > rect.left + rect.width / 2 })
              const scroller = event.currentTarget.parentElement!
              const bounds = scroller.getBoundingClientRect()
              if (event.clientX > bounds.right - 40) scroller.scrollLeft += 24
              else if (event.clientX < bounds.left + 40) scroller.scrollLeft -= 24
            }} onDrop={(event) => {
              event.preventDefault()
              const source = projects.tabs.find((p) => p.path === dragging.current)
              const rect = event.currentTarget.getBoundingClientRect()
              const after = event.clientX > rect.left + rect.width / 2
              endDrag()
              if (source && source.path !== project.path && !busy) run(() => projects.moveTab(source, project.path, after))
            }} />
        ))}
      </div>
      <div className="tabbar-spacer" />
      <ProjectsMenu projects={projects} onImported={onImported} />
    </header>
      {settings ? <ProjectSettings key={settings.path} project={settings} onSave={(patch) => projects.saveSettings(settings, patch)}
        onImage={(image) => projects.setImage(settings, image)} onRemove={() => projects.remove(settings)} onClose={() => setSettingsPath(undefined)} /> : null}
    </>
  )
}
