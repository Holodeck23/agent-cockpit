import { expect, it } from 'vitest'
import { outsideWorkspace, requestedEdit, sessionScope } from '../web/src/approval-details.ts'

it('shows exact requested replacements, including empty strings and replace-all', () => {
  expect(requestedEdit({ old_string: '<script>', new_string: '', replace_all: true })).toEqual({ before: '<script>', after: '', all: true })
  expect(requestedEdit({ file_path: 'a.ts' })).toBeUndefined()
})
it('compares complete path segments and normalizes parent traversal', () => {
  expect(outsideWorkspace({ file_path: '/project-other/a' }, '/project')).toBe(true)
  expect(outsideWorkspace({ file_path: '../secret' }, '/project')).toBe(true)
  expect(outsideWorkspace({ file_path: 'src/../a' }, '/project')).toBe(false)
  expect(outsideWorkspace({ file_path: '/project/a' }, '/project')).toBe(false)
  expect(outsideWorkspace({ file_path: '/a' }, '/')).toBe(false)
  expect(outsideWorkspace({ file_path: '/a' })).toBe(false)
})
it('does not promise the same session grant scope for every agent', () => {
  expect(sessionScope('claude', 'Bash')).toContain('same folder')
  expect(sessionScope('codex', 'Shell')).toContain('exact command')
  expect(sessionScope('codex', 'Edit')).not.toContain('exact command')
})
