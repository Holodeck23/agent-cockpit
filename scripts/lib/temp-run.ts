// One private run folder under the real temp dir, for a process (a vitest run, the release gate)
// that makes many temp dirs and has to leave none behind. The process points TMPDIR at it, every
// mkdtemp below lands inside it, and removing the one folder removes all of them.
//
// The name is 7 bytes on purpose. macOS caps a unix-socket path at 104 bytes, and Chromium puts
// <TMPDIR>/.org.chromium.Chromium.XXXXXX/SingletonSocket (46 bytes) under TMPDIR. With the usual
// 48-byte per-user temp dir, a 7-byte folder leaves that path at 102 bytes; a name like
// "cockpit-gate-XXXXXX" would push it past the cap and the packaged app would fail to start.
//
// The folder holds a marker with the owning pid. scripts/clean.ts uses it to sweep a folder whose
// owner died without cleaning up (SIGKILL, power cut) and to leave one alone whose owner still runs.
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

/** Name of the marker file inside a run folder. Holds the owner's pid. */
export const RUN_MARKER = '.cockpit-run'
/** "k" plus the six characters mkdtemp adds. */
export const RUN_FOLDER_NAME = /^k[A-Za-z0-9]{6}$/

/** Makes the run folder inside `base` (the real temp dir by default) and records `owner` in it. */
export function createRunFolder(base: string = tmpdir(), owner: number = process.pid): string {
  const dir = mkdtempSync(join(base, 'k'))
  writeFileSync(join(dir, RUN_MARKER), `${owner}\n`)
  return dir
}

/** The pid recorded in a run folder, or undefined if `dir` has no marker (so it is not one). */
export function runFolderOwner(dir: string): number | undefined {
  try {
    const pid = Number(readFileSync(join(dir, RUN_MARKER), 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

/** A real directory (not a link) with a run-folder name and a marker. Nothing else is ever removed by removeRunFolder. */
export function isRunFolder(dir: string): boolean {
  if (!RUN_FOLDER_NAME.test(basename(dir))) return false
  try {
    const stat = lstatSync(dir)
    return stat.isDirectory() && !stat.isSymbolicLink() && existsSync(join(dir, RUN_MARKER))
  } catch {
    return false
  }
}

/** Removes a run folder and everything in it. Returns false, touching nothing, if `dir` is not one. */
export function removeRunFolder(dir: string): boolean {
  const target = resolve(dir)
  if (!isRunFolder(target)) return false
  rmSync(target, { recursive: true, force: true })
  return true
}

/** True if a process with this pid exists (one we may not signal still counts). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
