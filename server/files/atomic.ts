import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'

/**
 * Replaces `file` in one step: the new contents go to a temp file beside it, then a rename. The
 * temp name is random and created exclusively ('wx'), so it never follows a symlink someone left
 * at a predictable `<file>.tmp`; only a fresh file gets the private mode.
 */
export function writeFileAtomic(file: string, data: string, mode = 0o600): void {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  const fd = openSync(tmp, 'wx', mode)
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } catch (error) {
    closeSync(fd)
    try { unlinkSync(tmp) } catch { /* already gone */ }
    throw error
  }
  closeSync(fd)
  try {
    renameSync(tmp, file)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* already gone */ }
    throw error
  }
}

/**
 * Cockpit's own state folder, private to this user. `mkdirSync`'s mode only applies to a folder it
 * creates, so one that already existed with looser permissions is tightened here.
 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700)
}
