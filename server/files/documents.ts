import { createHash } from 'node:crypto'
import { writeFileAtomic } from './atomic.ts'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { z } from 'zod'
import { contained, explained, HIDDEN } from './browser.ts'
import { copyInto } from './copy-in.ts'

// "Your documents": notes and drafts Cockpit keeps per project in its own folder
// (<root>/documents/<id>/), never in the repository. The same read and save rules as project
// files apply; on top, a document can be pinned (listed first) or archived (listed only in
// the Archived view). Those marks live beside the folder in <root>/documents/<id>.json.

export type Space = 'project' | 'documents'
export const spaceSchema = z.enum(['project', 'documents']).default('project')

const idOf = (projectPath: string): string => createHash('sha256').update(projectPath).digest('hex').slice(0, 16)

const defaultDir = (root: string, projectPath: string): string => join(root, 'documents', idOf(projectPath))
// A project can keep its documents in a folder of its own choosing (F14). The choice is a
// one-line pointer beside the default folder; without it, Cockpit's own folder is used.
const pointerFile = (root: string, projectPath: string): string => join(root, 'documents', `${idOf(projectPath)}.location`)

function chosenFolder(root: string, projectPath: string): string | undefined {
  try {
    const folder = readFileSync(pointerFile(root, projectPath), 'utf8').trim()
    return isAbsolute(folder) && statSync(folder).isDirectory() ? folder : undefined
  } catch {
    return undefined
  }
}

/** The project's documents folder: the one chosen for it, or Cockpit's own (created on first use). */
export function documentsDir(root: string, projectPath: string): string {
  const chosen = chosenFolder(root, projectPath)
  if (chosen) return chosen
  const dir = defaultDir(root, projectPath)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** Where the documents live now, and whether that is a folder the user chose. */
export function documentsFolder(root: string, projectPath: string): { folder: string; custom: boolean } {
  const chosen = chosenFolder(root, projectPath)
  return chosen ? { folder: chosen, custom: true } : { folder: documentsDir(root, projectPath), custom: false }
}

/**
 * Keeps this project's documents in `folder` from now on (null: back to Cockpit's own folder).
 * The documents are copied there, never over a file there; the previous folder is left as it was.
 * If any document cannot be copied, nothing changes and the error names those files.
 */
export function setDocumentsFolder(root: string, projectPath: string, folder: string | null): { folder: string; copied: string[] } {
  if (folder !== null) {
    if (!isAbsolute(folder)) throw new Error('Choose a folder by its full path')
    if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Not a folder: ${folder}`)
    const inside = relative(realpathSync(projectPath), realpathSync(folder))
    if (!inside.startsWith('..') && !isAbsolute(inside)) throw new Error('Choose a folder outside the project, so agents and git do not see your documents')
  }
  const from = documentsDir(root, projectPath)
  const to = folder ?? defaultDir(root, projectPath)
  mkdirSync(to, { recursive: true, mode: 0o700 })
  const sources = readdirSync(from, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.') && !HIDDEN.has(e.name)).map((e) => join(from, e.name))
  const { copied, skipped } = realpathSync(from) === realpathSync(to) ? { copied: [], skipped: [] } : copyInto(to, '', sources)
  // A folder that would not take every document is not where they live: stay put and say why.
  // The documents are all still in the current folder; copies that did land are left as they are.
  if (skipped.length > 0) {
    throw new Error(`Not moved: ${to} would not take ${skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}. Your documents stay where they are.`)
  }
  if (folder === null) rmSync(pointerFile(root, projectPath), { force: true })
  else writeFileSync(pointerFile(root, projectPath), `${folder}\n`, { mode: 0o600 })
  return { folder: to, copied }
}

/** The folder a file path is relative to, for either space. */
export const spaceRoot = (root: string, projectPath: string, space: Space): string =>
  space === 'documents' ? documentsDir(root, projectPath) : projectPath

const marksSchema = z.object({ pinned: z.array(z.string()).default([]), archived: z.array(z.string()).default([]) })
type Marks = z.output<typeof marksSchema>
const marksFile = (root: string, projectPath: string): string => join(root, 'documents', `${idOf(projectPath)}.json`)

function readMarks(root: string, projectPath: string): Marks {
  try {
    const file = marksFile(root, projectPath)
    return existsSync(file) ? marksSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) : marksSchema.parse({})
  } catch {
    return marksSchema.parse({})
  }
}
function writeMarks(root: string, projectPath: string, marks: Marks): void {
  const file = marksFile(root, projectPath)
  writeFileAtomic(file, JSON.stringify(marks, null, 2))
}

export interface DocumentEntry { name: string; path: string; pinned: boolean; archived: boolean; modifiedAt: string }

/** Files at the top of the documents folder: pinned first, then newest. Marks for vanished files are dropped. */
export function listDocuments(root: string, projectPath: string): DocumentEntry[] {
  const dir = documentsDir(root, projectPath)
  const files = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith('.') && !HIDDEN.has(e.name))
  const names = new Set(files.map((e) => e.name))
  const marks = readMarks(root, projectPath)
  const kept = { pinned: marks.pinned.filter((n) => names.has(n)), archived: marks.archived.filter((n) => names.has(n)) }
  if (kept.pinned.length !== marks.pinned.length || kept.archived.length !== marks.archived.length) writeMarks(root, projectPath, kept)
  return files
    .map((e) => ({ name: e.name, path: e.name, pinned: kept.pinned.includes(e.name), archived: kept.archived.includes(e.name),
      modifiedAt: statSync(join(dir, e.name)).mtime.toISOString() }))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name))
}

export interface DocumentMatch extends DocumentEntry { readonly excerpt?: string }

const MAX_SEARCH_BYTES = 100 * 1024

/**
 * Current and archived documents whose name or text holds every word of `query`, case-insensitive.
 * A text match carries the first line with a matching word. Binary and oversized files match by name only.
 */
export function searchDocuments(root: string, projectPath: string, query: string): DocumentMatch[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const dir = documentsDir(root, projectPath)
  const found: DocumentMatch[] = []
  for (const doc of listDocuments(root, projectPath)) {
    let text = ''
    try {
      const file = join(dir, doc.path)
      if (statSync(file).size <= MAX_SEARCH_BYTES) {
        const raw = readFileSync(file, 'utf8')
        if (!raw.includes('\0')) text = raw
      }
    } catch { /* unreadable: name only */ }
    const haystack = `${doc.name.toLowerCase()}\n${text.toLowerCase()}`
    if (!words.every((w) => haystack.includes(w))) continue
    const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => words.some((w) => l.toLowerCase().includes(w)))
    found.push(line ? { ...doc, excerpt: line.length > 160 ? `${line.slice(0, 160)}…` : line } : doc)
  }
  return found
}

/** Pins or archives a document; archiving also unpins it. */
export function markDocument(root: string, projectPath: string, name: string, change: { pinned?: boolean; archived?: boolean }): void {
  if (!existsSync(join(documentsDir(root, projectPath), name)) || name.includes('/')) throw new Error(`Not found in your documents: ${name}`)
  const marks = readMarks(root, projectPath)
  const toggle = (list: string[], on: boolean | undefined): string[] => on === undefined ? list : on ? [...new Set([...list, name])] : list.filter((n) => n !== name)
  const archived = toggle(marks.archived, change.archived)
  const pinned = toggle(marks.pinned, change.archived ? false : change.pinned)
  writeMarks(root, projectPath, { pinned, archived })
}

/**
 * Renames a file in its own folder; never replaces another file, never moves it elsewhere.
 * Returns the new relative path. Pin and archive marks follow a renamed document.
 */
export function renameFile(root: string, projectPath: string, space: Space, path: string, name: string): string {
  const trimmed = name.trim()
  if (!trimmed || trimmed.startsWith('.') || /[/\\]/.test(trimmed) || HIDDEN.has(trimmed)) throw new Error('Use a plain file name, without folders or a leading dot')
  const base = spaceRoot(root, projectPath, space)
  return explained(path, `Not found: ${path}`, () => {
    const { root: real, target } = contained(base, path)
    if (!statSync(target).isFile()) throw new Error('Only files can be renamed here')
    const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
    const next = join(real, folder, trimmed)
    if (existsSync(next)) throw new Error(`${trimmed} already exists`)
    renameSync(target, next)
    if (space === 'documents') {
      const marks = readMarks(root, projectPath)
      const swap = (list: string[]): string[] => list.map((n) => (n === path ? trimmed : n))
      writeMarks(root, projectPath, { pinned: swap(marks.pinned), archived: swap(marks.archived) })
    }
    return `${folder}${trimmed}`
  })
}

/** The absolute path of an existing file in either space, for opening or trashing it from the desktop shell. */
export function fileOnDisk(root: string, projectPath: string, space: Space, path: string): string {
  const { target } = contained(spaceRoot(root, projectPath, space), path)
  if (!statSync(target).isFile()) throw new Error('Not a file')
  return target
}
