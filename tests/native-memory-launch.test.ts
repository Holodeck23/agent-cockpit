import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNativeMemoryProvider, nativeMemoryScopes, removeNativeMemoryOverlays } from '../server/agents/setup/native-memory-launch.ts'
import { createNativeMemorySelectionStore } from '../server/agents/setup/native-memory-selection.ts'
import { createThreadManager, type LaunchRequest } from '../server/threads/manager.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'

// W13 U5d: a conversation's selected native memory reaches its Claude session as a private copy of the
// reviewed revision, reused across that conversation's sessions so provider writes survive. Any drift
// in the selection, its source or the account stops the launch instead of running without it.

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-memory-launch-')))
  const profile = join(root, 'profile'), sourceDir = join(profile, 'projects', 'p', 'memory'), project = join(root, 'project')
  mkdirSync(sourceDir, { recursive: true }); mkdirSync(project)
  writeFileSync(join(sourceDir, 'MEMORY.md'), '# W13 fictional memory marker\n')
  const selections = createNativeMemorySelectionStore(join(root, 'state'))
  const provider = createNativeMemoryProvider({ selections, overlayRoot: join(root, 'overlays') })
  const choose = (scope: { projectPath: string; threadId?: string; workspaceId?: string }, accountId = 'acct-a', generation = 1, replacing?: string) =>
    selections.select({ scope, destinationAccountId: accountId, destinationGeneration: generation, sourceAccountId: accountId,
      sourceRoot: profile, sourceDir, writePolicy: 'managed-auto' }, replacing)
  const launch = (threadId: string, accountId = 'acct-a', accountGeneration = 1) =>
    provider({ threadId, projectPath: project, accountId, accountGeneration })
  return { root, profile, sourceDir, project, selections, provider, choose, launch }
}

describe('native memory at launch (W13 U5d)', () => {
  it('loads nothing without a selection, and orders scopes thread, workspace, project', () => {
    const f = fixture()
    expect(f.launch(randomUUID())).toBeUndefined()
    const threadId = randomUUID(), workspaceId = randomUUID()
    expect(nativeMemoryScopes({ threadId, projectPath: f.project, workspaceId })).toEqual([
      { projectPath: f.project, threadId }, { projectPath: f.project, workspaceId }, { projectPath: f.project }])
  })

  it('copies the reviewed revision into a private overlay and reuses it, keeping provider writes', () => {
    const f = fixture()
    f.choose({ projectPath: f.project })
    const threadId = randomUUID()
    const first = f.launch(threadId)!
    expect(readFileSync(join(first.directory, 'MEMORY.md'), 'utf8')).toContain('W13 fictional memory marker')
    expect(lstatSync(first.directory).mode & 0o077).toBe(0)
    // The provider writes new memory in its overlay; the next session of this conversation sees it.
    writeFileSync(join(first.directory, 'MEMORY.md'), '# provider wrote this\n')
    const resumed = f.launch(threadId)!
    expect(resumed.directory).toBe(first.directory)
    expect(readFileSync(join(resumed.directory, 'MEMORY.md'), 'utf8')).toBe('# provider wrote this\n')
    // The source is untouched, and another conversation starts from the reviewed revision.
    expect(readFileSync(join(f.sourceDir, 'MEMORY.md'), 'utf8')).toContain('W13 fictional memory marker')
    const other = f.launch(randomUUID())!
    expect(other.directory).not.toBe(first.directory)
    expect(readFileSync(join(other.directory, 'MEMORY.md'), 'utf8')).toContain('W13 fictional memory marker')
  })

  it('prefers a thread selection over the project one', () => {
    const f = fixture()
    const threadId = randomUUID()
    const project = f.choose({ projectPath: f.project })
    const thread = f.choose({ projectPath: f.project, threadId })
    expect(f.launch(threadId)?.selectionId).toBe(thread.id)
    expect(f.launch(randomUUID())?.selectionId).toBe(project.id)
  })

  it('gives another account nothing, but stops the same account at a new generation or an edited source', () => {
    const f = fixture()
    f.choose({ projectPath: f.project })
    expect(f.launch(randomUUID(), 'acct-b')).toBeUndefined()
    expect(() => f.launch(randomUUID(), 'acct-a', 2)).toThrow('Native memory selection belongs to a different account generation')
    writeFileSync(join(f.sourceDir, 'MEMORY.md'), 'edited after review')
    expect(() => f.launch(randomUUID())).toThrow('Your Claude memory changed since it was chosen for this project')
  })

  it('removes a deleted conversation\'s overlays, provider writes included, and nothing of another', () => {
    const f = fixture()
    f.choose({ projectPath: f.project })
    const gone = randomUUID(), kept = randomUUID()
    const first = f.launch(gone)!, other = f.launch(kept)!
    writeFileSync(join(first.directory, 'provider-note.md'), 'written by the provider\n')
    removeNativeMemoryOverlays(join(f.root, 'overlays'), gone)
    expect(existsSync(join(f.root, 'overlays', gone))).toBe(false)
    expect(existsSync(other.directory)).toBe(true)
    expect(readFileSync(join(f.sourceDir, 'MEMORY.md'), 'utf8')).toContain('W13 fictional memory marker')
    // Not a conversation identity: nothing is touched.
    removeNativeMemoryOverlays(join(f.root, 'overlays'), '..')
    expect(existsSync(other.directory)).toBe(true)
  })

  it('removes a link in a conversation\'s place without following it', () => {
    const f = fixture()
    const threadId = randomUUID(), outside = join(f.root, 'outside')
    mkdirSync(outside); writeFileSync(join(outside, 'keep.md'), 'not Cockpit\'s\n')
    mkdirSync(join(f.root, 'overlays'))
    symlinkSync(outside, join(f.root, 'overlays', threadId))
    removeNativeMemoryOverlays(join(f.root, 'overlays'), threadId)
    expect(existsSync(join(f.root, 'overlays', threadId))).toBe(false)
    expect(readFileSync(join(outside, 'keep.md'), 'utf8')).toBe('not Cockpit\'s\n')
  })

  it('rechecks before later input: a replaced or revoked selection stops the running session', () => {
    const f = fixture()
    const first = f.choose({ projectPath: f.project })
    const launched = f.launch(randomUUID())!
    expect(() => launched.validate()).not.toThrow()
    const second = f.choose({ projectPath: f.project }, 'acct-a', 1, first.id)
    expect(() => launched.validate()).toThrow('Native memory selection changed. Start the conversation again to use the current choice.')
    const relaunched = f.launch(randomUUID())!
    f.selections.revoke({ projectPath: f.project }, second.id)
    expect(() => relaunched.validate()).toThrow('Native memory selection changed')
  })
})

describe('thread manager with native memory (W13 U5d)', () => {
  const sessionStub = { agent: 'claude' as const, alive: () => true, send: () => undefined,
    interrupt: () => undefined, respondApproval: () => undefined, close: async () => undefined }

  it('hands the overlay to a Claude launch and chains its recheck into the source validation', async () => {
    const f = fixture()
    const selected = f.choose({ projectPath: f.project })
    const launches: LaunchRequest[] = []
    const manager = createThreadManager(createThreadStore(join(f.root, 'threads')), {
      accounts: { resolve: () => ({ accountId: 'acct-a', generation: 1, label: 'Fixture', env: {} }), describe: () => undefined },
      nativeMemory: f.provider,
      launchers: { claude: (req) => { launches.push(req); return sessionStub } },
    })
    manager.create({ projectPath: f.project, settings: threadSettingsSchema.parse({ agent: 'claude', hooksSetup: 'off', mcpSetup: 'off' }), text: 'hello' })
    expect(launches).toHaveLength(1)
    const directory = launches[0]?.nativeMemoryDirectory
    expect(directory && readFileSync(join(directory, 'MEMORY.md'), 'utf8')).toContain('W13 fictional memory marker')
    expect(() => launches[0]?.validateSources?.()).not.toThrow()
    f.selections.revoke({ projectPath: f.project }, selected.id)
    expect(() => launches[0]?.validateSources?.()).toThrow('Native memory selection changed. Start the conversation again to use the current choice.')
    await manager.shutdown()
  })

  it('removes the conversation\'s overlay on delete, after its session has ended', async () => {
    const f = fixture()
    f.choose({ projectPath: f.project })
    const launches: LaunchRequest[] = []
    const order: string[] = []
    const overlays = join(f.root, 'overlays')
    const manager = createThreadManager(createThreadStore(join(f.root, 'threads')), {
      accounts: { resolve: () => ({ accountId: 'acct-a', generation: 1, label: 'Fixture', env: {} }), describe: () => undefined },
      nativeMemory: f.provider,
      removeNativeMemory: (threadId) => { order.push('removed'); removeNativeMemoryOverlays(overlays, threadId) },
      launchers: { claude: (req) => { launches.push(req); return { ...sessionStub, close: async () => { order.push('closed') } } } },
    })
    const meta = manager.create({ projectPath: f.project, settings: threadSettingsSchema.parse({ agent: 'claude', hooksSetup: 'off', mcpSetup: 'off' }), text: 'hello' })
    const directory = launches[0]?.nativeMemoryDirectory
    expect(directory && existsSync(directory)).toBe(true)
    await manager.remove(meta.id)
    expect(order).toEqual(['closed', 'removed'])
    expect(existsSync(join(overlays, meta.id))).toBe(false)
    await manager.shutdown()
  })

  it('refuses the launch when the selected memory cannot be used, rather than starting without it', async () => {
    const f = fixture()
    f.choose({ projectPath: f.project })
    writeFileSync(join(f.sourceDir, 'MEMORY.md'), 'edited after review')
    const launches: LaunchRequest[] = []
    const manager = createThreadManager(createThreadStore(join(f.root, 'threads')), {
      accounts: { resolve: () => ({ accountId: 'acct-a', generation: 1, label: 'Fixture', env: {} }), describe: () => undefined },
      nativeMemory: f.provider,
      launchers: { claude: (req) => { launches.push(req); return sessionStub } },
    })
    manager.create({ projectPath: f.project, settings: threadSettingsSchema.parse({ agent: 'claude', hooksSetup: 'off', mcpSetup: 'off' }), text: 'blocked' })
    expect(launches).toHaveLength(0)
    await manager.shutdown()
  })
})
