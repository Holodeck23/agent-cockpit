import { realpathSync } from 'node:fs'
import { isInside } from './libraries.ts'
import { mapProjects, type ProjectMap } from './map.ts'
import type { Navigation } from './navigation.ts'

// Mac only (projects-area Move 9): a library, an area or one project the person keeps off the phone.
// One predicate answers "is this folder Mac only?" for every place something could leave the Mac:
// the phone's lists and conversation routes, its live stream, push notifications, memories saved
// "everywhere", and crash reports (which replace each private folder with <private>).

/** The folders whose contents are Mac only: private libraries, private areas' folders, private projects. Unique, longest first. */
export function privateRoots(map: ProjectMap): string[] {
  const roots = [
    ...map.libraries.filter((l) => l.private).map((l) => l.root),
    // An area's own folder; never a whole library (the Loose area's folder is the library root).
    ...map.areas.filter((a) => a.private && a.root && !map.libraries.some((l) => l.root === a.root)).map((a) => a.root!),
    ...mapProjects(map).filter((p) => p.private).flatMap((p) => (p.openPath !== p.path ? [p.path, p.openPath] : [p.path])),
  ]
  return [...new Set(roots)].sort((a, b) => b.length - a.length)
}

/** What navigation.json alone says is private, without scanning (crash reports before the server is up). */
export function privateRootsOf(navigation: Navigation): string[] {
  return [...new Set([...navigation.libraries.filter((l) => l.private).map((l) => l.root), ...navigation.privateProjects])]
}

export interface Privacy {
  /** True when the folder is, or lies inside, a Mac-only library, area or project. */
  macOnly(path: string): boolean
  roots(): readonly string[]
}

export function createPrivacy(roots: () => readonly string[], realpath: (path: string) => string = realpathSync): Privacy {
  const resolved = new Map<string, string>()
  const real = (path: string): string => {
    const hit = resolved.get(path)
    if (hit !== undefined) return hit
    let value = path
    try { value = realpath(path) } catch { /* a folder that is gone: compare as written */ }
    if (resolved.size > 5_000) resolved.clear()
    resolved.set(path, value)
    return value
  }
  return {
    roots,
    macOnly(path) {
      if (!path) return false
      const list = roots()
      if (list.length === 0) return false
      const target = real(path)
      return list.some((root) => isInside(target, root) || isInside(path, root))
    },
  }
}

/**
 * Replaces each private folder in `text` with <private>; longest roots first, so a nested one is never
 * half-replaced. Only whole folders: "/a/b" is replaced in "/a/b/c" but not in "/a/bc".
 */
export function scrubPrivate(text: string, roots: readonly string[]): string {
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...roots].filter((r) => r.length > 1).sort((a, b) => b.length - a.length)
    .reduce((out, root) => out.replace(new RegExp(`${escape(root)}(?=[/\\s"'\`)\\]},:;]|$)`, 'g'), '<private>'), text)
}
