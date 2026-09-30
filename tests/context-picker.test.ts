import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkReferences, searchFiles } from '../server/files/search.ts'
import { createWorkflowStore } from '../server/workflows/store.ts'
import { isRemoteRoute } from '../server/remote/guard.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-pick-'))
  mkdirSync(join(root, 'src', 'deep'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(root, 'README.md'), '# Readme\n')
  writeFileSync(join(root, 'src', 'readme-helper.ts'), 'x')
  writeFileSync(join(root, 'src', 'deep', 'notes on readme.md'), 'x')
  writeFileSync(join(root, 'node_modules', 'pkg', 'README.md'), 'x')
  return root
}

describe('context picker file search', () => {
  it('matches every word, ranks name matches first, skips dependencies and links', () => {
    const root = fixture(); const outside = fixture()
    symlinkSync(outside, join(root, 'linked'))
    const { matches } = searchFiles(root, 'readme')
    expect(matches.map((m) => m.path)).toEqual(['README.md', 'src/readme-helper.ts', 'src/deep/notes on readme.md'])
    expect(searchFiles(root, 'deep readme').matches.map((m) => m.path)).toEqual(['src/deep/notes on readme.md'])
    expect(searchFiles(root, 'nothing-like-this').matches).toEqual([])
  })
  it('returns at most 30 matches and says when there are more', () => {
    const root = fixture()
    for (let i = 0; i < 40; i += 1) writeFileSync(join(root, `note-${i}.txt`), 'x')
    const result = searchFiles(root, 'note-')
    expect(result.matches).toHaveLength(30)
    expect(result.truncated).toBe(true)
  })
})

describe('checking a draft\'s references', () => {
  it('reports each distinct reference once, and which would fail if sent now', () => {
    const root = fixture()
    const workflows = createWorkflowStore(mkdtempSync(join(tmpdir(), 'cockpit-pick-wf-')))
    workflows.save({ projectPath: root, name: 'review', prompt: 'Review it' })
    const text = 'See @file:README.md and @file:README.md then @file:gone.md and @file:%E0%A4%A with @workflow:review @workflow:missing'
    expect(checkReferences(text, root, workflows)).toEqual([
      { kind: 'file', reference: 'README.md', ok: true },
      { kind: 'file', reference: 'gone.md', ok: false, problem: 'Not found in this project: gone.md' },
      { kind: 'file', reference: '%E0%A4%A', ok: false, problem: 'Not a valid file reference' },
      { kind: 'workflow', reference: 'review', ok: true },
      { kind: 'workflow', reference: 'missing', ok: false, problem: 'Unknown workflow in this project: missing' },
    ])
  })
  it('stays off the phone, like the rest of the Files routes', () => {
    expect(isRemoteRoute('GET', '/api/files/search')).toBe(false)
    expect(isRemoteRoute('POST', '/api/references/check')).toBe(false)
  })
})
