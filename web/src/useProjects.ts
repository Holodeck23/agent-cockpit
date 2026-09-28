import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type Project, type ThreadSummary } from './api.ts'

const ACTIVE_KEY = 'cockpit:active-project'

export interface ProjectCounts {
  readonly working: number
  readonly needsYou: number
}

export interface Projects {
  /** Every known project, most recently opened first (the Projects menu). */
  readonly all: Project[]
  /** Pinned projects plus the active one, in a stable order (the tab bar). */
  readonly tabs: Project[]
  readonly active: Project | undefined
  countsFor(path: string): ProjectCounts
  select(path: string): void
  /** Registers (or reopens) a folder, pins it and makes it active. */
  open(path: string): Promise<void>
  togglePin(project: Project): Promise<void>
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
  const tabs = all
    .filter((p) => p.pinned || p.path === active?.path)
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))

  const counts = useMemo(() => {
    const byPath = new Map<string, ProjectCounts>()
    for (const t of threads) {
      const current = byPath.get(t.meta.projectPath) ?? { working: 0, needsYou: 0 }
      byPath.set(t.meta.projectPath, {
        working: current.working + (t.status === 'working' ? 1 : 0),
        needsYou: current.needsYou + (t.status === 'needs_input' ? 1 : 0),
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

  return {
    all,
    tabs,
    active,
    countsFor: (path) => counts.get(path) ?? { working: 0, needsYou: 0 },
    select,
    open,
    togglePin,
  }
}
