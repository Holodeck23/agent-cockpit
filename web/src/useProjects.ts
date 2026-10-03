import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type Project, type ThreadSummary } from './api.ts'
import { needsYou } from './conversation-meta.ts'
import { tabOrder } from './project-tabs.ts'

const ACTIVE_KEY = 'cockpit:active-project'

export interface ProjectCounts {
  readonly working: number
  readonly needsYou: number
}

export interface Projects {
  /** Every known project, most recently opened first (the Projects menu). */
  refresh(): Promise<void>
  readonly all: Project[]
  /** Pinned projects in the order they were pinned, then the active one if unpinned (the tab bar). */
  readonly tabs: Project[]
  readonly active: Project | undefined
  countsFor(path: string): ProjectCounts
  select(path: string): void
  /** Registers (or reopens) a folder, pins it and makes it active. */
  open(path: string): Promise<void>
  togglePin(project: Project): Promise<void>
  /** Saves a project's instructions; rejects with the server's message so the editor can show it. */
  saveInstructions(project: Project, instructions: string): Promise<Project>
  /** Saves name, tint and instructions together; rejects with the server's message. */
  saveSettings(project: Project, patch: { name: string; color: Project['color']; instructions: string }): Promise<Project>
  /** Sets (a data: URL) or clears (null) the project's picture. */
  setImage(project: Project, image: string | null): Promise<Project>
  /** Takes the project off the tabs and the menu; the folder is never touched. Resolves to the schedules paused. */
  remove(project: Project): Promise<number>
}

function loadActive(): string | undefined {
  try {
    return localStorage.getItem(ACTIVE_KEY) ?? undefined
  } catch {
    return undefined
  }
}

export function useProjects(threads: readonly ThreadSummary[], onError: (message: string) => void): Projects {
  const [all, setAll] = useState<Project[]>([])
  const [activePath, setActivePath] = useState<string | undefined>(loadActive)
  const projectPaths = useMemo(() => [...new Set(threads.map((t) => t.meta.projectPath))].sort().join('\n'), [threads])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setAll(await api.listProjects())
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }, [onError])

  // A thread in a new folder registers that folder server-side, so reload when the set changes.
  useEffect(() => {
    void refresh()
  }, [refresh, projectPaths])

  const select = useCallback((path: string): void => {
    setActivePath(path)
    try {
      localStorage.setItem(ACTIVE_KEY, path)
    } catch {
      // not persisted
    }
  }, [])

  const active = all.find((p) => p.path === activePath) ?? all[0]
  const tabs = tabOrder(all, active?.path)

  const counts = useMemo(() => {
    const byPath = new Map<string, ProjectCounts>()
    for (const t of threads) {
      const current = byPath.get(t.meta.projectPath) ?? { working: 0, needsYou: 0 }
      byPath.set(t.meta.projectPath, {
        working: current.working + (t.status === 'working' ? 1 : 0),
        needsYou: current.needsYou + (needsYou(t) ? 1 : 0),
      })
    }
    return byPath
  }, [threads])

  const open = async (path: string): Promise<void> => {
    try {
      const project = await api.openProject(path, { pinned: true })
      await refresh()
      select(project.path)
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  const togglePin = async (project: Project): Promise<void> => {
    try {
      await api.openProject(project.path, { pinned: !project.pinned })
      await refresh()
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  const saveInstructions = async (project: Project, instructions: string): Promise<Project> => {
    const saved = await api.openProject(project.path, { instructions })
    await refresh()
    return saved
  }

  const saveSettings = async (project: Project, patch: { name: string; color: Project['color']; instructions: string }): Promise<Project> => {
    const saved = await api.openProject(project.path, patch)
    await refresh()
    return saved
  }

  const setImage = async (project: Project, image: string | null): Promise<Project> => {
    const saved = await api.setProjectImage(project.path, image)
    await refresh()
    return saved
  }

  const remove = async (project: Project): Promise<number> => {
    const { pausedSchedules } = await api.removeProject(project.path)
    const next = all.find((p) => p.path !== project.path)
    if (next) select(next.path)
    await refresh()
    return pausedSchedules
  }

  return {
    refresh,
    all,
    tabs,
    active,
    countsFor: (path) => counts.get(path) ?? { working: 0, needsYou: 0 },
    select,
    open,
    togglePin,
    saveInstructions,
    saveSettings,
    setImage,
    remove,
  }
}
