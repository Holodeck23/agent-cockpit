import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSession, NormalizedEvent } from '../server/agents/types.ts'
import { HttpError, sendJson } from '../server/http/json.ts'
import { handleMcpRoute } from '../server/http/mcp-routes.ts'
import { createBrowserAgent, type BrowserHost } from '../server/browser/agent.ts'
import { createBrowserLeases } from '../server/browser/agent-policy.ts'
import { createMcpSessions, type McpGrant } from '../server/mcp/sessions.ts'
import { createProcessRunner, type ProcessRunner } from '../server/processes/runner.ts'
import type { PreviewOpen } from '../server/preview/types.ts'
import { isRefusal, workspaceFolder } from '../server/projects/resolve.ts'
import { createWorkspaceStore, type Workspace } from '../server/projects/workspaces.ts'
import { createWorktreeService } from '../server/projects/worktrees.ts'
import { createCheckRunner } from '../server/results/checks.ts'
import { createResultService } from '../server/results/service.ts'
import { createResultStore } from '../server/results/store.ts'
import { createRunObservationStore, observeRuns } from '../server/runs/observations.ts'
import { createWorkflowRunner } from '../server/workflows/runner.ts'
import { createWorkflowStore } from '../server/workflows/store.ts'
import { createThreadManager, WorkspaceUnavailableError, type Launcher } from '../server/threads/manager.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema, type StoredEvent, type ThreadMeta } from '../server/threads/types.ts'
import type { ThreadManager, ThreadUpdate } from '../server/threads/manager.ts'

// Order 17c, agent side (W12-08): a conversation in a worktree has its tools, processes, checks,
// results and run observations act in the worktree folder, never the primary's.

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' }).trim()

async function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-ws-folders-')))
  const repo = join(base, 'garden')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'input.txt'), 'one\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'first')
  const state = join(base, 'state')
  mkdirSync(state)
  const workspaces = createWorkspaceStore(state)
  workspaces.ensure([repo])
  const { project, workspace: primary } = workspaces.primaryFor(repo)!
  const worktree = await createWorktreeService(state, workspaces).create(project.id, { name: 'Spike' })
  return { base, repo, state, workspaces, primary, worktree, lookup: (id: string) => workspaces.get(id) }
}

describe('workspaceFolder: the one primary/worktree rule', () => {
  it('a primary is the project folder, a worktree its own, and a gone workspace is refused', async () => {
    const s = await setup()
    expect(workspaceFolder(s.lookup, s.repo, undefined)).toEqual({ cwd: s.repo })
    expect(workspaceFolder(s.lookup, s.repo, s.primary.id)).toEqual({ cwd: s.repo, workspaceId: s.primary.id })
    expect(workspaceFolder(s.lookup, s.repo, s.worktree.id)).toEqual({ cwd: s.worktree.cwd, workspaceId: s.worktree.id })
    for (const gone of [randomUUID(), s.worktree.id]) {
      const lookup = (id: string): Workspace | undefined => (id === s.worktree.id ? { ...s.worktree, lifecycle: 'removed' } : undefined)
      const result = workspaceFolder(lookup, s.repo, gone)
      expect(isRefusal(result)).toBe(true)
      expect(JSON.stringify(result)).not.toContain(s.repo)
    }
  })
})

describe('the cockpit MCP grant and processes', () => {
  let server: Server | undefined
  let runner: ProcessRunner | undefined
  afterEach(async () => {
    await runner?.shutdown()
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = undefined; runner = undefined
  })

  it('starts, lists, dedupes and stops per workspace, and previews name the workspace', async () => {
    const s = await setup()
    const sessions = createMcpSessions()
    const processes = createProcessRunner({ graceMs: 300 })
    runner = processes
    const opened: PreviewOpen[] = []
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      handleMcpRoute(req, res, url, url.pathname.split('/').filter(Boolean), { sessions, processes, openUrl: (u) => void opened.push(u), approve: async () => undefined })
        .catch((error: unknown) => sendJson(res, error instanceof HttpError ? error.status : 500, { error: (error as Error).message }))
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp`
    const call = async (grant: McpGrant, path: string, init: { method?: string; body?: unknown } = {}) => {
      const token = sessions.issue(grant)
      const response = await fetch(`${base}${path}`, { method: init.method ?? 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(init.body ? { body: JSON.stringify(init.body) } : {}) })
      return { status: response.status, body: (await response.json()) as { data?: any; error?: string } }
    }
    const inPrimary: McpGrant = { threadId: 't1', projectPath: s.repo, cwd: s.repo, workspaceId: s.primary.id }
    const inWorktree: McpGrant = { threadId: 't2', projectPath: s.repo, cwd: s.worktree.cwd, workspaceId: s.worktree.id }
    const where = `"${process.execPath}" -e "console.log('cwd=' + process.cwd()); setInterval(() => {}, 1000)"`

    const a = await call(inPrimary, '/processes', { method: 'POST', body: { command: where, name: 'dev' } })
    const b = await call(inWorktree, '/processes', { method: 'POST', body: { command: where, name: 'dev' } })
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    // Same name and command in two workspaces: two processes, neither reused.
    expect(b.body.data.reused).toBe(false)
    expect(b.body.data.process.id).not.toBe(a.body.data.process.id)
    expect(a.body.data.process).toMatchObject({ projectPath: s.repo, cwd: s.repo, workspaceId: s.primary.id })
    expect(b.body.data.process).toMatchObject({ projectPath: s.repo, cwd: s.worktree.cwd, workspaceId: s.worktree.id })
    // A repeat in the same workspace is the reuse.
    expect((await call(inWorktree, '/processes', { method: 'POST', body: { command: where, name: 'dev' } })).body.data.reused).toBe(true)

    // It really runs in the worktree folder.
    const id = b.body.data.process.id as string
    let out = ''
    for (let i = 0; i < 100 && !out.includes('cwd='); i++) {
      out = ((await call(inWorktree, `/processes/${id}/output`)).body.data?.lines ?? []).map((l: { text: string }) => l.text).join('\n')
      if (!out.includes('cwd=')) await new Promise((r) => setTimeout(r, 50))
    }
    expect(out).toContain(`cwd=${s.worktree.cwd}`)

    // Each session sees its own workspace's processes, and another workspace's ID does not exist for it.
    expect((await call(inWorktree, '/processes')).body.data.map((p: { id: string }) => p.id)).toEqual([id])
    expect((await call(inPrimary, '/processes')).body.data.map((p: { id: string }) => p.id)).toEqual([a.body.data.process.id])
    expect((await call(inPrimary, `/processes/${id}/output`)).status).toBe(404)
    expect((await call(inPrimary, `/processes/${id}/stop`, { method: 'POST' })).status).toBe(404)

    // The preview open names the worktree; a primary keeps the shape it always had.
    await call(inWorktree, '/preview', { method: 'POST', body: { url: 'http://localhost:5199/' } })
    await call(inPrimary, '/preview', { method: 'POST', body: { url: 'http://localhost:5199/' } })
    expect(opened).toEqual([
      { url: 'http://localhost:5199/', threadId: 't2', projectPath: s.repo, cwd: s.worktree.cwd, workspaceId: s.worktree.id },
      { url: 'http://localhost:5199/', threadId: 't1', projectPath: s.repo, workspaceId: s.primary.id },
    ])
  })
})

describe('the session launch carries the workspace', () => {
  function managerFor(s: Awaited<ReturnType<typeof setup>>) {
    const grants: McpGrant[] = []
    const launcher: Launcher = (_request, onEvent) => ({
      agent: 'claude', send: () => undefined, respondApproval: () => undefined, interrupt: () => undefined,
      close: () => { onEvent({ kind: 'exit', code: 0 }); return Promise.resolve() }, alive: () => true,
    } as AgentSession)
    const store = createThreadStore(join(s.base, 'threads'))
    const manager = createThreadManager(store, {
      launchers: { claude: launcher, codex: launcher }, workspace: s.lookup,
      workspaceFor: (path) => (path === s.repo ? s.primary.id : undefined),
      mcp: (grant) => { grants.push(grant); return { launch: { command: 'x', args: [], secretEnv: {} }, release: () => undefined } },
    })
    return { manager, grants, store, settings: threadSettingsSchema.parse({}) }
  }

  it('gives the session its worktree folder and ID; a primary session its project folder', async () => {
    const s = await setup()
    const { manager, grants, settings } = managerFor(s)
    const here = manager.create({ projectPath: s.repo, settings, text: 'main checkout' })
    const there = manager.create({ projectPath: s.repo, settings, text: 'in the spike', workspaceId: s.worktree.id })
    expect(there.workspaceId).toBe(s.worktree.id)
    expect(grants).toEqual([
      { threadId: here.id, projectPath: s.repo, cwd: s.repo, workspaceId: s.primary.id },
      { threadId: there.id, projectPath: s.repo, cwd: s.worktree.cwd, workspaceId: s.worktree.id },
    ])
  })

  it('refuses to start in a workspace that is not the project\'s or is gone, never using the primary instead', async () => {
    const s = await setup()
    const { manager, store, settings } = managerFor(s)
    const stranger = createWorkspaceStore(join(s.base, 'other-state'))
    mkdirSync(join(s.base, 'other-state'), { recursive: true })
    const otherRepo = join(s.base, 'other'); mkdirSync(otherRepo)
    stranger.ensure([otherRepo])
    const foreign = stranger.primaryFor(otherRepo)!.workspace
    const lookup = (id: string) => (id === foreign.id ? foreign : s.workspaces.get(id))
    const m = createThreadManager(store, { launchers: { claude: () => { throw new Error('must not launch') }, codex: () => { throw new Error('must not launch') } }, workspace: lookup, workspaceFor: (p) => (p === s.repo ? s.primary.id : undefined) })
    expect(() => m.create({ projectPath: s.repo, settings, text: 'x', workspaceId: foreign.id })).toThrow(WorkspaceUnavailableError)
    expect(() => m.create({ projectPath: s.repo, settings, text: 'x', workspaceId: randomUUID() })).toThrow(WorkspaceUnavailableError)
    expect(manager).toBeDefined()
    expect(store.list()).toHaveLength(0)
  })
})

describe('checks and results in a worktree', () => {
  const meta = (s: { repo: string }, workspaceId: string): ThreadMeta => ({
    id: 't1', title: 'Spike it', projectPath: s.repo, workspaceId, settings: { agent: 'claude', permissionMode: 'manual', useHooks: false },
    sessionId: 's1', sessionStarted: true, completed: false, createdAt: '2026-10-05T10:00:00.000Z', updatedAt: '2026-10-05T10:00:00.000Z',
  })
  const events: StoredEvent[] = [
    { ts: '2026-10-05T10:00:01.000Z', event: { kind: 'user_text', text: 'go', runId: 'run-1' } },
    { ts: '2026-10-05T10:00:03.000Z', event: { kind: 'result', ok: true, runId: 'run-1' } },
  ]

  it('runs in the worktree, fingerprints it, and judges freshness against it, not the primary', async () => {
    const s = await setup()
    const store = createResultStore(join(s.base, 'results'))
    const checks = createCheckRunner(store, { graceMs: 300 })
    const record = await checks.start({ runId: 'run-1', threadId: 't1', projectPath: s.repo, workspaceId: s.worktree.id, cwd: s.worktree.cwd, operationId: 'op-1', definition: { command: 'pwd -P; cat input.txt', inputs: ['input.txt'] } })
    await checks.settled(record.id)
    const done = store.get('run-1')!.checks[0]!
    expect(done).toMatchObject({ outcome: 'passed', workspaceId: s.worktree.id, subject: { workspace: s.worktree.cwd } })
    const output = store.readEvidence('run-1', store.get('run-1')!.evidence.find((e) => e.id === done.output!.evidenceId)!)
    expect(output.state === 'ok' ? output.bytes.toString() : '').toContain(s.worktree.cwd)

    const service = createResultService({ store, checks, workspace: s.lookup })
    const fresh = async () => (await service.view(meta(s, s.worktree.id), events, 'run-1', false)).checks[0]!.freshness
    expect(await fresh()).toEqual({ state: 'fresh' })
    // Work in the primary does not make the worktree's check stale.
    writeFileSync(join(s.repo, 'input.txt'), 'edited in the main checkout\n')
    expect(await fresh()).toEqual({ state: 'fresh' })
    // Work in the worktree does.
    writeFileSync(join(s.worktree.cwd, 'input.txt'), 'edited in the spike\n')
    expect(await fresh()).toMatchObject({ state: 'stale' })
  })

  it('the check folder must stay inside the worktree, and a removed workspace reads as unknown, not as the primary', async () => {
    const s = await setup()
    const store = createResultStore(join(s.base, 'results'))
    const checks = createCheckRunner(store, { graceMs: 300 })
    await expect(checks.start({ runId: 'run-1', threadId: 't1', projectPath: s.repo, cwd: s.worktree.cwd, operationId: 'op-2', definition: { command: 'true', cwd: '..' } })).rejects.toThrow(/inside the workspace/)
    const record = await checks.start({ runId: 'run-1', threadId: 't1', projectPath: s.repo, workspaceId: s.worktree.id, cwd: s.worktree.cwd, operationId: 'op-3', definition: { command: 'true' } })
    await checks.settled(record.id)
    const gone = createResultService({ store, checks, workspace: (id) => (id === s.worktree.id ? { ...s.worktree, lifecycle: 'removed' } : s.workspaces.get(id)) })
    const view = await gone.view(meta(s, s.worktree.id), events, 'run-1', false)
    expect(view.checks[0]!.freshness).toMatchObject({ state: 'unknown' })
  })
})

describe('run observations follow the workspace', () => {
  it('observes the worktree and counts only conversations in the same workspace as concurrent', async () => {
    const s = await setup()
    type T = { id: string; title: string; projectPath: string; workspaceId: string }
    const threads: T[] = [
      { id: 't1', title: 'In spike', projectPath: s.repo, workspaceId: s.worktree.id },
      { id: 't2', title: 'In main', projectPath: s.repo, workspaceId: s.primary.id },
      { id: 't3', title: 'Also in spike', projectPath: s.repo, workspaceId: s.worktree.id },
    ]
    const listeners = new Set<(u: ThreadUpdate) => void>()
    const busy = new Set<string>()
    const manager = { subscribe: (l: (u: ThreadUpdate) => void) => { listeners.add(l); return () => listeners.delete(l) },
      summaries: () => threads.map((t) => ({ meta: { ...t }, status: busy.has(t.id) ? 'working' : 'idle' })) } as unknown as ThreadManager
    const emit = (threadId: string, event: NormalizedEvent): void => {
      if (event.kind === 'user_text') busy.add(threadId)
      if (event.kind === 'result') busy.delete(threadId)
      for (const l of listeners) l({ threadId, event, status: busy.has(threadId) ? 'working' : 'idle' } as ThreadUpdate)
    }
    const store = createRunObservationStore(join(s.base, 'runs'))
    const observer = observeRuns(manager, store, undefined, s.lookup)
    emit('t2', { kind: 'user_text', text: 'main work', runId: 'run-main' })
    emit('t1', { kind: 'user_text', text: 'go', runId: 'run-1' })
    await observer.settle()
    writeFileSync(join(s.worktree.cwd, 'spike.txt'), 'new\n')
    writeFileSync(join(s.repo, 'main-only.txt'), 'new\n')
    emit('t2', { kind: 'tool_use', id: 'x', name: 'Write', input: {} })
    emit('t3', { kind: 'tool_use', id: 'y', name: 'Write', input: {} })
    emit('t1', { kind: 'result', ok: true, runId: 'run-1' })
    await observer.settle()
    const run = store.get('run-1')!
    expect(run.after?.files.map((f) => f.path)).toEqual(['spike.txt'])
    expect(run.concurrent).toEqual(['Also in spike'])
  })
})

describe('the conversation\'s browser page', () => {
  it('is created for the workspace folder the session runs in', async () => {
    const folders: string[] = []
    const page = { pageId: 'thread:t1', revision: 1, url: 'about:blank', origin: 'null', title: '' }
    const host = { ensure: async (_key: string, folder: string) => { folders.push(folder); return page }, goto: async () => page, info: () => page } as unknown as BrowserHost
    const agent = createBrowserAgent({ host: () => host, leases: createBrowserLeases(), cockpitPorts: () => [4000], currentRun: () => 'r1', approve: async () => 'allow' })
    const grant: McpGrant = { threadId: 't1', projectPath: '/work/garden', cwd: '/work/garden-worktree-abc123', workspaceId: randomUUID() }
    await agent.handle(grant, 'navigate', { url: 'http://localhost:5173/' }, new AbortController().signal)
    expect(folders).toEqual(['/work/garden-worktree-abc123'])
  })
})

describe('scheduled workflows', () => {
  it('keep running in the primary workspace, named explicitly, with a worktree beside it', async () => {
    const s = await setup()
    const cwds: string[] = []
    const launcher: Launcher = (request, onEvent) => {
      cwds.push(request.cwd)
      return { agent: 'claude', send: () => undefined, respondApproval: () => undefined, interrupt: () => undefined,
        close: () => { onEvent({ kind: 'exit', code: 0 }); return Promise.resolve() }, alive: () => true } as AgentSession
    }
    const threads = createThreadStore(join(s.base, 'threads'))
    const manager = createThreadManager(threads, { launchers: { claude: launcher, codex: launcher }, workspace: s.lookup, workspaceFor: (path) => (path === s.repo ? s.primary.id : undefined) })
    const store = createWorkflowStore(join(s.base, 'workflows'))
    const saved = store.save({ projectPath: s.repo, name: 'nightly', prompt: 'Review the changes', intervalMinutes: 5 })
    const runner = createWorkflowRunner(store, manager, threads, undefined, (path) => (path === s.repo ? s.primary.id : undefined))
    const thread = runner.run(saved.id, 'scheduled')
    expect(thread.workspaceId).toBe(s.primary.id)
    expect(cwds).toEqual([s.repo])
    runner.close()
    await manager.shutdown()
  })
})
