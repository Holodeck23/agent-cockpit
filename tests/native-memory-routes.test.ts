import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSession } from '../server/agents/types.ts'
import { claudeProjectSlug } from '../server/agents/setup/claude-inventory.ts'
import { startServer, type RunningServer } from '../server/start.ts'
import type { LaunchRequest, Launcher } from '../server/threads/manager.ts'

// W13 U5e end to end: choose the CLI default profile's memory for a project, and that project's next
// Claude conversation launches with a private copy of it. Requests name accounts, never paths, and
// nothing returned names a folder or carries memory content.

describe('native memory routes', () => {
  let running: RunningServer | undefined
  afterEach(async () => { await running?.close(); running = undefined })

  const start = async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-memory-routes-')))
    const defaultProfile = join(dir, 'default-claude'), project = join(dir, 'project')
    mkdirSync(project, { recursive: true })
    const memory = join(defaultProfile, 'projects', claudeProjectSlug(project), 'memory')
    const launches: LaunchRequest[] = []
    const launcher: Launcher = (request, onEvent) => {
      launches.push(request)
      let alive = true
      const session: AgentSession = { agent: 'claude', send: () => onEvent({ kind: 'result', ok: true }), respondApproval: () => undefined, interrupt: () => undefined,
        close: () => { alive = false; onEvent({ kind: 'exit', code: 0 }); return Promise.resolve() }, alive: () => alive }
      return session
    }
    running = await startServer({ port: 0, webDist: dir, stateRoot: join(dir, 'state'), claudeDefaultProfileDir: defaultProfile, launchers: { claude: launcher } })
    const call = async (path: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const res = await fetch(`${running!.url}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, body: await res.json() }
    }
    await call('/api/projects', { path: project, pinned: true })
    const projectId = (await call('/api/projects')).body.data.find((p: { path: string }) => p.path === project).projectId as string
    return { dir, project, projectId, memory, launches, call }
  }

  it('selects default-profile memory without paths, and the next conversation loads a copy', async () => {
    const s = await start()
    const empty = await s.call(`/api/projects/${s.projectId}/native-memory`)
    expect(empty.body.data).toMatchObject({ selection: null, sources: [{ accountId: 'default-claude', available: false }] })
    mkdirSync(s.memory, { recursive: true })
    writeFileSync(join(s.memory, 'MEMORY.md'), '# W13 fictional route marker\n')
    const chosen = await s.call(`/api/projects/${s.projectId}/native-memory`, { sourceAccountId: 'default-claude' })
    expect(chosen.status).toBe(200)
    expect(chosen.body.data.selection).toMatchObject({ sourceAccountId: 'default-claude', destinationAccountId: 'default-claude', writePolicy: 'managed-auto', fileCount: 1 })
    const listed = JSON.stringify((await s.call(`/api/projects/${s.projectId}/native-memory`)).body)
    expect(listed).not.toContain(s.dir)
    expect(listed).not.toContain('fictional route marker')
    expect(JSON.parse(listed).data.selection.current).toBe(true)

    await s.call('/api/threads', { projectPath: s.project, text: 'hello', settings: { agent: 'claude', hooksSetup: 'off', mcpSetup: 'off' } })
    const directory = s.launches.at(-1)?.nativeMemoryDirectory
    expect(directory).toBeTruthy()
    expect(directory).not.toBe(s.memory)
    expect(readFileSync(join(directory!, 'MEMORY.md'), 'utf8')).toContain('fictional route marker')

    const revoked = await s.call(`/api/projects/${s.projectId}/native-memory/revoke`, { selectionId: chosen.body.data.selection.id })
    expect(revoked.body.data).toEqual({ revoked: true })
    await s.call('/api/threads', { projectPath: s.project, text: 'after revoke', settings: { agent: 'claude', hooksSetup: 'off', mcpSetup: 'off' } })
    expect(s.launches.at(-1)?.nativeMemoryDirectory).toBeUndefined()
  })

  it('refuses a source that is not on offer, and a stale replacement', async () => {
    const s = await start()
    expect((await s.call(`/api/projects/${s.projectId}/native-memory`, { sourceAccountId: 'someone-else' })).status).toBe(400)
    mkdirSync(s.memory, { recursive: true })
    writeFileSync(join(s.memory, 'MEMORY.md'), '# x\n')
    expect((await s.call(`/api/projects/${s.projectId}/native-memory`, { sourceAccountId: 'default-claude' })).status).toBe(200)
    // A second choice without naming the current one is a stale review.
    expect((await s.call(`/api/projects/${s.projectId}/native-memory`, { sourceAccountId: 'default-claude' })).status).toBe(409)
    expect((await s.call('/api/projects/not-a-project/native-memory')).status).toBe(404)
  })

  it('says when the chosen memory changed after it was chosen', async () => {
    const s = await start()
    mkdirSync(s.memory, { recursive: true })
    writeFileSync(join(s.memory, 'MEMORY.md'), '# before\n')
    await s.call(`/api/projects/${s.projectId}/native-memory`, { sourceAccountId: 'default-claude' })
    writeFileSync(join(s.memory, 'MEMORY.md'), '# after the CLI wrote to it\n')
    const listed = (await s.call(`/api/projects/${s.projectId}/native-memory`)).body.data
    expect(listed.selection.current).toBe(false)
    expect(JSON.stringify(listed)).not.toContain(s.dir)
  })
})
