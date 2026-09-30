import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildClaudeArgs } from '../server/agents/claude/flags.ts'
import type { AgentSession } from '../server/agents/types.ts'
import { COCKPIT_GUIDANCE } from '../server/mcp/sessions.ts'
import { createProjectStore } from '../server/projects/store.ts'
import { createThreadManager, instructionsFor, projectInstructionsBlock, type LaunchRequest, type Launcher } from '../server/threads/manager.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'

const newRoot = (): string => mkdtempSync(join(tmpdir(), 'cockpit-instructions-'))

describe('project instructions in the store', () => {
  it('loads old records without instructions and keeps name, colour and pinning when they are added', () => {
    const root = newRoot()
    writeFileSync(join(root, 'projects.json'), JSON.stringify([
      { path: '/work/bakery', name: 'Bakery', color: 'pink', pinned: true, lastOpenedAt: '2026-09-01T10:00:00.000Z' },
    ]))
    const projects = createProjectStore(root)
    expect(projects.list()[0]?.instructions).toBeUndefined()
    const updated = projects.open('/work/bakery', { instructions: '  Use pnpm.  ' })
    expect(updated).toMatchObject({ name: 'Bakery', color: 'pink', pinned: true, instructions: 'Use pnpm.', instructionsRevision: 1 })
  })

  it('bumps the revision only when the text changes, and clears on empty', () => {
    const projects = createProjectStore(newRoot())
    projects.open('/p', { instructions: 'A' })
    expect(projects.open('/p', { instructions: ' A ' }).instructionsRevision).toBe(1)
    expect(projects.open('/p', {}).instructionsRevision).toBe(1)
    expect(projects.open('/p', { instructions: 'B' }).instructionsRevision).toBe(2)
    const cleared = projects.open('/p', { instructions: '' })
    expect(cleared.instructions).toBeUndefined()
    expect(cleared.instructionsRevision).toBe(3)
  })
})

describe('instruction block', () => {
  const base: LaunchRequest = { cwd: '/p', settings: threadSettingsSchema.parse({}) }

  it('puts guidance, project instructions and a handoff in that order, each once', () => {
    const cockpit = { command: 'node', args: [], env: {}, secretEnv: {} }
    const text = instructionsFor({ ...base, cockpit, projectInstructions: 'Use pnpm.', seed: 'HANDOFF' }) ?? ''
    expect(text.indexOf(COCKPIT_GUIDANCE)).toBe(0)
    expect(text.split('Use pnpm.').length).toBe(2)
    expect(text.indexOf('Use pnpm.')).toBeLessThan(text.indexOf('HANDOFF'))
    expect(text).toContain('they do not change your permissions')
  })

  it('adds nothing when a project has no instructions', () => {
    expect(instructionsFor(base)).toBeUndefined()
  })

  it('fits the largest instructions plus a full handoff into Claude\'s appended prompt', () => {
    const big = instructionsFor({ ...base, projectInstructions: 'x'.repeat(8000), seed: 'y'.repeat(25_000) })
    expect(() => buildClaudeArgs({ cwd: '/p', permissionMode: 'manual', useHooks: false, appendSystemPrompt: big })).not.toThrow()
  })
})

describe('instructions reach sessions', () => {
  function recordingLauncher(requests: LaunchRequest[]): Launcher {
    return (request, onEvent) => {
      requests.push(request)
      let alive = true
      const session: AgentSession = {
        agent: request.settings.agent,
        send: () => undefined,
        respondApproval: () => undefined,
        interrupt: () => undefined,
        close: () => { alive = false; onEvent({ kind: 'exit', code: 0 }); return Promise.resolve() },
        alive: () => alive,
      }
      return session
    }
  }

  it('gives each project its own instructions, records the revision, and applies edits at the next start', async () => {
    const root = newRoot()
    const projects = createProjectStore(root)
    projects.open('/work/a', { instructions: 'Project A rules' })
    projects.open('/work/b', {})
    const requests: LaunchRequest[] = []
    const launcher = recordingLauncher(requests)
    const store = createThreadStore(root)
    const manager = createThreadManager(store, {
      launchers: { claude: launcher, codex: launcher },
      instructions: (path) => {
        const p = projects.list().find((x) => x.path === path)
        return p?.instructions ? { text: p.instructions, revision: p.instructionsRevision ?? 0 } : undefined
      },
    })
    const settings = threadSettingsSchema.parse({})
    const a = manager.create({ projectPath: '/work/a', settings, text: 'hi' })
    manager.create({ projectPath: '/work/b', settings, text: 'hi' })
    expect(requests[0]?.projectInstructions).toBe('Project A rules')
    expect(requests[1]?.projectInstructions).toBeUndefined()
    expect(store.get(a.id)?.instructionsRevision).toBe(1)

    // An edit does not touch the running session…
    projects.open('/work/a', { instructions: 'Project A rules, v2' })
    manager.send(a.id, 'again')
    expect(requests).toHaveLength(2)
    expect(store.get(a.id)?.instructionsRevision).toBe(1)

    // …but the next start (here, after the process exits) resumes with the new revision.
    const live = requests.length
    await manager.shutdown()
    manager.send(a.id, 'after restart')
    expect(requests.length).toBe(live + 1)
    expect(requests.at(-1)).toMatchObject({ projectInstructions: 'Project A rules, v2', resume: a.sessionId })
    expect(store.get(a.id)?.instructionsRevision).toBe(2)

    // A switch (after the turn ends) starts fresh with the current instructions and the handoff.
    await manager.shutdown()
    manager.switchAgent(a.id, threadSettingsSchema.parse({ agent: 'codex' }))
    manager.send(a.id, 'on codex')
    expect(requests.at(-1)?.projectInstructions).toBe('Project A rules, v2')
    expect(requests.at(-1)?.seed).toContain('after restart')
  })
})
