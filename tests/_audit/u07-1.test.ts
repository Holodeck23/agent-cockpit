import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileDiff, listChanges } from '../../server/git/changes.ts'

// u07-1: fileDiff passes the changed path to `git diff ... -- <path>` as an ordinary pathspec. Git
// matches a pathspec literally AND as a wildmatch glob, so a path containing [ ], * or ? also pulls in
// sibling files (app/[id]/page.tsx also matches app/i/page.tsx and app/d/page.tsx). parseUnified then
// merges every matched file's hunks into one FileDiff labelled with the requested path.
// CORRECT behaviour: the diff for a path contains only that file's hunks.

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
delete (ENV as Record<string, string | undefined>).GIT_LITERAL_PATHSPECS
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { env: ENV, encoding: 'utf8' })

function repoWith(files: Record<string, string>, edited: Record<string, string>): string {
  const root = join(mkdtempSync(join(tmpdir(), 'cockpit-audit-u07-1-')), 'project')
  mkdirSync(root)
  git(root, 'init', '-q', '-b', 'main')
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'first')
  for (const [path, text] of Object.entries(edited)) writeFileSync(join(root, path), text)
  return root
}

const texts = (lines: readonly { kind: string; text: string }[]): string[] => lines.filter((l) => l.kind !== 'hunk').map((l) => l.text)

describe('u07-1: a changed path with glob characters must be diffed literally', () => {
  it('app/[id]/page.tsx diff does not include app/i/page.tsx or app/d/page.tsx', async () => {
    const root = repoWith(
      { 'app/[id]/page.tsx': 'dynamic old\n', 'app/i/page.tsx': 'sibling-i old\n', 'app/d/page.tsx': 'sibling-d old\n' },
      { 'app/[id]/page.tsx': 'dynamic new\n', 'app/i/page.tsx': 'sibling-i new\n', 'app/d/page.tsx': 'sibling-d new\n' },
    )
    try {
      const changes = await listChanges(root)
      expect(changes.repo && changes.files.map((f) => f.path)).toEqual(['app/[id]/page.tsx', 'app/d/page.tsx', 'app/i/page.tsx'])
      const diff = await fileDiff(root, 'app/[id]/page.tsx')
      expect(diff.path).toBe('app/[id]/page.tsx')
      expect(texts(diff.lines)).toEqual(['dynamic old', 'dynamic new'])
      expect(diff.lines.filter((l) => l.kind === 'hunk')).toHaveLength(1)
    } finally { rmSync(join(root, '..'), { recursive: true, force: true }) }
  })

  it('a path with * and ? does not pull in other changed files', async () => {
    const root = repoWith(
      { 'docs/a*.md': 'star old\n', 'docs/ab.md': 'other old\n', 'docs/x?.md': 'q old\n', 'docs/xy.md': 'xy old\n' },
      { 'docs/a*.md': 'star new\n', 'docs/ab.md': 'other new\n', 'docs/x?.md': 'q new\n', 'docs/xy.md': 'xy new\n' },
    )
    try {
      expect(texts((await fileDiff(root, 'docs/a*.md')).lines)).toEqual(['star old', 'star new'])
      expect(texts((await fileDiff(root, 'docs/x?.md')).lines)).toEqual(['q old', 'q new'])
    } finally { rmSync(join(root, '..'), { recursive: true, force: true }) }
  })
})
