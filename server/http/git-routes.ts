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

// /api/git: the composer's branch pill. Reads work everywhere; changes are Mac-only,
// and switching or creating waits until no conversation in the project is mid-turn.

const projectBody = z.object({ projectPath: z.string().min(1).max(1000) })
const branchBody = projectBody.extend({ branch: z.string().min(1).max(250), threadId: z.string().min(1).max(80).optional() })

export interface GitDeps {
  readonly projects: ProjectStore
  readonly manager: ThreadManager
  readonly runs?: RunObservationStore
}

/** Conversations in this project that are starting, running a turn or waiting on an approval. */
export function busyConversations(manager: ThreadManager, projectPath: string): string[] {
  return manager.summaries()
    .filter((s) => s.meta.projectPath === projectPath && isBusy(s.status))
    .map((s) => s.meta.title)
}

export async function handleGitRoute(req: IncomingMessage, res: ServerResponse, url: URL, parts: readonly string[], deps: GitDeps, viaPhone: boolean): Promise<void> {
  const method = req.method ?? 'GET'
  const action = parts[2]
  const requireOpen = (projectPath: string): void => {
    if (!deps.projects.list().some((project) => project.path === projectPath)) throw new HttpError(404, 'Open this project first')
  }
  const busy = (projectPath: string): string[] => busyConversations(deps.manager, projectPath)

  try {
    if (method === 'GET' && !action) {
      const projectPath = url.searchParams.get('projectPath') ?? ''
      requireOpen(projectPath)
      sendJson(res, 200, { data: { ...(await gitState(projectPath)), busy: busy(projectPath) } })
      return
    }
    // A commit named in a reply: confirm it exists here and give its web page, if there is one.
    if (method === 'GET' && action === 'commit') {
      const projectPath = url.searchParams.get('projectPath') ?? ''
      requireOpen(projectPath)
      const commit = await findCommit(projectPath, url.searchParams.get('hash') ?? '')
      if (!commit) throw new HttpError(404, 'Not a commit in this project')
      sendJson(res, 200, { data: commit })
      return
    }
    // J4: the workspace's uncommitted changes, and one changed file's diff. Reads, so the phone may too.
    if (method === 'GET' && action === 'changes') {
      const projectPath = url.searchParams.get('projectPath') ?? ''
      requireOpen(projectPath)
      sendJson(res, 200, { data: await listChanges(projectPath) })
      return
    }
    if (method === 'GET' && action === 'diff') {
      const projectPath = url.searchParams.get('projectPath') ?? ''
      requireOpen(projectPath)
      sendJson(res, 200, { data: await fileDiff(projectPath, url.searchParams.get('path') ?? '') })
      return
    }
    // One run's before/after observations, compared. The conversation's folder must be open.
    if (method === 'GET' && action === 'run') {
      const threadId = url.searchParams.get('threadId') ?? ''
      const runId = url.searchParams.get('runId') ?? ''
      const thread = deps.manager.summaries().find((s) => s.meta.id === threadId)
      if (!thread) throw new HttpError(404, 'Unknown conversation')
      requireOpen(thread.meta.projectPath)
      if (!/^[A-Za-z0-9-]{1,80}$/.test(runId)) throw new HttpError(400, 'Not a run ID')
      const record = deps.runs?.get(runId)
      if (record && record.threadId !== threadId) throw new HttpError(404, 'That run is not in this conversation')
      sendJson(res, 200, { data: runChanges(runId, record, isBusy(thread.status)) })
      return
    }
    // The base revision's copy of a changed path: the read-only historical view of a left-side line.
    if (method === 'GET' && action === 'base') {
      const projectPath = url.searchParams.get('projectPath') ?? ''
      requireOpen(projectPath)
      sendJson(res, 200, { data: await baseFile(projectPath, url.searchParams.get('path') ?? '') })
      return
    }
    if (method !== 'POST') throw new HttpError(404, 'Not found')
    if (viaPhone) throw new HttpError(403, 'Branches can only be changed on the Mac')

    if (action === 'push') {
      const { projectPath } = parseBody(projectBody, await readJson(req))
      requireOpen(projectPath)
      const pushed = await pushBranch(projectPath)
      sendJson(res, 200, { data: { ...pushed.state, busy: busy(projectPath), pushedTo: pushed.to } })
      return
    }
    if (action === 'switch' || action === 'create') {
      const { projectPath, branch, threadId } = parseBody(branchBody, await readJson(req))
      requireOpen(projectPath)
      const working = busy(projectPath)
      if (working.length) throw new HttpError(409, `Wait until no conversation in this project is working (${working.join(', ')})`)
      const from = (await gitState(projectPath)).branch
      const state = action === 'switch' ? await switchBranch(projectPath, branch) : await createBranch(projectPath, branch)
      // The project's other conversations learn about it in their transcripts (B5).
      if (from && state.branch && from !== state.branch) deps.manager.noteBranchChange(projectPath, from, state.branch, threadId)
      sendJson(res, 200, { data: { ...state, busy: [] } })
      return
    }
    throw new HttpError(404, 'Not found')
  } catch (error) {
    if (error instanceof GitError) throw new HttpError(409, error.message)
    throw error
  }
}
