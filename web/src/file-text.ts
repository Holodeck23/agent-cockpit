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
