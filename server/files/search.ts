import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { contained, explained, HIDDEN, readProjectFile } from './browser.ts'
import { FILE_REFERENCE, parseFileReference, WORKFLOW_REFERENCE } from './references.ts'
import type { WorkflowStore } from '../workflows/store.ts'

// Finding files for the composer's context picker, and checking a draft's references
// before it is sent. Both follow the Files panel's rules: inside the project, no
// symbolic links, no generated or dependency folders.

const MAX_VISITED = 20_000
const MAX_DEPTH = 12
const MAX_RESULTS = 30

export interface FileMatch { path: string; name: string }
export interface FileSearch { matches: FileMatch[]; truncated: boolean }

/** Files whose path contains every word of the query; names that match rank first. */
export function searchFiles(projectPath: string, query: string): FileSearch {
  return explained('the project folder', 'Project folder is unavailable', () => {
    const { root } = contained(projectPath, '')
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const found: Array<FileMatch & { rank: number }> = []
    let visited = 0
    let truncated = false
    const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
    while (queue.length > 0) {
      const { dir, depth } = queue.shift()!
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        if (++visited > MAX_VISITED) { truncated = true; queue.length = 0; break }
        if (HIDDEN.has(entry.name) || entry.isSymbolicLink()) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) { if (depth < MAX_DEPTH) queue.push({ dir: full, depth: depth + 1 }); else truncated = true; continue }
        if (!entry.isFile()) continue
        const path = relative(root, full)
        const lower = path.toLowerCase()
        if (!words.every((w) => lower.includes(w))) continue
        const name = entry.name.toLowerCase()
        const rank = (words.every((w) => name.includes(w)) ? 0 : 1000) + path.length
        found.push({ path, name: entry.name, rank })
      }
    }
    found.sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path))
    return { matches: found.slice(0, MAX_RESULTS).map(({ path, name }) => ({ path, name })), truncated: truncated || found.length > MAX_RESULTS }
  })
}

export interface ReferenceCheck { kind: 'file' | 'workflow'; reference: string; ok: boolean; problem?: string }

/** Each distinct reference in a draft, and whether it would resolve if sent now. */
/** `folder` is where @file references resolve (a worktree's own folder); workflows are the project's. */
export function checkReferences(text: string, projectPath: string, workflows: WorkflowStore, folder: string = projectPath): ReferenceCheck[] {
  const checks: ReferenceCheck[] = []
  const seen = new Set<string>()
  for (const [, , encoded] of text.matchAll(FILE_REFERENCE)) {
    if (!encoded || seen.has(`file:${encoded}`)) continue
    seen.add(`file:${encoded}`)
    const path = parseFileReference(encoded)?.path
    if (path === undefined) { checks.push({ kind: 'file', reference: encoded, ok: false, problem: 'Not a valid file reference' }); continue }
    try { readProjectFile(folder, path); checks.push({ kind: 'file', reference: encoded, ok: true }) }
    catch (error) { checks.push({ kind: 'file', reference: encoded, ok: false, problem: error instanceof Error ? error.message : String(error) }) }
  }
  const names = new Set(workflows.list(projectPath).map((w) => w.name))
  for (const [, , name] of text.matchAll(WORKFLOW_REFERENCE)) {
    if (!name || seen.has(`workflow:${name}`)) continue
    seen.add(`workflow:${name}`)
    checks.push(names.has(name) ? { kind: 'workflow', reference: name, ok: true } : { kind: 'workflow', reference: name, ok: false, problem: `Unknown workflow in this project: ${name}` })
  }
  return checks
}
