import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPresetStore } from '../../server/presets/store.ts'

// Audit u11-2: one stale/invalid entry in presets.json hides every preset, and the next save from the
// picker (which always sends list() + the change) overwrites the file, so the valid presets are lost.
// CORRECT behaviour: the valid presets survive, either still listed or preserved in a backup file.

const root = () => mkdtempSync(join(tmpdir(), 'cockpit-audit-u11-2-'))
const quick = { name: 'Quick fix', agent: 'claude', model: 'haiku', effort: 'low', permissionMode: 'acceptEdits' }
const deep = { name: 'Deep review', agent: 'codex', model: '', effort: 'high', permissionMode: 'plan' }
const added = { name: 'Brand new', agent: 'claude', model: '', effort: '', permissionMode: 'manual' }

/** Everything the user could still recover: what list() shows, plus the text of every file left in the folder. */
const recoverable = (dir: string, store: ReturnType<typeof createPresetStore>): string =>
  JSON.stringify(store.list()) + readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n')

describe('u11-2: presets.json that is only partly valid', () => {
  it('one preset with a value the schema no longer accepts does not hide or destroy the other presets', () => {
    const dir = root()
    const stale = { name: 'Old setting', agent: 'claude', model: '', effort: 'removed-effort-level', permissionMode: 'manual' }
    writeFileSync(join(dir, 'presets.json'), JSON.stringify({ presets: [quick, stale, deep] }, null, 2))

    const store = createPresetStore(dir)
    // The picker loads the list, appends the new preset, and saves the whole list back.
    store.replace([...store.list(), added])

    const left = recoverable(dir, store)
    expect(left).toContain('Quick fix')
    expect(left).toContain('Deep review')
    expect(left).toContain('Brand new')
  })

  it('an unreadable presets.json is not silently overwritten by the next save', () => {
    const dir = root()
    const original = JSON.stringify({ presets: [quick, deep] }, null, 2).replace('"presets"', '"presets",,') // hand-edit typo
    writeFileSync(join(dir, 'presets.json'), original)

    const store = createPresetStore(dir)
    try { store.replace([...store.list(), added]) } catch { /* refusing to overwrite is also correct */ }

    const left = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n')
    expect(left).toContain('Quick fix')
    expect(left).toContain('Deep review')
  })
})
