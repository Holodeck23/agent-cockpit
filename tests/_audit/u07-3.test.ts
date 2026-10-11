import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gitState, switchBranch } from '../../server/git/branches.ts'

// u07-3: gitState reads `git status --porcelain=v2` without -z, so git C-quotes any path with
// non-ASCII bytes (core.quotePath defaults to true). The branch pill's change list and the
// "Commit or stash first: ..." refusal then show "caf\303\251.txt" (with quotes) instead of café.txt.
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { env: ENV, encoding: 'utf8' })

function repoWithUntracked(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-u07-3-'))
  git(root, 'init', '-q', '-b', 'main')
  writeFileSync(join(root, 'README.md'), '# project\n')
  git(root, 'add', '.')
  git(root, 'commit', '-q', '-m', 'first')
  git(root, 'branch', 'other')
  writeFileSync(join(root, name), 'x\n')
  return root
}

describe('u07-3: uncommitted paths reach the UI as the real file name', () => {
  it('lists a non-ASCII file name as written on disk, not C-escaped', async () => {
    const root = repoWithUntracked('café.txt')
    const state = await gitState(root)
    expect(state.changeCount).toBe(1)
    expect(state.changes).toEqual(['café.txt'])
  })

  it('names the real file in the switch-refusal message', async () => {
    const root = repoWithUntracked('café.txt')
    await expect(switchBranch(root, 'other')).rejects.toThrow('Commit or stash first: 1 uncommitted change (café.txt)')
  })

  it('a rename under -z reports the new name once and does not read the old name as a change', async () => {
    const root = repoWithUntracked('plain.txt')
    git(root, 'mv', 'README.md', 'read me "x".md')
    writeFileSync(join(root, 'tab\there.txt'), 'y\n')
    const state = await gitState(root)
    expect(state.changeCount).toBe(3)
    expect([...state.changes].sort()).toEqual(['plain.txt', 'read me "x".md', 'tab\there.txt'])
  })
})
