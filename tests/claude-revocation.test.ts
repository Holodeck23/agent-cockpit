import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createThreadManager } from '../server/threads/manager.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'
import { openApprovals } from '../server/threads/status.ts'
import { buildTranscript } from '../web/src/transcript.ts'
import type { EventSink } from '../server/agents/types.ts'

it('revokes the grant before close and distinguishes cancelled from uncertain queued input', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-revoke-'))
  const project = mkdtempSync(join(tmpdir(), 'cockpit-revoke-project-'))
  const profile = mkdtempSync(join(tmpdir(), 'cockpit-revoke-profile-'))
  const store = createThreadStore(root)
  let projectMcp = true
  let released = 0
  let cancelled = 0
  let finishClose: (() => void) | undefined
  let sink: EventSink = () => undefined
  const manager = createThreadManager(store, {
    accounts: { resolve: () => ({ accountId: 'profile', generation: 1, label: 'Profile', env: { CLAUDE_CONFIG_DIR: profile } }), describe: () => undefined },
    projectTrust: () => ({ codexNetwork: false, claudeHooks: false, claudeMcp: projectMcp }),
    mcp: () => ({ launch: { command: 'node', args: [], secretEnv: {} }, release: () => { released++ } }),
    launchers: { claude: (_req, onEvent) => {
      sink = onEvent
      return { agent: 'claude', alive: () => true, queues: () => true, send: () => undefined,
        cancelQueued: async () => ++cancelled === 1,
        interrupt: () => undefined, respondApproval: () => undefined,
        close: () => new Promise<void>((resolve) => { finishClose = () => { onEvent({ kind: 'exit', code: 0 }); resolve() } }),
      }
    } },
  })
  const settings = threadSettingsSchema.parse({ agent: 'claude', hooksSetup: 'off', mcpSetup: 'inherit' })
  const thread = manager.create({ projectPath: project, settings, text: 'first' })
  sink({ kind: 'approval_request', requestId: 'provider-approval', toolName: 'Write', input: {}, suggestions: [] })
  manager.send(thread.id, 'cancelled before delivery')
  manager.send(thread.id, 'delivery uncertain')
  expect(openApprovals(store.events(thread.id))).toHaveLength(1)
  projectMcp = false
  const revoking = manager.revokeProjectClaudeSetup(project, { claudeHooks: false, claudeMcp: true }, { claudeHooks: false, claudeMcp: false })
  expect(released).toBe(1)
  expect(() => manager.send(thread.id, 'too soon')).toThrow(/retiring/)
  expect(() => manager.approve(thread.id, openApprovals(store.events(thread.id))[0]!, 'allow')).toThrow()
  expect(buildTranscript(store.events(thread.id), 'claude').filter((item) => item.type === 'message').at(-1))
    .toMatchObject({ text: 'delivery uncertain', deliveryUncertain: true })
  finishClose?.()
  await revoking
  const messages = buildTranscript(store.events(thread.id), 'claude').filter((item) => item.type === 'message')
  expect(messages.find((item) => item.text === 'cancelled before delivery')).toMatchObject({ undelivered: true })
  expect(messages.find((item) => item.text === 'cancelled before delivery')).not.toHaveProperty('deliveryUncertain', true)
  expect(messages.find((item) => item.text === 'delivery uncertain')).toMatchObject({ deliveryUncertain: true })
  expect(messages.find((item) => item.text === 'delivery uncertain')).not.toHaveProperty('undelivered', true)
  expect(store.events(thread.id).some((entry) => entry.event.kind === 'setup_revoked')).toBe(true)
  await manager.shutdown()
})

it('retains an explicit chat On choice across project Off, but retires it when approval changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-chat-override-'))
  const project = mkdtempSync(join(tmpdir(), 'cockpit-chat-project-'))
  const profile = mkdtempSync(join(tmpdir(), 'cockpit-chat-profile-'))
  const store = createThreadStore(root)
  let released = 0
  const manager = createThreadManager(store, {
    accounts: { resolve: () => ({ accountId: 'profile', generation: 1, label: 'Profile', env: { CLAUDE_CONFIG_DIR: profile } }), describe: () => undefined },
    projectTrust: () => ({ codexNetwork: false, claudeHooks: false, claudeMcp: false }),
    mcp: () => ({ launch: { command: 'node', args: [], secretEnv: {} }, release: () => { released++ } }),
    launchers: { claude: (_req, sink) => ({ agent: 'claude', alive: () => true, send: () => undefined,
      interrupt: () => undefined, respondApproval: () => undefined,
      close: async () => { sink({ kind: 'exit', code: 0 }) },
    }) },
  })
  const settings = threadSettingsSchema.parse({ agent: 'claude', hooksSetup: 'off', mcpSetup: 'on' })
  const thread = manager.create({ projectPath: project, settings, text: 'first' })
  expect(released).toBe(0)
  await manager.revokeProjectClaudeSetup(project,
    { claudeHooks: false, claudeMcp: false, claudeMcpApproval: 'a'.repeat(64) },
    { claudeHooks: false, claudeMcp: false, claudeMcpApproval: 'b'.repeat(64) })
  expect(released).toBe(1)
  expect(store.events(thread.id).some((entry) => entry.event.kind === 'setup_revoked')).toBe(true)
  await manager.shutdown()
})
