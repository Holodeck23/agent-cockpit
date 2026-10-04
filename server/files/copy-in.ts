import { constants, copyFileSync, lstatSync, statSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { contained } from './browser.ts'

// Files dropped on the Files explorer (F8): copied into the folder being shown. Never over an
// existing file: a taken name gets " (copy)", then " (copy 2)"…, the same way "Save mine as a
// copy" names files. Only plain files; folders and symbolic links are skipped with a reason.

export interface CopyResult {
  /** New paths relative to the space's root, in the order dropped. */
  readonly copied: string[]
  readonly skipped: Array<{ readonly name: string; readonly reason: string }>
}

const copyName = (name: string, attempt: number): string => {
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  return `${stem} (copy${attempt > 1 ? ` ${attempt}` : ''})${ext}`
}

/** Copies absolute `sources` into `folder` (relative to `root`, which must contain it). */
export function copyInto(root: string, folder: string, sources: readonly string[]): CopyResult {
  const { root: real, target } = contained(root, folder)
  if (!statSync(target).isDirectory()) throw new Error('Drop files onto a folder')
  const prefix = target === real ? '' : `${target.slice(real.length + 1)}/`
  const copied: string[] = []
  const skipped: Array<{ name: string; reason: string }> = []
  for (const source of sources) {
    const name = basename(source)
    if (!isAbsolute(source)) { skipped.push({ name, reason: 'Not a file from this Mac' }); continue }
    let info
    try { info = lstatSync(source) } catch { skipped.push({ name, reason: 'Not found' }); continue }
    if (info.isSymbolicLink()) { skipped.push({ name, reason: 'Symbolic links are not copied' }); continue }
    if (!info.isFile()) { skipped.push({ name, reason: 'Folders are not copied; drop the files inside it' }); continue }
    for (let attempt = 0; attempt <= 50; attempt += 1) {
      const next = attempt === 0 ? name : copyName(name, attempt)
      try {
        // COPYFILE_EXCL: the copy fails rather than replace a file that is already there.
        copyFileSync(source, join(target, next), constants.COPYFILE_EXCL)
        copied.push(`${prefix}${next}`)
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { skipped.push({ name, reason: (error as Error).message }); break }
        if (attempt === 50) skipped.push({ name, reason: 'Too many copies with this name already' })
      }
    }
  }
  return { copied, skipped }
}
