import type { RecoveryView, resumeRecoveryBody } from '../../server/onboarding/recovery.ts'
import type { Preset } from '../../server/presets/store.ts'
import type { AgentCapabilities } from '../../server/agents/capabilities/types.ts'
import type { OperationKind, OperationView } from '../../server/agents/lifecycle/service.ts'
import type { LatestCheck } from '../../server/agents/lifecycle/latest.ts'
import type { Plan } from '../../server/agents/lifecycle/plans.ts'
import type { AccountView } from '../../server/agents/accounts/types.ts'
import type { SigninView } from '../../server/agents/accounts/service.ts'

export type { AccountView, SigninView }
/** Account profiles (W12.1): the redacted list and which agents can have them. */
export interface AccountsView {
  readonly accounts: readonly AccountView[]
  readonly support: Readonly<Record<string, { readonly profiles: boolean; readonly takesCode?: boolean; readonly reason?: string }>>
}

export interface AgentLifecycleView {
  readonly install: Plan
  readonly update: Plan
  readonly signin: Plan
  readonly latest?: LatestCheck
  readonly skipped?: string
  readonly operations: readonly OperationView[]
}
import type { z } from 'zod'
export type { RecoveryView }
import type { FileListing, FilePreview } from '../../server/files/browser.ts'
import type { BaseFile, Changes, FileDiff, NoRepository } from '../../server/git/changes.ts'
import type { RunChanges } from '../../server/runs/run-changes.ts'
import type { Assessment, CheckDefinition, CheckRecord, EvidenceRecord, ResultRecord } from '../../server/results/types.ts'
import type { DocumentEntry, DocumentMatch } from '../../server/files/documents.ts'
import type { MemoryEntry } from '../../server/memory/store.ts'
import type { SessionSummary } from '../../server/import/sessions.ts'
import { inSpace, spaceOf } from './file-text.ts'
import type { FileSaved } from '../../server/files/editor.ts'
import type { FileSearch, ReferenceCheck } from '../../server/files/search.ts'
import type { Workflow, WorkflowInput } from '../../server/workflows/store.ts'
import type { AgentId, ApprovalBehavior } from '../../server/agents/types.ts'
import type { ProcessInfo, ProcessRead } from '../../server/processes/runner.ts'
import type { Project as StoredProject, ProjectPatch } from '../../server/projects/store.ts'
import type { Workspace } from '../../server/projects/workspaces.ts'
import type { PendingOperation, Preflight, GitWorktree } from '../../server/projects/worktrees.ts'
import type { RemovalCheck, WorktreeHealth } from '../../server/projects/worktree-lifecycle.ts'
import type { MergeOperationView, MergePreflight } from '../../server/projects/merge.ts'
import type { ThreadUpdate } from '../../server/threads/manager.ts'
import type { StoredEvent, ThreadMeta, ThreadSettings, ThreadStatus, ThreadSummary } from '../../server/threads/types.ts'
import type { RemoteStatus } from '../../server/remote/service.ts'
import type { PreviewsStatus } from '../../server/remote/preview/control.ts'
import type { AgentStatus } from '../../server/agents/status.ts'
import type { GitState } from '../../server/git/branches.ts'

export type { AgentCapabilities, LatestCheck, OperationKind, OperationView, Plan }
export type { PreviewsStatus }
export type { AgentStatus, ProcessInfo, ProcessRead, ProjectPatch, RemoteStatus, StoredEvent, ThreadMeta, ThreadSettings, ThreadStatus, ThreadSummary, ThreadUpdate }

/** A project as the list returns it: with the opaque IDs of the project and its primary workspace (absent if identity is unavailable). */
export type Project = StoredProject & { readonly projectId?: string; readonly workspaceId?: string }
export type { PendingOperation, Preflight, Workspace, RemovalCheck, WorktreeHealth, GitWorktree, MergeOperationView, MergePreflight }

/** A project's workspaces: the registered ones (primary first) and creates a crash left unfinished. */
export interface WorkspaceList {
  readonly revision: number; readonly workspaces: readonly Workspace[]; readonly pending: readonly PendingOperation[]
  /** What Git says about each registered worktree that is not removed (W12-14), and worktrees Git has that Cockpit did not make. */
  readonly health?: Readonly<Record<string, WorktreeHealth>>; readonly unregistered?: readonly GitWorktree[]
}

/** Where this page is running: the Mac's own window, or a phone through Tailscale. */
export type PageMode = { mode: 'local' } | { mode: 'remote'; login: string; paired: boolean; notifications: boolean }

export interface ThreadDetail {
  readonly meta: ThreadMeta
  readonly status: ThreadStatus
  readonly events: StoredEvent[]
  /** messages.md on disk: the human-readable transcript. */
  readonly transcriptPath: string
  /** The agent message being streamed right now, if any. */
  readonly streaming: string
  /** Each workspace's live agent: whether it is working, its streamed text, its run (W12-15). */
  readonly runs?: ReadonlyArray<{ readonly workspaceId: string; readonly working: boolean; readonly partial: string; readonly runId?: string }>
}

/** An API refusal; `status` 409 means a conflict the person should resolve. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const payload = (await response.json()) as { data?: T; error?: string }
  if (!response.ok || payload.data === undefined) throw new ApiError(payload.error ?? `Request failed (${response.status})`, response.status)
  return payload.data
}

/** `{ workspaceId }` for a worktree (the route then works in its folder), nothing for the primary (the path alone means it). */
const inWorkspace = (workspaceId?: string): { workspaceId?: string } => (workspaceId ? { workspaceId } : {})

/** The project's branch state plus the conversations that would block a switch. */
export type GitView = GitState & { readonly busy: readonly string[]; readonly pushedTo?: string }


/** An image sent with a message: base64 bytes and the name it had. */
/** An image to send: new bytes, or one this conversation already holds, by its stored name (R8). */
export type MessageImage = { readonly data: string; readonly name?: string } | { readonly stored: string; readonly name?: string }
/** An image a conversation holds, by its stored name. */
export interface StoredImage { readonly file: string; readonly name?: string }
/** randomUUID exists only in secure contexts; without it the host simply gets no operation ID. */
const operationId = (): { operationId?: string } => {
  const id = globalThis.crypto?.randomUUID?.()
  return id ? { operationId: id } : {}
}
const requiredOperationId = (): string => globalThis.crypto?.randomUUID?.() ?? `check-${Date.now()}-${Math.random().toString(36).slice(2)}`

export const api = {
  recentWork: (projectPath: string) => request<RecoveryView>(`/api/recovery?${new URLSearchParams({ projectPath })}`),
  resumeWork: (body: z.infer<typeof resumeRecoveryBody>) => request<ThreadMeta>('/api/recovery', { method: 'POST', body }),
  director: () => request<{ show: boolean }>('/api/onboarding'),
  dismissDirector: () => request<unknown>('/api/onboarding/dismiss', { method: 'POST', body: {} }),
  startDirector: (body: { kind: 'sample' } | { kind: 'project'; projectPath: string }) =>
    request<ThreadMeta>('/api/onboarding/start', { method: 'POST', body }),
  /** Conversations whose messages contain every word of `q`, with an excerpt (Mac only). */
  searchThreads: (q: string) => request<Array<{ id: string; excerpt: string }>>(`/api/threads/search?${new URLSearchParams({ q })}`),
  gitState: (projectPath: string, workspaceId?: string) => request<GitView>(`/api/git?${new URLSearchParams({ projectPath, ...inWorkspace(workspaceId) })}`),
  switchBranch: (projectPath: string, branch: string, threadId?: string, workspaceId?: string) => request<GitView>('/api/git/switch', { method: 'POST', body: { projectPath, branch, threadId, ...inWorkspace(workspaceId) } }),
  createBranch: (projectPath: string, branch: string, threadId?: string, workspaceId?: string) => request<GitView>('/api/git/create', { method: 'POST', body: { projectPath, branch, threadId, ...inWorkspace(workspaceId) } }),
  /** A commit named in a reply: its full hash and web page, or a 404 when it isn't a commit here. */
  gitCommit: (projectPath: string, hash: string, workspaceId?: string) => request<{ hash: string; url?: string }>(`/api/git/commit?${new URLSearchParams({ projectPath, hash, ...inWorkspace(workspaceId) })}`),
  pushBranch: (projectPath: string, workspaceId?: string) => request<GitView>('/api/git/push', { method: 'POST', body: { projectPath, ...inWorkspace(workspaceId) } }),
  /** J4: the workspace's uncommitted changes against HEAD (or an empty base), and one file's bounded diff. */
  gitChanges: (projectPath: string, workspaceId?: string) => request<Changes | NoRepository>(`/api/git/changes?${new URLSearchParams({ projectPath, ...inWorkspace(workspaceId) })}`),
  gitDiff: (projectPath: string, path: string, workspaceId?: string) => request<FileDiff>(`/api/git/diff?${new URLSearchParams({ projectPath, path, ...inWorkspace(workspaceId) })}`),
  /** The base revision's copy of a changed path: the read-only view of a left-side line. */
  gitBase: (projectPath: string, path: string, workspaceId?: string) => request<BaseFile>(`/api/git/base?${new URLSearchParams({ projectPath, path, ...inWorkspace(workspaceId) })}`),
  /** One run's before/after observations, compared (W7-05). */
  gitRun: (threadId: string, runId: string) => request<RunChanges>(`/api/git/run?${new URLSearchParams({ threadId, runId })}`),
  /** Host-observed result evidence for one finished provider turn (pilot 10.1). */
  result: (threadId: string, runId: string) => request<ResultRecord>(`/api/runs/${encodeURIComponent(runId)}/result?${new URLSearchParams({ threadId })}`),
  runCheck: (threadId: string, runId: string, definition: CheckDefinition) =>
    request<CheckRecord>(`/api/runs/${encodeURIComponent(runId)}/checks`, { method: 'POST', body: { threadId, operationId: requiredOperationId(), definition } }),
  cancelCheck: (checkId: string) => request<CheckRecord>(`/api/checks/${encodeURIComponent(checkId)}/cancel`, { method: 'POST', body: {} }),
  captureResultPreview: (threadId: string, runId: string, url: string) =>
    request<EvidenceRecord>(`/api/runs/${encodeURIComponent(runId)}/preview`, { method: 'POST', body: { threadId, url } }),
  assessResultPreview: (threadId: string, runId: string, evidenceId: string, verdict: Assessment['verdict'], note?: string) =>
    request<Assessment>(`/api/runs/${encodeURIComponent(runId)}/assessments`, { method: 'POST', body: { threadId, evidenceId, verdict, note } }),
  resultEvidence: (threadId: string, runId: string, evidenceId: string) =>
    `/api/runs/${encodeURIComponent(runId)}/evidence/${encodeURIComponent(evidenceId)}?${new URLSearchParams({ threadId })}`,
  listFiles: (projectPath: string, path = '', workspaceId?: string) => request<FileListing>(`/api/files?${new URLSearchParams({ projectPath, path, ...inWorkspace(workspaceId) })}`),
  /** A "documents:" path reads from the project's documents; the result keeps the same naming. */
  readFile: async (projectPath: string, tabPath: string, workspaceId?: string) => {
    const { space, path } = spaceOf(tabPath)
    const read = await request<FilePreview>(`/api/files/read?${new URLSearchParams({ projectPath, path, space, ...inWorkspace(workspaceId) })}`)
    return { ...read, path: inSpace(space, read.path) }
  },
  listMemory: (projectPath: string) => request<MemoryEntry[]>(`/api/memory?${new URLSearchParams({ projectPath })}`),
  addMemory: (projectPath: string, scope: 'project' | 'everywhere', text: string) => request<MemoryEntry>('/api/memory', { method: 'POST', body: { projectPath, scope, text } }),
  updateMemory: (id: string, text: string) => request<MemoryEntry>(`/api/memory/${id}`, { method: 'POST', body: { text } }),
  deleteMemory: (id: string) => request<{ removed: string }>(`/api/memory/${id}`, { method: 'DELETE', body: {} }),
  clearMemory: (projectPath: string) => request<{ removed: number }>('/api/memory/clear', { method: 'POST', body: { projectPath } }),
  listImportable: (projectPath: string) => request<ImportableSession[]>(`/api/import?${new URLSearchParams({ projectPath })}`),
  importSession: (projectPath: string, agent: AgentId, sessionId: string) =>
    request<ThreadMeta>('/api/import', { method: 'POST', body: { projectPath, agent, sessionId } }),
  listDocuments: (projectPath: string) => request<DocumentEntry[]>(`/api/documents?${new URLSearchParams({ projectPath })}`),
  documentsFolder: (projectPath: string) => request<{ folder: string; custom: boolean }>(`/api/documents/location?${new URLSearchParams({ projectPath })}`),
  setDocumentsFolder: (projectPath: string, folder: string | null) =>
    request<{ folder: string; copied: string[] }>('/api/documents/location', { method: 'POST', body: { projectPath, folder } }),
  searchDocuments: (projectPath: string, q: string) => request<DocumentMatch[]>(`/api/documents/search?${new URLSearchParams({ projectPath, q })}`),
  markDocument: (projectPath: string, path: string, change: { pinned?: boolean; archived?: boolean }) =>
    request<DocumentEntry[]>('/api/documents/mark', { method: 'POST', body: { projectPath, path, ...change } }),
  /** Renames in place; resolves to the new tab path. */
  renameFile: async (projectPath: string, tabPath: string, name: string, workspaceId?: string) => {
    const { space, path } = spaceOf(tabPath)
    const renamed = await request<{ path: string }>('/api/files/rename', { method: 'POST', body: { projectPath, path, name, space, ...inWorkspace(workspaceId) } })
    return inSpace(space, renamed.path)
  },
  searchFiles: (projectPath: string, q: string, workspaceId?: string) => request<FileSearch>(`/api/files/search?${new URLSearchParams({ projectPath, q, ...inWorkspace(workspaceId) })}`),
  checkReferences: (projectPath: string, text: string, workspaceId?: string) => request<ReferenceCheck[]>('/api/references/check', { method: 'POST', body: { projectPath, text, ...inWorkspace(workspaceId) } }),
  /** `expected` is the version the edit started from; null creates a new file. */
  writeFile: async (projectPath: string, tabPath: string, text: string, expected: string | null, workspaceId?: string) => {
    const { space, path } = spaceOf(tabPath)
    const saved = await request<FileSaved>('/api/files/write', { method: 'PUT', body: { projectPath, path, text, expected, space, ...inWorkspace(workspaceId) } })
    return { ...saved, path: inSpace(space, saved.path) }
  },
  listWorkflows: (projectPath: string) => request<Workflow[]>(`/api/workflows?projectPath=${encodeURIComponent(projectPath)}`),
  saveWorkflow: (body: WorkflowInput, id?: string) => request<Workflow>(id ? `/api/workflows/${id}/save` : '/api/workflows', { method: 'POST', body }),
  runWorkflow: (id: string) => request<ThreadMeta>(`/api/workflows/${id}/run`, { method: 'POST', body: {} }),
  enableWorkflow: (id: string, enabled: boolean) => request<Workflow>(`/api/workflows/${id}/enabled`, { method: 'POST', body: { enabled } }),
  archiveWorkflow: (id: string) => request<Workflow>(`/api/workflows/${id}/archive`, { method: 'POST', body: {} }),
  agents: () => request<AgentStatus[]>('/api/agents'),
  agentCapabilities: (agent: AgentId) => request<AgentCapabilities>(`/api/agents/${agent}/capabilities`),
  refreshAgentCapabilities: (agent: AgentId) => request<AgentCapabilities>(`/api/agents/${agent}/capabilities/refresh`, { method: 'POST', body: {} }),
  agentLifecycle: (agent: AgentId) => request<AgentLifecycleView>(`/api/agents/${agent}/lifecycle`),
  startAgentOperation: (agent: AgentId, kind: OperationKind, body: { acceptInstaller?: string } = {}) => request<OperationView>(`/api/agents/${agent}/${kind}`, { method: 'POST', body }),
  agentOperation: (id: string) => request<OperationView>(`/api/agent-operations/${id}`),
  cancelAgentOperation: (id: string) => request<{ cancelled: boolean }>(`/api/agent-operations/${id}/cancel`, { method: 'POST', body: {} }),
  resumeAgentOperation: (id: string) => request<{ resumed: boolean }>(`/api/agent-operations/${id}/resume`, { method: 'POST', body: {} }),
  sendAgentOperationInput: (id: string, text: string) => request<Record<string, never>>(`/api/agent-operations/${id}/input`, { method: 'POST', body: { text } }),
  checkAgentUpdate: (agent: AgentId) => request<LatestCheck>(`/api/agents/${agent}/updates/check`, { method: 'POST', body: {} }),
  skipAgentVersion: (agent: AgentId, version: string) => request<{ skipped: string }>(`/api/agents/${agent}/updates/skip`, { method: 'POST', body: { version } }),
  /** `refresh` re-reads who the CLI defaults are signed in to (runs their status checks). */
  accounts: (refresh = false) => request<AccountsView>(`/api/accounts${refresh ? '?refresh=1' : ''}`),
  startAccountSignin: (agent: AgentId, label: string) => request<SigninView>('/api/accounts', { method: 'POST', body: { agent, label } }),
  accountSignin: (id: string) => request<SigninView>(`/api/accounts/signins/${id}`),
  /** The code Claude's sign-in page shows; passed straight to the waiting CLI. */
  sendAccountCode: (id: string, text: string) => request<SigninView>(`/api/accounts/signins/${id}/input`, { method: 'POST', body: { text } }),
  cancelAccountSignin: (id: string) => request<{ cancelled: boolean }>(`/api/accounts/signins/${id}/cancel`, { method: 'POST', body: {} }),
  refreshAccount: (id: string) => request<{ account: AccountView; changed: boolean }>(`/api/accounts/${id}/refresh`, { method: 'POST', body: {} }),
  removeAccount: (id: string, moveProjectsToDefault: boolean) => request<{ removed: true; message: string }>(`/api/accounts/${id}/remove`, { method: 'POST', body: { moveProjectsToDefault } }),
  projectAccounts: (projectId: string) => request<{ selection: Record<AgentId, string> }>(`/api/projects/${projectId}/accounts`),
  selectAccount: (projectId: string, agent: AgentId, accountId: string) =>
    request<{ selection: Record<AgentId, string> }>(`/api/projects/${projectId}/accounts/${agent}`, { method: 'POST', body: { accountId } }),
  listThreads: () => request<ThreadSummary[]>('/api/threads'),
  listProjects: () => request<Project[]>('/api/projects'),
  setProjectImage: (path: string, image: string | null) => request<Project>('/api/projects/image', { method: 'POST', body: { path, image } }),
  setPinnedFiles: (path: string, files: readonly string[]) => request<Project>('/api/projects/pins', { method: 'POST', body: { path, files } }),
  setAntigravityTools: (path: string, connected: boolean) =>
    request<{ project: Project; message?: string; backup?: string }>('/api/projects/agy-mcp', { method: 'POST', body: { path, connected } }),
  removeProject: (path: string) => request<{ project: Project; pausedSchedules: number }>('/api/projects/remove', { method: 'POST', body: { path } }),
  openProject: (path: string, patch: ProjectPatch = {}) =>
    request<Project>('/api/projects', { method: 'POST', body: { path, ...patch } }),
  /** A project's workspaces (Mac only): registered ones, primary first, and interrupted creates. */
  workspaces: (projectId: string) => request<WorkspaceList>(`/api/projects/${projectId}/workspaces`),
  /** What a new worktree would start from, and how many uncommitted files in the main checkout it will not contain. */
  workspacePreflight: (projectId: string) => request<Preflight>(`/api/projects/${projectId}/workspaces/preflight`),
  createWorkspace: (projectId: string, body: { name: string; base?: string; branch?: string }) =>
    request<{ workspace: Workspace }>(`/api/projects/${projectId}/workspaces`, { method: 'POST', body }),
  recoverWorkspaceOperation: (id: string) => request<{ workspace: Workspace }>(`/api/workspace-operations/${id}/recover`, { method: 'POST', body: {} }),
  dismissWorkspaceOperation: (id: string) => request<{ operation: PendingOperation }>(`/api/workspace-operations/${id}/dismiss`, { method: 'POST', body: {} }),
  workspaceRemoval: (id: string) => request<RemovalCheck>(`/api/workspaces/${id}/removal`),
  removeWorkspace: (id: string, fingerprint: string) => request<{ workspace: Workspace }>(`/api/workspaces/${id}/remove`, { method: 'POST', body: { fingerprint } }),
  archiveWorkspace: (id: string) => request<{ workspace: Workspace }>(`/api/workspaces/${id}/archive`, { method: 'POST', body: {} }),
  restoreWorkspace: (id: string) => request<{ workspace: Workspace }>(`/api/workspaces/${id}/restore`, { method: 'POST', body: {} }),
  forgetWorkspace: (id: string) => request<{ workspace: Workspace }>(`/api/workspaces/${id}/forget`, { method: 'POST', body: {} }),
  mergePreview: (id: string) => request<MergePreflight>(`/api/workspaces/${id}/merge`),
  mergeWorkspace: (id: string, fingerprint: string) => request<{ operation: MergeOperationView }>(`/api/workspaces/${id}/merge`, { method: 'POST', body: { fingerprint } }),
  continueMerge: (operationId: string) => request<{ operation: MergeOperationView }>(`/api/merge-operations/${operationId}/continue`, { method: 'POST', body: {} }),
  abortMerge: (operationId: string) => request<{ operation: MergeOperationView }>(`/api/merge-operations/${operationId}/abort`, { method: 'POST', body: {} }),
  thread: (id: string) => request<ThreadDetail>(`/api/threads/${id}/events`),
  createThread: (body: { projectPath: string; workspaceId?: string; text: string; title?: string; settings: Partial<ThreadSettings>; images?: readonly MessageImage[] }) =>
    request<ThreadMeta>('/api/threads', { method: 'POST', body }),
  /** One operation ID per call: a request the network repeats is answered once by the host (ID-05). */
  send: (id: string, text: string, images?: readonly MessageImage[], workspaceId?: string) =>
    request<unknown>(`/api/threads/${id}/messages`, { method: 'POST', body: { text, ...(images?.length ? { images } : {}), ...inWorkspace(workspaceId), ...operationId() } }),
  approve: (id: string, requestId: string, behavior: ApprovalBehavior) =>
    request<unknown>(`/api/threads/${id}/approvals/${requestId}`, { method: 'POST', body: { behavior } }),
  /** Takes a waiting message back; resolves to its text and images for the draft (J1, R8). */
  unqueue: (id: string, queuedId: string) =>
    request<{ text: string; images: StoredImage[] }>(`/api/threads/${id}/queued/${queuedId}/remove`, { method: 'POST', body: {} }),
  /** No answers closes the agent's questions unanswered. */
  answerQuestion: (id: string, requestId: string, answers: Record<string, string> | undefined) =>
    request<unknown>(`/api/threads/${id}/questions/${requestId}`, { method: 'POST', body: answers ? { answers } : {} }),
  /** Stops one workspace's agent, or (without one) every agent in the conversation. */
  interrupt: (id: string, workspaceId?: string) => request<unknown>(`/api/threads/${id}/interrupt`, { method: 'POST', body: workspaceId ? { workspaceId } : {} }),
  /** The exact handoff a switch would send now (D13). */
  handoffPreview: (id: string) => request<HandoffPreview>(`/api/threads/${id}/handoff`),
  /** `handoff` is the digest of the preview the user read; the server refuses if it no longer matches. */
  switchAgent: (id: string, settings: Partial<ThreadSettings>, handoff: string) =>
    request<ThreadMeta>(`/api/threads/${id}/agent`, { method: 'POST', body: { settings, handoff } }),
  /** `processes` decides what happens to running processes the conversation owns (K2); without it such a delete is refused. */
  deleteThread: (id: string, processes?: 'stop' | 'keep') => request<{ deleted: string }>(`/api/threads/${id}`, { method: 'DELETE', body: processes ? { processes } : {} }),
  setCompleted: (id: string, completed: boolean) =>
    request<ThreadMeta>(`/api/threads/${id}/completed`, { method: 'POST', body: { completed } }),
  presets: () => request<Preset[]>('/api/presets'),
  savePresets: (presets: readonly Preset[]) => request<Preset[]>('/api/presets', { method: 'PUT', body: { presets } }),
  dismissAwaiting: (id: string) => request<Record<string, never>>(`/api/threads/${id}/dismiss`, { method: 'POST', body: {} }),
  changeSettings: (id: string, settings: Partial<ThreadSettings>) => request<ThreadMeta>(`/api/threads/${id}/settings`, { method: 'POST', body: { settings } }),
  listProcesses: () => request<ProcessInfo[]>('/api/processes'),
  stopProcess: (id: string) => request<ProcessInfo>(`/api/processes/${id}/stop`, { method: 'POST', body: {} }),
  restartProcess: (id: string) => request<ProcessInfo>(`/api/processes/${id}/restart`, { method: 'POST', body: {} }),
  /** Drops this folder's finished rows from the history; stops nothing. */
  clearFinishedProcesses: (projectPath: string, workspaceId?: string) => request<{ cleared: number }>(`/api/processes/clear-finished?${new URLSearchParams({ project: projectPath, ...inWorkspace(workspaceId) })}`, { method: 'POST', body: {} }),
  /** Output lines after `since`, or the last `tail` lines. */
  readProcess: (id: string, options: { since?: number; tail?: number }) =>
    request<ProcessRead>(`/api/processes/${id}/output?${new URLSearchParams(Object.entries(options).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`),
  pageMode: () => request<PageMode>('/api/remote/me'),
  remoteStatus: () => request<RemoteStatus>('/api/remote'),
  setRemote: (enabled: boolean) => request<RemoteStatus>('/api/remote', { method: 'POST', body: { enabled } }),
  decidePairing: (id: string, approve: boolean) => request<RemoteStatus>(`/api/remote/pairings/${id}`, { method: 'POST', body: { approve } }),
  revokeDevice: (id: string) => request<RemoteStatus>(`/api/remote/devices/${id}/revoke`, { method: 'POST', body: {} }),
  requestPairing: (name: string) => request<{ id: string; code: string }>('/api/remote/pair', { method: 'POST', body: { name } }),
  pushKey: () => request<{ publicKey: string }>('/api/remote/push/key'),
  pushSubscribe: (subscription: PushSubscriptionJSON) => request<unknown>('/api/remote/push/subscribe', { method: 'POST', body: { subscription } }),
  pushUnsubscribe: () => request<unknown>('/api/remote/push/unsubscribe', { method: 'POST', body: {} }),
  testPush: () => request<{ sent: { deviceId: string; status: number }[] }>('/api/remote/push/test', { method: 'POST', body: {} }),
  pairingStatus: (id: string) => request<{ status: 'pending' | 'approved' | 'denied' }>(`/api/remote/pair/${id}`),
  // Phone previews (H5). The Mac sets them up; the phone only asks for a ticket (phone-preview.ts).
  phonePreviews: () => request<PreviewsStatus>('/api/phone/previews'),
  preparePhonePreview: (processId: string) => request<{ serviceId: string; status: PreviewsStatus }>('/api/phone/previews', { method: 'POST', body: { processId } }),
  servePhonePreview: (serviceId: string) => request<PreviewsStatus>(`/api/phone/previews/${serviceId}/serve`, { method: 'POST', body: {} }),
  unservePhonePreview: (serviceId: string) => request<PreviewsStatus>(`/api/phone/previews/${serviceId}/unserve`, { method: 'POST', body: {} }),
}

export interface StreamHandlers {
  onUpdate(update: ThreadUpdate): void
  /** A project process started, printed its URL, is stopping, or exited. */
  onProcess?(info: ProcessInfo): void
  /** (Re)connected: anything missed while disconnected should be re-read. */
  onOpen?(): void
  /** Desktop only: phone access settings or pairing requests changed. */
  onRemote?(status: RemoteStatus): void
}

export function subscribe({ onUpdate, onProcess, onOpen, onRemote }: StreamHandlers): () => void {
  const source = new EventSource('/api/stream')
  source.onopen = () => onOpen?.()
  source.onmessage = (message) => onUpdate(JSON.parse(message.data as string) as ThreadUpdate)
  source.addEventListener('process', (message) => onProcess?.(JSON.parse(message.data as string) as ProcessInfo))
  source.addEventListener('remote', (message) => onRemote?.(JSON.parse(message.data as string) as RemoteStatus))
  return () => source.close()
}

export type { Workflow, WorkflowInput } from '../../server/workflows/store.ts'

export type { FileEntry, FileListing, FilePreview } from '../../server/files/browser.ts'
export type { BaseFile, ChangedFile, Changes, DiffLine, FileDiff, NoRepository } from '../../server/git/changes.ts'
export type { RunChanges } from '../../server/runs/run-changes.ts'
export type { Assessment, CheckDefinition, CheckRecord, EvidenceRecord, ResultRecord } from '../../server/results/types.ts'
export type { DocumentEntry, DocumentMatch } from '../../server/files/documents.ts'
export type { MemoryEntry } from '../../server/memory/store.ts'
/** A session the CLI ran in this project, as the import window lists it. */
export type ImportableSession = SessionSummary & { inCockpit: boolean }
export type { FileMatch, ReferenceCheck } from '../../server/files/search.ts'

export type { Preset }
import type { HandoffPreview } from '../../server/threads/handoff.ts'
export type { HandoffPreview }
