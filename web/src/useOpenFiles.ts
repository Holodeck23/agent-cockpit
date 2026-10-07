import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from './api.ts'
import type { SelectionGuard } from './workspaces.ts'
import { copyPath, draftKey, forDisk, inSpace, isDirty, NEW_FILE_KINDS, newFilePath, openFile, spaceOf, tabsKey, withExtension, type FileSpace, type NewFileKind, type OpenFile } from './file-text.ts'

// The Files panel's open files. Drafts and the open tabs live in localStorage per
// project, so leaving the panel, switching project or restarting loses nothing.
// Saves always name the version the edit started from (see server/files/editor.ts).

const storage = {
  get(key: string): string | null {
    try { return localStorage.getItem(key) } catch { return null }
  },
  set(key: string, value: string | undefined): void {
    try {
      if (value === undefined) localStorage.removeItem(key)
      else localStorage.setItem(key, value)
    } catch { /* storage unavailable: nothing persists */ }
  },
}

interface StoredDraft { draft: string; version: string }
interface StoredTabs { paths: string[]; active?: string }

function parse<T>(raw: string | null): T | undefined {
  try { return raw ? (JSON.parse(raw) as T) : undefined } catch { return undefined }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * `scope` is a worktree's workspace ID (absent: the main checkout). Tabs and drafts are kept per
 * workspace, the main checkout's under exactly the keys they always had. `guard` drops an answer
 * that arrives after the person chose another workspace.
 */
export function useOpenFiles(projectPath: string | undefined, scope?: string, guard?: SelectionGuard) {
  const tabsFor = projectPath && scope ? `${projectPath}@${scope}` : projectPath
  // Your documents belong to the project, not to a workspace: their drafts keep the project's key.
  const draftFor = (path: string): string | undefined => (spaceOf(path).space === 'documents' ? projectPath : tabsFor)
  const [files, setFiles] = useState<readonly OpenFile[]>([])
  const [active, setActive] = useState<string>()
  const [error, setError] = useState('')
  const current = useRef(files)
  current.current = files
  const restored = useRef(false)
  // A file opened on purpose (a click, a reply's link) while last visit's tabs are still being
  // restored keeps the focus; the restore only adds tabs behind it.
  const requested = useRef<string | undefined>(undefined)

  const replace = (path: string, next: (file: OpenFile) => OpenFile): void =>
    setFiles((all) => all.map((f) => (f.path === path ? next(f) : f)))

  /** Opens a file, or brings it forward; a clean one is re-read so it matches the disk. */
  const open = useCallback(async (path: string, quiet = false): Promise<void> => {
    if (!projectPath) return
    if (!quiet) { setError(''); requested.current = path }
    const existing = current.current.find((f) => f.path === path)
    if (existing && isDirty(existing)) { if (!quiet || !requested.current) setActive(path); return }
    const stillCurrent = guard?.begin()
    try {
      const read = await api.readFile(projectPath, path, scope)
      if (stillCurrent && !stillCurrent()) return
      const stored = existing ? undefined : parse<StoredDraft>(storage.get(draftKey(draftFor(read.path) ?? projectPath, read.path)))
      const next = { ...openFile(read.path, read.text, read.version, stored?.draft), conflict: stored !== undefined && stored.version !== read.version }
      setFiles((all) => (all.some((f) => f.path === read.path) ? all.map((f) => (f.path === read.path ? next : f)) : [...all, next]))
      if (!quiet || !requested.current) setActive(read.path)
    } catch (e) {
      if (!quiet) setError(messageOf(e))
    }
  }, [projectPath, scope, guard])

  // Reopen last visit's files (their drafts come back from storage).
  useEffect(() => {
    if (!projectPath) return
    let cancelled = false
    const saved = parse<StoredTabs>(storage.get(tabsKey(tabsFor ?? projectPath)))
    void (async () => {
      for (const path of saved?.paths ?? []) {
        if (cancelled) return
        await open(path, true)
      }
      if (cancelled) return
      const want = requested.current ?? saved?.active
      if (want && current.current.some((f) => f.path === want)) setActive(want)
      restored.current = true
    })()
    return () => { cancelled = true }
  }, [projectPath, tabsFor, open])

  // Persist the open tabs and every unsaved draft (with the version it started from).
  useEffect(() => {
    if (!projectPath || !restored.current) return
    storage.set(tabsKey(tabsFor ?? projectPath), JSON.stringify({ paths: files.map((f) => f.path), active } satisfies StoredTabs))
    for (const file of files) {
      storage.set(draftKey(draftFor(file.path) ?? projectPath, file.path), isDirty(file) ? JSON.stringify({ draft: file.draft, version: file.version } satisfies StoredDraft) : undefined)
    }
  }, [projectPath, tabsFor, files, active])

  const edit = (path: string, draft: string): void => replace(path, (f) => ({ ...f, draft }))

  /** `draft` saves that text instead of the stored draft, for an editor that has just flushed it. */
  const save = async (path: string, options: { expected?: string; draft?: string } = {}): Promise<void> => {
    const file = current.current.find((f) => f.path === path)
    if (!projectPath || !file?.eol) return
    const text = forDisk(options.draft ?? file.draft, file.eol)
    setError('')
    try {
      const saved = await api.writeFile(projectPath, path, text, options.expected ?? file.version, scope)
      // Keep anything typed while the save was in flight.
      replace(path, (f) => ({ ...f, text, version: saved.version, conflict: false }))
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) replace(path, (f) => ({ ...f, conflict: true }))
      else setError(messageOf(e))
    }
  }

  /** Keeps the editor's text over what changed on disk. */
  const overwrite = async (path: string): Promise<void> => {
    if (!projectPath) return
    try { await save(path, { expected: (await api.readFile(projectPath, path, scope)).version }) } catch (e) { setError(messageOf(e)) }
  }

  /** Keeps both versions: the draft goes to a new "(copy)" file, the original shows what is on disk. */
  const saveCopy = async (path: string): Promise<void> => {
    const file = current.current.find((f) => f.path === path)
    if (!projectPath || !file?.eol) return
    setError('')
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      try {
        const saved = await api.writeFile(projectPath, copyPath(path, attempt), forDisk(file.draft, file.eol), null, scope)
        await reload(path)
        await open(saved.path)
        return
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 409)) { setError(messageOf(e)); return }
      }
    }
    setError('Too many copies already exist; rename one and try again')
  }

  /** Throws the draft away and shows the file as it is on disk. */
  const reload = async (path: string): Promise<void> => {
    if (!projectPath) return
    try {
      const stillCurrent = guard?.begin()
      const read = await api.readFile(projectPath, path, scope)
      if (stillCurrent && !stillCurrent()) return
      replace(path, () => openFile(read.path, read.text, read.version))
    } catch (e) { setError(messageOf(e)) }
  }

  const close = (path: string): void => {
    if (projectPath) storage.set(draftKey(draftFor(path) ?? projectPath, path), undefined)
    const index = current.current.findIndex((f) => f.path === path)
    const rest = current.current.filter((f) => f.path !== path)
    setFiles(rest)
    if (active === path) setActive(rest[Math.min(index, rest.length - 1)]?.path)
  }

  /**
   * Closes every tab except `keep` (or all of them). Tabs with unsaved changes stay open so
   * nothing typed is lost; resolves to how many stayed for that reason.
   */
  const closeMany = (keep?: string): number => {
    const stays = current.current.filter((f) => f.path === keep || isDirty(f))
    for (const f of current.current) if (!stays.includes(f) && projectPath) storage.set(draftKey(draftFor(f.path) ?? projectPath, f.path), undefined)
    setFiles(stays)
    if (!stays.some((f) => f.path === active)) setActive(stays[0]?.path)
    return stays.filter((f) => f.path !== keep).length
  }

  /** After a rename on disk: the open tab follows the file (refused upstream while it has unsaved changes). */
  const renamed = (from: string, to: string): void => {
    if (projectPath) storage.set(draftKey(draftFor(from) ?? projectPath, from), undefined)
    setFiles((all) => all.map((f) => (f.path === from ? { ...f, path: to } : f)))
    if (active === from) setActive(to)
  }

  /** After a file went to the Trash: its tab closes without asking. */
  const removed = (path: string): void => close(path)

  /** Creates a file of `kind` in `folder` (or in the documents); resolves true once it is open. */
  const create = async (folder: string, name: string, kind: NewFileKind = 'other', space: FileSpace = 'project'): Promise<boolean> => {
    if (!projectPath) return false
    const plain = newFilePath(space === 'documents' ? '' : folder, withExtension(name, kind))
    if (!plain) { setError('Use a plain file name, without folders or a leading dot'); return false }
    const path = inSpace(space, plain)
    try {
      const saved = await api.writeFile(projectPath, path, NEW_FILE_KINDS.find((k) => k.id === kind)?.starter ?? '', null, scope)
      await open(saved.path)
      return true
    } catch (e) {
      setError(messageOf(e))
      return false
    }
  }

  return { files, active, error, setError, open, edit, save, overwrite, saveCopy, reload, close, closeMany, renamed, removed, create, setActive }
}
