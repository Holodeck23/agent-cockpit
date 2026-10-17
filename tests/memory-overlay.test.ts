import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { materializeNativeMemory, snapshotNativeMemory } from '../server/agents/setup/memory-overlay.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-memory-overlay-'))
  const source = join(root, 'source'), privateRoot = join(root, 'private')
  mkdirSync(join(source, 'notes'), { recursive: true })
  writeFileSync(join(source, 'MEMORY.md'), '# Fictional memory\n')
  writeFileSync(join(source, 'notes', 'detail.md'), 'W13 fictional detail')
  return { root, source, privateRoot }
}

it('copies only the selected revision into a private writable overlay and leaves source untouched', () => {
  const f = fixture()
  const original = readFileSync(join(f.source, 'MEMORY.md'))
  const selected = snapshotNativeMemory(f.source)
  const overlay = materializeNativeMemory(f.source, f.privateRoot, selected.revision)
  expect(overlay.fileCount).toBe(2)
  expect(readFileSync(join(overlay.directory, 'notes', 'detail.md'), 'utf8')).toBe('W13 fictional detail')
  expect(lstatSync(overlay.directory).mode & 0o077).toBe(0)
  writeFileSync(join(overlay.directory, 'MEMORY.md'), 'provider-owned new memory')
  expect(readFileSync(join(f.source, 'MEMORY.md'))).toEqual(original)
  expect(snapshotNativeMemory(overlay.directory).revision).not.toBe(selected.revision)
})

it('refuses changed, linked and oversized memory sources before provider launch', () => {
  const f = fixture()
  const selected = snapshotNativeMemory(f.source)
  writeFileSync(join(f.source, 'MEMORY.md'), 'changed')
  expect(() => materializeNativeMemory(f.source, f.privateRoot, selected.revision)).toThrow(/changed after selection/)
  symlinkSync(join(f.source, 'MEMORY.md'), join(f.source, 'notes', 'linked.md'))
  expect(() => snapshotNativeMemory(f.source)).toThrow(/linked entry/)
  symlinkSync(f.source, join(f.root, 'source-link'))
  expect(() => snapshotNativeMemory(join(f.root, 'source-link'))).toThrow(/linked or not a directory/)
  const other = fixture()
  writeFileSync(join(other.source, 'notes', 'too-big'), Buffer.alloc(8 * 1024 * 1024))
  expect(() => snapshotNativeMemory(other.source)).toThrow(/exceeds the reviewed source limit/)
})

it('does not materialize inside the source or into a shared destination', () => {
  const f = fixture()
  const revision = snapshotNativeMemory(f.source).revision
  const inside = join(f.source, 'overlay')
  expect(() => materializeNativeMemory(f.source, inside, revision)).toThrow(/inside the source/)
  expect(existsSync(inside)).toBe(false)
  mkdirSync(f.privateRoot, { mode: 0o755 })
  expect(() => materializeNativeMemory(f.source, f.privateRoot, revision)).toThrow(/private directory/)
})
