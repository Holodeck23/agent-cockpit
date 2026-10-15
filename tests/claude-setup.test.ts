import { expect, it } from 'vitest'
import { resolveClaudeSetup } from '../server/agents/claude/setup.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'

const settings = (input: Record<string, unknown>) => threadSettingsSchema.parse({ agent: 'claude', ...input })

it('keeps legacy booleans while new conversations inherit independent project switches', () => {
  const project = { claudeHooks: true, claudeMcp: false }
  expect(resolveClaudeSetup(settings({ useHooks: false }), project, {})).toMatchObject({ hooks: false, connectors: false })
  expect(resolveClaudeSetup(settings({ useHooks: true }), project, {})).toMatchObject({ hooks: true, connectors: false })
  expect(resolveClaudeSetup(settings({ hooksSetup: 'inherit', mcpSetup: 'inherit' }), project, {})).toMatchObject({ hooks: true, connectors: false })
  expect(resolveClaudeSetup(settings({ hooksSetup: 'off', mcpSetup: 'on' }), project, {})).toMatchObject({ hooks: false, connectors: true })
})

it('does not broaden scheduled/delegated records and suppresses connectors in nonprompting modes', () => {
  const desired = settings({ hooksSetup: 'inherit', mcpSetup: 'inherit' })
  expect(resolveClaudeSetup(desired, {}, { workflowTrigger: 'scheduled' })).toMatchObject({ hooks: false, connectors: false })
  expect(resolveClaudeSetup(desired, {}, { createdByThreadId: 'parent' })).toMatchObject({ hooks: false, connectors: false })
  expect(resolveClaudeSetup(settings({ hooksSetup: 'inherit', mcpSetup: 'inherit', permissionMode: 'dontAsk' }), {}, {}))
    .toEqual({ hooks: true, connectors: false, connectorsSuppressed: true })
})
