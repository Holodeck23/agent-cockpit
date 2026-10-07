import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { createBranch, GitError, gitState, pushBranch, switchBranch } from '../git/branches.ts'
import type { ProjectStore } from '../projects/store.ts'
import type { ThreadManager } from '../threads/manager.ts'
import { HttpError, parseBody, readJson, sendJson } from './json.ts'
import { findCommit } from '../git/commits.ts'
import { isBusy } from '../threads/status.ts'
import { baseFile, fileDiff, listChanges } from '../git/changes.ts'
import type { RunObservationStore } from '../runs/observations.ts'
import { runChanges } from '../runs/run-changes.ts'
import type { WorkspaceScope } from './workspace-scope.ts'

// /api/git: the composer's branch pill. Reads work everywhere; changes are Mac-only,
// and switching or creating waits until no conversation in the project is mid-turn.

// A workspace by ID, or (legacy) a project by path, which means its primary workspace.
const projectBody = z.object({ projectPath: z.string().min(1).max(1000).optional(), workspaceId: z.uuid().optional() })
const branchBody = projectBody.extend({ branch: z.string().min(1).max(250), threadId: z.string().min(1).max(80).optional() })

export interface GitDeps {
  readonly projects: ProjectStore
  readonly manager: ThreadManager
  readonly scope: WorkspaceScope
  readonly runs?: RunObservationStore
  readonly observing?: (runId: string) => boolean
}

/**
 * Conversations in this project that are starting, running a turn or waiting on an approval. With
 * `workspaceId` (and how to tell a conversation's workspace), only those working in that workspace:
 * a branch change in one worktree does not wait for work in another.
 */
export function busyConversations(manager: ThreadManager, projectPath: string, workspaceId?: string, currentOf?: WorkspaceScope['currentOf']): string[] {
  return manager.summaries()
    .filter((s) => s.meta.projectPath === projectPath && isBusy(s.status) && (!workspaceId || !currentOf || currentOf(s.meta) === workspaceId))
    .map((s) => s.meta.title)
}

export async function handleGitRoute(req: IncomingMessage, res: ServerResponse, url: URL, parts: readonly string[], deps: GitDeps, viaPhone: boolean): Promise<void> {
  const method = req.method ?? 'GET'
  const action = parts[2]
  const at = (query: URLSearchParams) => deps.scope.resolve(query.get('projectPath') ?? undefined, query.get('workspaceId') ?? undefined)
  const busy = (where: { projectPath: string; workspaceId?: string }): string[] => busyConversations(deps.manager, where.projectPath, where.workspaceId, deps.scope.currentOf)

  try {
    if (method === 'GET' && !action) {
      const where = at(url.searchParams)
      sendJson(res, 200, { data: { ...(await gitState(where.cwd)), busy: busy(where) } })
      return
    }
    // A commit named in a reply: confirm it exists here and give its web page, if there is one.
    if (method === 'GET' && action === 'commit') {
      const where = at(url.searchParams)
      const commit = await findCommit(where.cwd, url.searchParams.get('hash') ?? '')
      if (!commit) throw new HttpError(404, 'Not a commit in this project')
      sendJson(res, 200, { data: commit })
      return
    }
    // J4: the workspace's uncommitted changes, and one changed file's diff. Reads, so the phone may too.
    if (method === 'GET' && action === 'changes') {
      sendJson(res, 200, { data: await listChanges(at(url.searchParams).cwd) })
      return
    }
    if (method === 'GET' && action === 'diff') {
      sendJson(res, 200, { data: await fileDiff(at(url.searchParams).cwd, url.searchParams.get('path') ?? '') })
      return
    }
    // One run's before/after observations, compared. The conversation's folder must be open.
    if (method === 'GET' && action === 'run') {
      const threadId = url.searchParams.get('threadId') ?? ''
      const runId = url.searchParams.get('runId') ?? ''
      const thread = deps.manager.summaries().find((s) => s.meta.id === threadId)
      if (!thread) throw new HttpError(404, 'Unknown conversation')
      deps.scope.resolve(thread.meta.projectPath, undefined)
      if (!/^[A-Za-z0-9-]{1,80}$/.test(runId)) throw new HttpError(400, 'Not a run ID')
      const record = deps.runs?.get(runId)
      if (record && record.threadId !== threadId) throw new HttpError(404, 'That run is not in this conversation')
      sendJson(res, 200, { data: runChanges(runId, record, isBusy(thread.status) || Boolean(deps.observing?.(runId))) })
      return
    }
    // The base revision's copy of a changed path: the read-only historical view of a left-side line.
    if (method === 'GET' && action === 'base') {
      sendJson(res, 200, { data: await baseFile(at(url.searchParams).cwd, url.searchParams.get('path') ?? '') })
      return
    }
    if (method !== 'POST') throw new HttpError(404, 'Not found')
    if (viaPhone) throw new HttpError(403, 'Branches can only be changed on the Mac')

    if (action === 'push') {
      const body = parseBody(projectBody, await readJson(req))
      const where = deps.scope.resolve(body.projectPath, body.workspaceId)
      const pushed = await pushBranch(where.cwd)
      sendJson(res, 200, { data: { ...pushed.state, busy: busy(where), pushedTo: pushed.to } })
      return
    }
    if (action === 'switch' || action === 'create') {
      const body = parseBody(branchBody, await readJson(req))
      const where = deps.scope.resolve(body.projectPath, body.workspaceId)
      const { branch, threadId } = body
      const working = busy(where)
      if (working.length) throw new HttpError(409, `Wait until no conversation in this ${where.workspaceId && where.cwd !== where.projectPath ? 'workspace' : 'project'} is working (${working.join(', ')})`)
      const from = (await gitState(where.cwd)).branch
      const state = action === 'switch' ? await switchBranch(where.cwd, branch) : await createBranch(where.cwd, branch)
      // The conversations working in this workspace learn about it in their transcripts (B5); a branch belongs to one workspace.
      if (from && state.branch && from !== state.branch) deps.manager.noteBranchChange(where.projectPath, from, state.branch, threadId, where.workspaceId)
      sendJson(res, 200, { data: { ...state, busy: [] } })
      return
    }
    throw new HttpError(404, 'Not found')
  } catch (error) {
    if (error instanceof GitError) throw new HttpError(409, error.message)
    throw error
  }
}
