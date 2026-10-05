import type { ChangedFile, Changes, DiffLine, FileDiff } from './api.ts'

// The Changes viewer's wording and line targets (J4). A right-side line is a line of the file as
// it is now; a left-side (removed) line exists only at the base revision, so it opens there,
// read-only, never on whatever unrelated line now has the same number.

export type LineTarget =
  | { readonly kind: 'current'; readonly path: string; readonly line: number; readonly text: string }
  | { readonly kind: 'historical'; readonly path: string; readonly line: number }

export function lineTarget(diff: FileDiff, line: DiffLine): LineTarget | undefined {
  if (line.kind === 'del' && line.old) return { kind: 'historical', path: diff.oldPath ?? diff.path, line: line.old }
  if ((line.kind === 'add' || line.kind === 'ctx') && line.new && diff.status !== 'deleted') return { kind: 'current', path: diff.path, line: line.new, text: line.text }
  return undefined
}

/** The current file still has the diff's text at that line: the editor may open there. */
export function lineStillMatches(fileText: string, line: number, expected: string): boolean {
  const lines = fileText.split('\n')
  const found = lines[line - 1]
  return found !== undefined && found.replace(/\r$/, '') === expected.replace(/\r$/, '')
}

const LETTER: Record<ChangedFile['status'], string> = {
  modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T', untracked: 'U', conflicted: '!',
}
const WORD: Record<ChangedFile['status'], string> = {
  modified: 'Modified', added: 'Added', deleted: 'Deleted', renamed: 'Renamed', copied: 'Copied', typechange: 'Type changed', untracked: 'New, not tracked', conflicted: 'Conflict',
}
export const statusLetter = (f: Pick<ChangedFile, 'status'>): string => LETTER[f.status]
export const statusWord = (f: Pick<ChangedFile, 'status'>): string => WORD[f.status]

/** Staged / not staged, as one short phrase; untracked files say so in their status. */
export function stagingWord(f: ChangedFile): string | undefined {
  if (f.status === 'untracked' || f.status === 'conflicted') return undefined
  if (f.staged && f.unstaged) return 'Partly staged'
  return f.staged ? 'Staged' : 'Not staged'
}

export function baseLine(changes: Changes): string {
  const where = changes.branch ? `on ${changes.branch}` : 'detached HEAD'
  return changes.base === 'empty' ? `Against an empty base: this repository has no commits yet (${where})` : `Against HEAD ${changes.head!.slice(0, 8)} ${where}`
}

export const shortRevision = (revision: string): string => (revision === 'empty' ? 'no commits yet' : revision.slice(0, 8))

/** Why a file shows no text diff. */
export function omittedText(diff: FileDiff): string | undefined {
  switch (diff.omitted) {
    case 'too-large': return `Too large to show here${diff.size ? ` (${(diff.size / 1024 / 1024).toFixed(1)} MB)` : ''}. Open it in Files or another editor.`
    case 'binary': return 'A binary file: no text diff. Open or reveal it to look at it.'
    case 'symlink': return `A symbolic link to ${diff.symlinkTarget ?? 'another path'}. Cockpit shows the link, not what it points to.`
    case 'submodule': {
      const s = diff.submodule
      const moved = s?.from || s?.to ? `Recorded commit ${s.from ? s.from.slice(0, 8) : 'none'} → ${s.to ? s.to.slice(0, 8) : 'none'}.` : 'Its recorded commit is unchanged.'
      const inner = [s?.modified ? 'it has uncommitted changes of its own' : '', s?.untracked ? 'it has new untracked files' : ''].filter(Boolean).join(' and ')
      return `A submodule (a repository inside this one). ${moved}${inner ? ` Inside it, ${inner}.` : ''} Open it as its own project to see its files.`
    }
    case 'outside': return 'This path leads outside the project folder, so Cockpit does not read it.'
    default: return undefined
  }
}

export const RUN_CHANGE_WORD = {
  changed: 'Changed during this run',
  'changed-again': 'Already changed before; changed again during this run',
  cleaned: 'Changed before; clean after (reverted or committed)',
  unchanged: 'Already changed before; untouched',
} as const
