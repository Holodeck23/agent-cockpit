import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute } from 'node:path'

// Projects → New Project…: the folder named in the Save panel. Never touches anything that
// is already there except an empty folder of the same name, which is simply used.

export type NewProject = { readonly path: string } | { readonly error: string }

export function createProjectFolder(path: string): NewProject {
  const name = basename(path)
  if (!isAbsolute(path) || !existsSync(dirname(path)) || !statSync(dirname(path)).isDirectory()) {
    return { error: 'That location is not available. Choose another folder.' }
  }
  if (!name.trim()) return { error: 'Give the project a name.' }
  if (name.startsWith('.')) return { error: "A project name can't start with a dot; macOS would hide the folder." }
  if (existsSync(path)) {
    if (!statSync(path).isDirectory()) return { error: `“${name}” is already a file there. Choose another name.` }
    if (readdirSync(path).length > 0) return { error: `A folder named “${name}” already has files. Choose another name, or use Open folder… to open it as it is.` }
    return { path }
  }
  try {
    mkdirSync(path)
    return { path }
  } catch (error) {
    return { error: `Cockpit could not create the folder: ${error instanceof Error ? error.message : String(error)}` }
  }
}
