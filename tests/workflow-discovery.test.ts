import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createWorkflowStore, expandWorkflows } from '../server/workflows/store.ts'
import { filterWorkflows, groupByCollection } from '../web/src/workflow-list.ts'

const project = mkdtempSync(join(tmpdir(), 'cockpit-wf-project-'))
const row = (name: string, extra: Partial<{ title: string; collection: string; prompt: string; enabled: boolean }> = {}) =>
  ({ name, prompt: extra.prompt ?? `${name} instructions`, enabled: extra.enabled ?? false, title: extra.title, collection: extra.collection })

describe('workflow list', () => {
  const rows = [
    row('nightly-check', { title: 'Nightly check', collection: 'Quality', enabled: true }),
    row('focused-review', { title: 'Focused review', collection: 'Quality', prompt: 'Look for bugs in the diff' }),
    row('brief'),
  ]
  it('searches titles, names, collections and instructions; every word must match', () => {
    expect(filterWorkflows(rows, 'bugs diff', 'all').map((r) => r.name)).toEqual(['focused-review'])
    expect(filterWorkflows(rows, 'quality', 'all').map((r) => r.name)).toEqual(['nightly-check', 'focused-review'])
    expect(filterWorkflows(rows, 'NIGHTLY', 'all')).toHaveLength(1)
    expect(filterWorkflows(rows, 'nothing-like-this', 'all')).toEqual([])
  })
  it('splits scheduled from manual', () => {
    expect(filterWorkflows(rows, '', 'scheduled').map((r) => r.name)).toEqual(['nightly-check'])
    expect(filterWorkflows(rows, '', 'manual').map((r) => r.name)).toEqual(['focused-review', 'brief'])
  })
  it('groups by collection, ungrouped last, titles sorted', () => {
    expect(groupByCollection(rows).map((g) => [g.collection, g.rows.map((r) => r.name)])).toEqual([
      ['Quality', ['focused-review', 'nightly-check']],
      [undefined, ['brief']],
    ])
  })
})

describe('workflow titles and reference names', () => {
  it('loads workflows saved before titles existed, and keeps their references working', () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-wf-'))
    const now = new Date().toISOString()
    writeFileSync(join(root, 'workflows.json'), JSON.stringify([{ id: crypto.randomUUID(), projectPath: project, name: 'old-one',
      prompt: 'Say hi', settings: { agent: 'claude', permissionMode: 'manual', useHooks: false }, intervalMinutes: null,
      enabled: false, nextRunAt: null, createdAt: now, updatedAt: now }]))
    const store = createWorkflowStore(root)
    expect(store.list(project)[0]?.title).toBeUndefined()
    expect(expandWorkflows('Run @workflow:old-one', project, store)).toContain('Say hi')
  })

  it('lets the title change but not the reference name', () => {
    const store = createWorkflowStore(mkdtempSync(join(tmpdir(), 'cockpit-wf-')))
    const saved = store.save({ projectPath: project, name: 'daily-check', title: 'Daily check', prompt: 'Check things' })
    const renamed = store.save({ projectPath: project, name: 'daily-check', title: 'Morning check', collection: 'Routine', prompt: 'Check things' }, saved.id)
    expect(renamed).toMatchObject({ title: 'Morning check', collection: 'Routine' })
    expect(expandWorkflows('@workflow:daily-check', project, store)).toContain('Check things')
    expect(() => store.save({ projectPath: project, name: 'morning-check', prompt: 'Check things' }, saved.id)).toThrow(/reference name/)
    expect(store.save({ projectPath: project, name: 'daily-check', title: '', collection: '', prompt: 'Check things' }, saved.id))
      .toMatchObject({ title: undefined, collection: undefined })
  })
})
