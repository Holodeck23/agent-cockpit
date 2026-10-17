import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNativeMemorySelectionStore, type NativeMemoryScope } from '../server/agents/setup/native-memory-selection.ts'
import { StoreReadError } from '../server/state/read-error.ts'

// W13 U5c: a private record of which native memory a destination account may load, bound to the exact
// account generation and the reviewed source revision. Anything that moved since review fails closed.

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-memory-selection-')))
  const sourceRoot = join(root, 'profile'), sourceDir = join(sourceRoot, 'memory'), state = join(root, 'state')
  mkdirSync(join(sourceDir, 'notes'), { recursive: true })
  writeFileSync(join(sourceDir, 'MEMORY.md'), '# Fictional memory\n')
  writeFileSync(join(sourceDir, 'notes', 'detail.md'), 'W13 fictional detail')
  const project = join(root, 'project')
  const scope: NativeMemoryScope = { projectPath: project }
  const input = { scope, destinationAccountId: 'acct-a', destinationGeneration: 1, sourceAccountId: 'acct-a',
    sourceRoot, sourceDir, writePolicy: 'managed-auto' as const }
  return { root, sourceRoot, sourceDir, state, project, scope, input, store: createNativeMemorySelectionStore(state) }
}

describe('native memory selection (W13 U5c)', () => {
  it('records the reviewed revision privately and returns only the exact scope', () => {
    const f = fixture()
    const selected = f.store.select(f.input)
    expect(selected).toMatchObject({ fileCount: 2, sourceRevision: expect.stringMatching(/^[a-f0-9]{64}$/), destinationAccountId: 'acct-a' })
    expect(f.store.get(f.scope)?.id).toBe(selected.id)
    // No implicit inheritance: a thread inside the project is a different scope.
    expect(f.store.get({ projectPath: f.project, threadId: '6f1d6d7e-0d7c-4b7e-9f1a-2a3b4c5d6e7f' })).toBeUndefined()
    const file = join(f.state, 'native-memory-selections.json')
    expect(statSync(file).mode & 0o077).toBe(0)
    expect(statSync(f.state).mode & 0o077).toBe(0)
    // Content stays out of the record: only its revision and count.
    expect(readFileSync(file, 'utf8')).not.toContain('fictional')
  })

  it('refuses automatic promotion across accounts but allows a reviewed cross-account share', () => {
    const f = fixture()
    expect(() => f.store.select({ ...f.input, sourceAccountId: 'acct-b' })).toThrow('Automatic native memory promotion requires the same account')
    expect(f.store.select({ ...f.input, sourceAccountId: 'acct-b', writePolicy: 'review' }).writePolicy).toBe('review')
  })

  it('refuses sources outside their scope, linked roots and missing MEMORY.md', () => {
    const f = fixture()
    const outside = join(f.root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'MEMORY.md'), 'x')
    expect(() => f.store.select({ ...f.input, sourceDir: outside })).toThrow(/leaves its selected scope/)
    const linkedRoot = join(f.root, 'linked-profile')
    symlinkSync(f.sourceRoot, linkedRoot)
    expect(() => f.store.select({ ...f.input, sourceRoot: linkedRoot, sourceDir: join(linkedRoot, 'memory') })).toThrow(/leaves its selected scope/)
    rmSync(join(f.sourceDir, 'MEMORY.md'))
    expect(() => f.store.select(f.input)).toThrow('Native memory source is unavailable or changed')
  })

  it('needs the current selection ID to replace or revoke, so a stale review cannot win', () => {
    const f = fixture()
    const first = f.store.select(f.input)
    expect(() => f.store.select(f.input)).toThrow('Native memory selection changed; review it again')
    const second = f.store.select(f.input, first.id)
    expect(() => f.store.revoke(f.scope, first.id)).toThrow('Native memory selection changed; review it again')
    expect(f.store.revoke(f.scope, second.id)).toBe(true)
    expect(f.store.get(f.scope)).toBeUndefined()
    expect(f.store.revoke(f.scope, second.id)).toBe(false)
  })

  it('fails closed on another account generation, an edited source or a removed source', () => {
    const f = fixture()
    f.store.select(f.input)
    // Destructured on purpose: validate must not depend on its receiver.
    const { validate } = f.store
    expect(validate(f.scope, 'acct-a', 1)?.destinationGeneration).toBe(1)
    expect(() => validate(f.scope, 'acct-a', 2)).toThrow('Native memory selection belongs to a different account generation')
    expect(() => validate(f.scope, 'acct-b', 1)).toThrow('Native memory selection belongs to a different account generation')
    writeFileSync(join(f.sourceDir, 'notes', 'detail.md'), 'edited after review')
    expect(() => validate(f.scope, 'acct-a', 1)).toThrow('Native memory source changed after selection')
    rmSync(f.sourceDir, { recursive: true })
    expect(() => validate(f.scope, 'acct-a', 1)).toThrow(/unavailable/)
    expect(validate({ projectPath: join(f.root, 'elsewhere') }, 'acct-a', 1)).toBeUndefined()
  })

  it('reports an unreadable store instead of treating it as empty', () => {
    const f = fixture()
    mkdirSync(f.state, { recursive: true })
    writeFileSync(join(f.state, 'native-memory-selections.json'), '{not json')
    expect(() => f.store.get(f.scope)).toThrow(StoreReadError)
  })
})
