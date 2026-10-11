import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { observe } from '../../server/git/observe.ts'
import { createRunObservationStore } from '../../server/runs/observations.ts'
import { runChanges } from '../../server/runs/run-changes.ts'

// Review of u07-2: a file hashed before a run and only sized after it is compared by its
// size and modification time (ObservedFile.stat). The product reads a run's observations back
// through the store, whose schema must keep that field, or the fix never takes effect.

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { env: ENV, encoding: 'utf8' })
const MIB = 1024 * 1024

describe('review: a run observation keeps a file’s stat through the store', () => {
  it('a round trip through the store keeps stat', () => {
    const root = mkdtempSync(join(tmpdir(), 'audit-obs-stat-'))
    const store = createRunObservationStore(root)
    const observation = { repo: true, observedAt: '2026-01-01T00:00:00.000Z', head: 'abc', branch: 'main', truncated: false, stable: true }
    store.put({
      version: 1, runId: 'r1', threadId: 't1', projectPath: '/Users/example/project',
      before: { ...observation, files: [{ path: 'a.bin', status: '??', fingerprint: 'abc', stat: 'stat:100:5' }] },
    } as never)
    expect(store.get('r1')?.before?.files[0]).toEqual({ path: 'a.bin', status: '??', fingerprint: 'abc', stat: 'stat:100:5' })
  })

  it('an untouched file hashed before and only sized after is not changed-again when the run is read back from the store', async () => {
    const project = mkdtempSync(join(tmpdir(), 'audit-obs-proj-'))
    git(project, 'init', '-q', '-b', 'main')
    writeFileSync(join(project, 'README.md'), 'seed\n')
    git(project, 'add', '.'); git(project, 'commit', '-q', '-m', 'first')
    for (let i = 0; i < 40; i++) writeFileSync(join(project, `f${String(i).padStart(2, '0')}.bin`), Buffer.alloc(MIB, i + 1))
    const before = await observe(project)
    writeFileSync(join(project, 'a.bin'), Buffer.alloc(MIB, 250))
    const after = await observe(project)

    const store = createRunObservationStore(mkdtempSync(join(tmpdir(), 'audit-obs-store-')))
    store.put({ version: 1, runId: 'r1', threadId: 't1', projectPath: project, before, after })
    const changes = runChanges('r1', store.get('r1'), false)
    const byPath = new Map(changes.comparison?.files.map((f) => [f.path, f.change]))
    expect(byPath.get('a.bin')).toBe('changed')
    const falselyChanged = [...byPath].filter(([path, change]) => path !== 'a.bin' && change !== 'unchanged')
    expect(falselyChanged).toEqual([])
  }, 30_000)
})
