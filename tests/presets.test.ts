import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPresetStore } from '../server/presets/store.ts'

const root = () => mkdtempSync(join(tmpdir(), 'cockpit-presets-'))
const quick = { name: 'Quick fix', agent: 'claude', model: 'haiku', effort: 'low', permissionMode: 'acceptEdits' } as const

describe('preset store', () => {
  it('starts empty, saves the list and reads it back after a restart', () => {
    const dir = root()
    expect(createPresetStore(dir).list()).toEqual([])
    createPresetStore(dir).replace([quick, { name: 'Deep review', agent: 'codex', model: '', effort: 'high', permissionMode: 'plan' }])
    expect(createPresetStore(dir).list().map((p) => p.name)).toEqual(['Quick fix', 'Deep review'])
  })

  it('refuses duplicate names (ignoring case), blank names and modes an agent cannot use', () => {
    const store = createPresetStore(root())
    expect(() => store.replace([quick, { ...quick, name: 'quick FIX' }])).toThrow(/already/)
    expect(() => store.replace([{ ...quick, name: '  ' }])).toThrow()
    expect(() => store.replace([{ ...quick, agent: 'antigravity', permissionMode: 'acceptEdits' }])).toThrow(/Antigravity/)
  })

  it('a damaged file reads as no presets instead of breaking the picker', () => {
    const dir = root()
    writeFileSync(join(dir, 'presets.json'), '{not json')
    expect(createPresetStore(dir).list()).toEqual([])
    createPresetStore(dir).replace([quick])
    expect(JSON.parse(readFileSync(join(dir, 'presets.json'), 'utf8')).presets).toHaveLength(1)
  })
})
