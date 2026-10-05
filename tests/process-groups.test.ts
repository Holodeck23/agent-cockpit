import { describe, expect, it } from 'vitest'
import type { ProcessInfo } from '../server/processes/runner.ts'
import { groupProcesses, ownerText, PROJECT_GROUP } from '../web/src/process-groups.ts'

const proc = (id: string, over: Partial<ProcessInfo>): ProcessInfo => ({
  id, name: id, command: 'x', projectPath: '/p', status: 'running', startedAt: '2026-10-05T10:00:00.000Z', exitCode: null, signal: null, owner: { kind: 'project' }, ...over,
})

describe('Processes grouped by owner (K2)', () => {
  const list = [
    proc('old', { owner: { kind: 'conversation', threadId: 'a', title: 'Login' }, startedAt: '2026-10-05T09:00:00.000Z' }),
    proc('new', { owner: { kind: 'conversation', threadId: 'b', title: 'Docs' }, startedAt: '2026-10-05T11:00:00.000Z' }),
    proc('legacy', { startedAt: '2026-10-05T10:00:00.000Z' }),
    proc('done', { owner: { kind: 'conversation', threadId: 'a', title: 'Login' }, status: 'exited' }),
  ]
  it('newest active work first; unowned under Project processes; finished only in its own view', () => {
    expect(groupProcesses(list, false).map((g) => [g.label, g.processes.map((p) => p.id)])).toEqual([['Docs', ['new']], [PROJECT_GROUP, ['legacy']], ['Login', ['old']]])
    expect(groupProcesses(list, true).map((g) => [g.label, g.processes.map((p) => p.id)])).toEqual([['Login', ['done']]])
  })
  it('names the owner and the conversations sharing it', () => {
    expect(ownerText(proc('x', { owner: { kind: 'conversation', threadId: 'a', title: 'Login' }, sharedWith: [{ threadId: 'b', title: 'Docs' }] }))).toBe('Started by “Login” · also used by “Docs”')
    expect(ownerText(proc('x', { owner: { kind: 'project', formerly: 'Login' } }))).toBe('Project process (kept from “Login”)')
  })
})
