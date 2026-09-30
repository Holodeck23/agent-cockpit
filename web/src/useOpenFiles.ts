import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from './api.ts'
import { draftKey, forDisk, isDirty, newFilePath, openFile, tabsKey, type OpenFile } from './file-text.ts'

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

export function useOpenFiles(projectPath: string | undefined) {
  const [files, setFiles] = useState<readonly OpenFile[]>([])
  const [active, setActive] = useState<string>()
  const [error, setError] = useState('')
  const current = useRef(files)
  current.current = files
  const restored = useRef(false)

  const replace = (path: string, next: (file: OpenFile) => OpenFile): void =>
    setFiles((all) => all.map((f) => (f.path === path ? next(f) : f)))

  /** Opens a file, or brings it forward; a clean one is re-read so it matches the disk. */
  const open = useCallback(async (path: string, quiet = false): Promise<void> => {
    if (!projectPath) return
    setError('')
    const existing = current.current.find((f) => f.path === path)
    if (existing && isDirty(existing)) { setActive(path); return }
    try {
      const read = await api.readFile(projectPath, path)
      const stored = existing ? undefined : parse<StoredDraft>(storage.get(draftKey(projectPath, read.path)))
      const next = { ...openFile(read.path, read.text, read.version, stored?.draft), conflict: stored !== undefined && stored.version !== read.version }
      setFiles((all) => (all.some((f) => f.path === read.path) ? all.map((f) => (f.path === read.path ? next : f)) : [...all, next]))
      setActive(read.path)
    } catch (e) {
      if (!quiet) setError(messageOf(e))
    }
  }, [projectPath])

  // Reopen last visit's files (their drafts come back from storage).
  useEffect(() => {
    if (!projectPath) return
    let cancelled = false
    const saved = parse<StoredTabs>(storage.get(tabsKey(projectPath)))
    void (async () => {
      for (const path of saved?.paths ?? []) {
        if (cancelled) return
        await open(path, true)
      }
      if (cancelled) return
      if (saved?.active && current.current.some((f) => f.path === saved.active)) setActive(saved.active)
      restored.current = true
    })()
    return () => { cancelled = true }
  }, [projectPath, open])

  // Persist the open tabs and every unsaved draft (with the version it started from).
  useEffect(() => {
    if (!projectPath || !restored.current) return
    storage.set(tabsKey(projectPath), JSON.stringify({ paths: files.map((f) => f.path), active } satisfies StoredTabs))
    for (const file of files) {
      storage.set(draftKey(projectPath, file.path), isDirty(file) ? JSON.stringify({ draft: file.draft, version: file.version } satisfies StoredDraft) : undefined)
    }
  }, [projectPath, files, active])

  const edit = (path: string, draft: string): void => replace(path, (f) => ({ ...f, draft }))

  const save = async (path: string, expected?: string): Promise<void> => {
    const file = current.current.find((f) => f.path === path)
    if (!projectPath || !file?.eol) return
    const text = forDisk(file.draft, file.eol)
    setError('')
    try {
      const saved = await api.writeFile(projectPath, path, text, expected ?? file.version)
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
    try { await save(path, (await api.readFile(projectPath, path)).version) } catch (e) { setError(messageOf(e)) }
  }

  /** Throws the draft away and shows the file as it is on disk. */
  const reload = async (path: string): Promise<void> => {
    if (!projectPath) return
    try {
      const read = await api.readFile(projectPath, path)
      replace(path, () => openFile(read.path, read.text, read.version))
    } catch (e) { setError(messageOf(e)) }
  }

  const close = (path: string): void => {
    if (projectPath) storage.set(draftKey(projectPath, path), undefined)
    const index = current.current.findIndex((f) => f.path === path)
    const rest = current.current.filter((f) => f.path !== path)
    setFiles(rest)
    if (active === path) setActive(rest[Math.min(index, rest.length - 1)]?.path)
  }

  /** Creates an empty file in `folder`; resolves true once it is open. */
  const create = async (folder: string, name: string): Promise<boolean> => {
    if (!projectPath) return false
    const path = newFilePath(folder, name)
    if (!path) { setError('Use a plain file name, without folders or a leading dot'); return false }
    try {
      const saved = await api.writeFile(projectPath, path, '', null)
      await open(saved.path)
      return true
    } catch (e) {
      setError(messageOf(e))
      return false
    }
  }

  return { files, active, error, open, edit, save, overwrite, reload, close, create, setActive }
}
