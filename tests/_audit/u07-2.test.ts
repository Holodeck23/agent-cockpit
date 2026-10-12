import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compareObservations, observe } from '../../server/git/observe.ts'

// u07-2: observe() hashes dirty files in path order from one shared 32 MiB budget; files past the
// budget get a "stat:<size>:<mtime>" fingerprint. Whether a given file gets sha256 or stat therefore
// depends on the bytes consumed by files sorted before it, and compareObservations treats any
// fingerprint difference as 'changed-again'. A new file sorting first pushes an untouched file
// past the budget, so the untouched file is reported as "changed again during the run".

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { env: ENV, encoding: 'utf8' })

const MIB = 1024 * 1024

function repoWithDirtyFiles(count: number): { root: string; names: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'audit-u072-'))
  git(root, 'init', '-q', '-b', 'main')
  writeFileSync(join(root, 'README.md'), 'seed\n')
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'first')
  const names: string[] = []
  for (let i = 0; i < count; i++) {
    const name = `f${String(i).padStart(2, '0')}.bin`
    // Distinct content, exactly 1 MiB: within the per-file limit, so each is hashable on its own.
    const bytes = Buffer.alloc(MIB, i + 1)
    writeFileSync(join(root, name), bytes)
    names.push(name)
  }
  return { root, names }
}

describe('u07-2: a file’s fingerprint must not depend on how many bytes earlier files used', () => {
  it('an untouched dirty file is not reported changed-again because a new file sorting first used up budget', async () => {
    const { root, names } = repoWithDirtyFiles(40)
    const before = await observe(root)
    expect(before.files.length).toBe(40)

    // During the "run": the agent creates one new 1 MiB file that sorts before all the others.
    writeFileSync(join(root, 'a.bin'), Buffer.alloc(MIB, 250))
    const after = await observe(root)
    expect(after.files.length).toBe(41)

    const comparison = compareObservations(before, after)
    const byPath = new Map(comparison.files.map((f) => [f.path, f.change]))
    expect(byPath.get('a.bin')).toBe('changed')
    // None of the pre-existing files was touched, so none may be reported as changed again.
    const falselyChanged = names.filter((n) => byPath.get(n) !== 'unchanged')
    expect(falselyChanged).toEqual([])
  })

  it('control: with a small dirty set (inside the budget) untouched files stay unchanged', async () => {
    const { root, names } = repoWithDirtyFiles(5)
    const before = await observe(root)
    writeFileSync(join(root, 'a.bin'), Buffer.alloc(MIB, 250))
    const after = await observe(root)
    const byPath = new Map(compareObservations(before, after).files.map((f) => [f.path, f.change]))
    expect(names.every((n) => byPath.get(n) === 'unchanged')).toBe(true)
    expect(byPath.get('a.bin')).toBe('changed')
  })

  it('a file that really changed is still reported when the budget moves it from hashed to sized', async () => {
    const { root, names } = repoWithDirtyFiles(40)
    const before = await observe(root)
    // f31 was the last file inside the budget; a new first file pushes it out, and its bytes also change.
    writeFileSync(join(root, 'a.bin'), Buffer.alloc(MIB, 250))
    writeFileSync(join(root, 'f31.bin'), Buffer.alloc(MIB + 7, 9))
    const byPath = new Map(compareObservations(before, await observe(root)).files.map((f) => [f.path, f.change]))
    expect(byPath.get('f31.bin')).toBe('changed-again')
    expect(names.filter((n) => n !== 'f31.bin' && byPath.get(n) !== 'unchanged')).toEqual([])
  })
})
