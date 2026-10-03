// Pure helpers for editing text files in the Files panel. No React, so they're unit-tested.

export type LineEnding = '\n' | '\r\n'

/** One open file: what is on disk (and its version) plus the draft in the editor. */
export interface OpenFile {
  readonly path: string
  /** Text on disk when opened or last saved, exactly as read. */
  readonly text: string
  readonly version: string
  /** Editor text: always \n line endings, the way a textarea holds it. */
  readonly draft: string
  /** Undefined when the file mixes line endings; it then stays read-only. */
  readonly eol: LineEnding | undefined
  /** The file changed on disk since it was opened; saving needs a decision. */
  readonly conflict: boolean
}

/** The file's line ending, or undefined when it mixes them. */
export function lineEndingOf(text: string): LineEnding | undefined {
  const crlf = text.split('\r\n').length - 1
  const cr = text.split('\r').length - 1
  const lf = text.split('\n').length - 1
  if (cr !== crlf) return undefined
  if (crlf === 0) return '\n'
  return crlf === lf ? '\r\n' : undefined
}

export const forEditor = (text: string): string => text.replace(/\r\n/g, '\n')

/** A textarea only holds \n; this puts the file's own line ending back before saving. */
export const forDisk = (draft: string, eol: LineEnding): string => (eol === '\n' ? draft : draft.replace(/\n/g, '\r\n'))

export const isDirty = (file: OpenFile): boolean => file.draft !== forEditor(file.text)

export function openFile(path: string, text: string, version: string, draft?: string): OpenFile {
  return { path, text, version, draft: draft ?? forEditor(text), eol: lineEndingOf(text), conflict: false }
}

/** A file name typed into "New file", joined to the folder being shown; undefined if it is not a plain visible name. */
export function newFilePath(folder: string, name: string): string | undefined {
  const trimmed = name.trim()
  if (!trimmed || trimmed.startsWith('.') || /[/\\]/.test(trimmed)) return undefined
  return folder ? `${folder}/${trimmed}` : trimmed
}

/** "notes.md" → "notes (copy).md", then "notes (copy 2).md"…; the extension stays last. */
export function copyPath(path: string, attempt: number): string {
  const slash = path.lastIndexOf('/')
  const folder = path.slice(0, slash + 1)
  const name = path.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  return `${folder}${stem} (copy${attempt > 1 ? ` ${attempt}` : ''})${ext}`
}

export const draftKey = (projectPath: string, path: string): string => `file-draft:${projectPath}:${path}`
export const tabsKey = (projectPath: string): string => `cockpit:file-tabs:${projectPath}`

/**
 * Open tabs name a document from "Your documents" as "documents:<name>"; project files keep
 * their plain relative path. The API helpers split this back into a space and a path.
 */
export const DOCUMENTS_PREFIX = 'documents:'
export type FileSpace = 'project' | 'documents'
export function spaceOf(path: string): { space: FileSpace; path: string } {
  return path.startsWith(DOCUMENTS_PREFIX) ? { space: 'documents', path: path.slice(DOCUMENTS_PREFIX.length) } : { space: 'project', path }
}
export const inSpace = (space: FileSpace, path: string): string => (space === 'documents' ? `${DOCUMENTS_PREFIX}${path}` : path)

/** The file name a tab shows: no folders, no space prefix. */
export const fileName = (path: string): string => spaceOf(path).path.split('/').pop() ?? path

/** Words as a reader counts them: runs of letters or digits, apostrophes and hyphens inside a word. */
export function wordCount(text: string): number {
  return text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0
}

export const lineCount = (text: string): number => text.split('\n').length

/** New file kinds and their extensions; "other" takes the name as typed. */
export const NEW_FILE_KINDS = [
  { id: 'markdown', label: 'Markdown', ext: '.md', starter: '' },
  { id: 'json', label: 'JSON', ext: '.json', starter: '{\n}\n' },
  { id: 'text', label: 'Plain text', ext: '.txt', starter: '' },
  { id: 'other', label: 'Other…', ext: '', starter: '' },
] as const
export type NewFileKind = (typeof NEW_FILE_KINDS)[number]['id']

/** "notes" as Markdown → "notes.md"; a name that already ends in the extension is left alone. */
export function withExtension(name: string, kind: NewFileKind): string {
  const ext = NEW_FILE_KINDS.find((k) => k.id === kind)?.ext ?? ''
  const trimmed = name.trim()
  return !ext || trimmed.toLowerCase().endsWith(ext) ? trimmed : `${trimmed}${ext}`
}

/** Character offsets covering lines `line`…`endLine` (1-based), clamped to the text. */
export function lineRange(text: string, line: number, endLine: number = line): { start: number; end: number } {
  const lines = text.split('\n')
  const from = Math.min(Math.max(line, 1), lines.length)
  const to = Math.min(Math.max(endLine, from), lines.length)
  let start = 0
  for (let i = 1; i < from; i += 1) start += lines[i - 1]!.length + 1
  let end = start
  for (let i = from; i <= to; i += 1) end += lines[i - 1]!.length + (i < to ? 1 : 0)
  return { start, end }
}
