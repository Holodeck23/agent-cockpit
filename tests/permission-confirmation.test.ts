import { expect, it } from 'vitest'
import { needsPermissionConfirmation, permissionDescription } from '../web/src/permission-labels.ts'

it('requires confirmation for permissive presets and recalled choices, not ordinary settings changes', () => {
  const manual = { agent: 'claude', permissionMode: 'manual' } as const
  const bypass = { agent: 'claude', permissionMode: 'bypassPermissions' } as const
  expect(needsPermissionConfirmation(manual, bypass)).toBe(true)
  expect(needsPermissionConfirmation(manual, { agent: 'codex', permissionMode: 'dontAsk' })).toBe(true)
  expect(needsPermissionConfirmation(bypass, { ...bypass, agent: 'codex' })).toBe(true)
  expect(needsPermissionConfirmation(bypass, bypass)).toBe(false)
  expect(needsPermissionConfirmation(bypass, manual)).toBe(false)
  // Antigravity's own default is Bypass (its Manual refuses every write): switching to it does not ask.
  expect(needsPermissionConfirmation(manual, { agent: 'antigravity', permissionMode: 'bypassPermissions' })).toBe(false)
  expect(needsPermissionConfirmation({ agent: 'antigravity', permissionMode: 'manual' }, { agent: 'antigravity', permissionMode: 'bypassPermissions' })).toBe(true)
})
it('explains that Codex manual mode does not ask for every workspace write', () => {
  expect(permissionDescription('codex', 'manual')).toContain('edit inside the workspace')
  expect(permissionDescription('codex', 'acceptEdits')).toBe(permissionDescription('codex', 'manual'))
  expect(permissionDescription('codex', 'dontAsk')).toContain('sandbox')
  expect(permissionDescription('codex', 'bypassPermissions')).toContain('without its sandbox')
})
