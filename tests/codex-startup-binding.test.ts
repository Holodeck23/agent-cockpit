import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import reviewed from './fixtures/codex-reviewed-config.json' with { type: 'json' }
import { bindCodexStartup } from '../server/agents/codex/startup-binding.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-native-binding-')); roots.push(root)
  const file = join(root, 'config.toml'), response: any = structuredClone(reviewed)
  response.layers.push({ name: { type: 'user', file }, version: `sha256:${'a'.repeat(64)}`, config: {} })
  return { root, file, response }
}

it('accepts unchanged missing native layer files and ordinary JSON key reordering', () => {
  const f = fixture(), binding = bindCodexStartup(f.response, false)
  f.response.layers[1].name = { file: f.file, type: 'user' }
  expect(() => binding.recheck(f.response)).not.toThrow()
})

it.each(['version', 'profile', 'disabled', 'add', 'remove', 'order', 'unknown'])('refuses changed or unresolved native identities: %s', change => {
  const f = fixture(), binding = bindCodexStartup(f.response, false)
  switch (change) {
    case 'version': f.response.layers[1].version = `sha256:${'b'.repeat(64)}`; break
    case 'profile': f.response.layers[1].name.profile = 'other'; break
    case 'disabled': f.response.layers[1].disabledReason = 'untrusted'; break
    case 'add': f.response.layers.push({ ...f.response.layers[1], name: { type: 'project', dotCodexFolder: '/fictional/.codex' } }); break
    case 'remove': f.response.layers.pop(); break
    case 'order': f.response.layers.reverse(); break
    case 'unknown': delete f.response.layers[1].version; break
  }
  expect(() => binding.recheck(f.response)).toThrow('not delivered')
})

it.each(['create', 'edit', 'replace', 'delete', 'directory', 'dangling', 'retarget'])('detects known native file changes without relying on a new config/read: %s', change => {
  const f = fixture()
  if (change !== 'create') writeFileSync(f.file, 'original')
  if (change === 'retarget') { unlinkSync(f.file); writeFileSync(join(f.root, 'a'), 'same'); symlinkSync(join(f.root, 'a'), f.file) }
  const binding = bindCodexStartup(f.response, false)
  switch (change) {
    case 'create': writeFileSync(f.file, 'new'); break
    case 'edit': writeFileSync(f.file, 'changed'); break
    case 'replace': writeFileSync(join(f.root, 'replacement'), 'original'); renameSync(join(f.root, 'replacement'), f.file); break
    case 'delete': unlinkSync(f.file); break
    case 'directory': unlinkSync(f.file); mkdirSync(f.file); break
    case 'dangling': unlinkSync(f.file); symlinkSync(join(f.root, 'missing'), f.file); break
    case 'retarget': writeFileSync(join(f.root, 'b'), 'same'); unlinkSync(f.file); symlinkSync(join(f.root, 'b'), f.file); break
  }
  expect(() => binding.checkFiles()).toThrow('not delivered')
})

it.each([undefined, '', 'unknown', `sha256:${'a'.repeat(63)}`])('refuses absent or malformed native versions: %s', version => {
  const f = fixture(); f.response.layers[1].version = version
  expect(() => bindCodexStartup(f.response, false)).toThrow('not delivered')
})
