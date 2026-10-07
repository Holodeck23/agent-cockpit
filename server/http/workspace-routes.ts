import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { WorkspaceStore } from '../projects/workspaces.ts'
import { LifecycleRefusalError, type LifecycleRefusal, type WorktreeLifecycle } from '../projects/worktree-lifecycle.ts'
import { WORKTREE_NAME_MAX, WorktreeRefusalError, type WorktreeRefusal, type WorktreeService } from '../projects/worktrees.ts'
import { HttpError, parseBody, readJson, sendJson } from './json.ts'

// Workspaces (M1, W12.2; INTERFACES §4): desktop only. The router refuses the phone before this
// runs. Creating a worktree is an explicit request from the Cockpit window, never an MCP tool.
//   GET  /api/projects/:id/workspaces              registered workspaces, revision, interrupted creates
//   GET  /api/projects/:id/workspaces/preflight    primary HEAD/branch and how many uncommitted files stay behind
//   POST /api/projects/:id/workspaces              { name, base?, branch? } → the new worktree workspace
//   POST /api/workspace-operations/:id/recover     register an interrupted create Git completed exactly
//   POST /api/workspace-operations/:id/dismiss     forget an interrupted create; Git is left as it is
//   GET  /api/workspaces/:id/removal               what removing it would lose, what blocks it (W12.4)
//   POST /api/workspaces/:id/remove                { fingerprint } → normal Git removal of a clean, merged, idle worktree
//   POST /api/workspaces/:id/archive               out of use, folder kept exactly as it is
//   POST /api/workspaces/:id/restore               an archived worktree back in use
//   POST /api/workspaces/:id/forget                a worktree whose folder is gone stops being offered (no prune)

export const isWorkspaceRoute = (parts: readonly string[]): boolean =>
  (parts[1] === 'projects' && parts[3] === 'workspaces') || parts[1] === 'workspace-operations' || parts[1] === 'workspaces'

/** What the person reads when removing, archiving or restoring is refused. */
export function describeLifecycleRefusal(refusal: LifecycleRefusal): string {
  switch (refusal.code) {
    case 'unknown-workspace': return 'Unknown workspace'
    case 'not-a-worktree': return 'The main checkout cannot be removed or archived.'
    case 'not-active': return `This worktree is already ${refusal.lifecycle}.`
    case 'blocked': return refusal.blockers.join(' ')
    case 'unique-work': {
      const { changed, untracked, ignored, commits } = refusal.unique
      const parts = [
        changed ? `${changed} changed file${changed === 1 ? '' : 's'}` : '', untracked ? `${untracked} untracked file${untracked === 1 ? '' : 's'}` : '',
        ignored ? `${ignored} ignored file${ignored === 1 ? '' : 's'}` : '', commits ? `${commits} commit${commits === 1 ? '' : 's'} on no other branch` : '',
      ].filter(Boolean)
      return `Removing it would lose ${parts.join(', ')}. Keep it, or archive it as it is.`
    }
    case 'stale': return refusal.detail
    case 'not-restorable': return `It cannot be restored: ${refusal.detail}`
    case 'not-missing': return 'Its folder is still there. Remove or archive it instead.'
    case 'git-failed': return `Git did not remove it: ${refusal.detail}`
  }
}

const removeSchema = z.object({ fingerprint: z.string().min(8).max(64) })

/** What the person reads when a create is refused: the prerequisite, never a raw Git error alone. */
export function describeRefusal(refusal: WorktreeRefusal): string {
  switch (refusal.code) {
    case 'unknown-project': return 'Unknown project'
    case 'not-git': return 'This folder is not a Git repository. Worktrees need Git.'
    case 'unborn': return 'This repository has no commits yet. Make a first commit, then create a worktree.'
    case 'operation-in-progress': return `A Git ${refusal.operation} is in progress in this project. Finish or abort it first.`
    case 'conflicted': return 'This project has unresolved merge conflicts. Resolve them first.'
    case 'invalid-name': return `Give the worktree a name of up to ${WORKTREE_NAME_MAX} characters.`
    case 'invalid-ref': return `Git does not know a commit called "${refusal.ref}".`
    case 'invalid-branch': return `"${refusal.branch}" is not a valid Git branch name.`
    case 'branch-exists': return refusal.checkedOutAt
      ? `Branch ${refusal.branch} already exists and is checked out at ${refusal.checkedOutAt}. Choose another branch name.`
      : `Branch ${refusal.branch} already exists. Choose another branch name.`
    case 'name-taken': return 'This project already has a worktree with that name.'
    case 'path-exists': return 'Cockpit could not find a free folder name beside the project.'
    case 'git-failed': return `Git could not create the worktree: ${refusal.detail}`
    case 'not-verified': return `Git did not report the worktree Cockpit asked for (${refusal.detail}). Nothing was registered; check the interrupted create.`
    case 'unknown-operation': return 'Unknown worktree operation'
    case 'not-recoverable': return `This create cannot be registered: ${refusal.detail}`
  }
}

const createSchema = z.object({
  name: z.string().max(WORKTREE_NAME_MAX * 4),
  base: z.string().trim().min(1).max(256).optional(),
  branch: z.string().trim().min(1).max(200).optional(),
})

export async function handleWorkspaceRoute(
  req: IncomingMessage, res: ServerResponse, parts: readonly string[], workspaces: WorkspaceStore, worktrees: WorktreeService,
  knownProject: (projectId: string) => boolean, lifecycle?: WorktreeLifecycle,
): Promise<void> {
  const method = req.method ?? 'GET'
  try {
    if (parts[1] === 'workspaces') {
      const id = parts[2] ?? ''
      const workspace = workspaces.get(id)
      if (!lifecycle || !workspace || !knownProject(workspace.projectId) || parts.length !== 4) throw new HttpError(404, 'Not found')
      const action = parts[3]
      if (method === 'GET' && action === 'removal') { sendJson(res, 200, { data: await lifecycle.removalCheck(id) }); return }
      if (method !== 'POST') throw new HttpError(404, 'Not found')
      if (action === 'remove') {
        const { fingerprint } = parseBody(removeSchema, await readJson(req))
        sendJson(res, 200, { data: { workspace: await lifecycle.remove(id, fingerprint) } })
        return
      }
      if (action === 'archive') { sendJson(res, 200, { data: { workspace: await lifecycle.archive(id) } }); return }
      if (action === 'restore') { sendJson(res, 200, { data: { workspace: await lifecycle.restore(id) } }); return }
      if (action === 'forget') { sendJson(res, 200, { data: { workspace: await lifecycle.forget(id) } }); return }
      throw new HttpError(404, 'Not found')
    }
    if (parts[1] === 'workspace-operations') {
      const id = parts[2] ?? ''
      if (method === 'POST' && parts.length === 4 && parts[3] === 'recover') { sendJson(res, 200, { data: { workspace: await worktrees.recover(id) } }); return }
      if (method === 'POST' && parts.length === 4 && parts[3] === 'dismiss') { sendJson(res, 200, { data: { operation: worktrees.dismiss(id) } }); return }
      throw new HttpError(404, 'Not found')
    }
    const projectId = parts[2] ?? ''
    if (!knownProject(projectId)) throw new HttpError(404, 'Unknown project')
    if (method === 'GET' && parts.length === 4) {
      const { revision } = workspaces.list()
      // What Git says about each registered worktree, read now: a restart therefore always sees reality (W12-14).
      const health = lifecycle ? await lifecycle.health(projectId) : { worktrees: {}, unregistered: [] }
      sendJson(res, 200, { data: { revision, workspaces: workspaces.forProject(projectId), pending: await worktrees.pending(projectId), health: health.worktrees, unregistered: health.unregistered } })
      return
    }
    if (method === 'GET' && parts.length === 5 && parts[4] === 'preflight') { sendJson(res, 200, { data: await worktrees.preflight(projectId) }); return }
    if (method === 'POST' && parts.length === 4) {
      const body = parseBody(createSchema, await readJson(req))
      sendJson(res, 201, { data: { workspace: await worktrees.create(projectId, body) } })
      return
    }
    throw new HttpError(404, 'Not found')
  } catch (error) {
    if (error instanceof LifecycleRefusalError) {
      sendJson(res, error.refusal.code === 'unknown-workspace' ? 404 : 409, { error: describeLifecycleRefusal(error.refusal), refusal: error.refusal })
      return
    }
    if (!(error instanceof WorktreeRefusalError)) throw error
    const status = error.refusal.code === 'unknown-project' || error.refusal.code === 'unknown-operation' ? 404 : 409
    sendJson(res, status, { error: describeRefusal(error.refusal), refusal: error.refusal })
  }
}
