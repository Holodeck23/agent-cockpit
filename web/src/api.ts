import type { RecoveryView, resumeRecoveryBody } from '../../server/onboarding/recovery.ts'
import type { Preset } from '../../server/presets/store.ts'
import type { z } from 'zod'
export type { RecoveryView }
import type { FileListing, FilePreview } from '../../server/files/browser.ts'
import type { DocumentEntry, DocumentMatch } from '../../server/files/documents.ts'
import type { MemoryEntry } from '../../server/memory/store.ts'
import type { SessionSummary } from '../../server/import/sessions.ts'
import { inSpace, spaceOf } from './file-text.ts'
import type { FileSaved } from '../../server/files/editor.ts'
import type { FileSearch, ReferenceCheck } from '../../server/files/search.ts'
import type { Workflow, WorkflowInput } from '../../server/workflows/store.ts'
import type { AgentId, ApprovalBehavior } from '../../server/agents/types.ts'
import type { ProcessInfo, ProcessRead } from '../../server/processes/runner.ts'
import type { Project, ProjectPatch } from '../../server/projects/store.ts'
import type { ThreadUpdate } from '../../server/threads/manager.ts'
import type { StoredEvent, ThreadMeta, ThreadSettings, ThreadStatus, ThreadSummary } from '../../server/threads/types.ts'
import type { RemoteStatus } from '../../server/remote/service.ts'
import type { AgentStatus } from '../../server/agents/status.ts'
import type { GitState } from '../../server/git/branches.ts'

export type { AgentStatus, ProcessInfo, ProcessRead, Project, ProjectPatch, RemoteStatus, StoredEvent, ThreadMeta, ThreadSettings, ThreadStatus, ThreadSummary, ThreadUpdate }

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

/** The project's branch state plus the conversations that would block a switch. */
export type GitView = GitState & { readonly busy: readonly string[]; readonly pushedTo?: string }

export const api = {
  recentWork: (projectPath: string) => request<RecoveryView>(`/api/recovery?${new URLSearchParams({ projectPath })}`),
  resumeWork: (body: z.infer<typeof resumeRecoveryBody>) => request<ThreadMeta>('/api/recovery', { method: 'POST', body }),
  director: () => request<{ show: boolean }>('/api/onboarding'),
  dismissDirector: () => request<unknown>('/api/onboarding/dismiss', { method: 'POST', body: {} }),
  startDirector: (body: { kind: 'sample' } | { kind: 'project'; projectPath: string }) =>
    request<ThreadMeta>('/api/onboarding/start', { method: 'POST', body }),
  /** Conversations whose messages contain every word of `q`, with an excerpt (Mac only). */
  searchThreads: (q: string) => request<Array<{ id: string; excerpt: string }>>(`/api/threads/search?${new URLSearchParams({ q })}`),
  gitState: (projectPath: string) => request<GitView>(`/api/git?${new URLSearchParams({ projectPath })}`),
  switchBranch: (projectPath: string, branch: string, threadId?: string) => request<GitView>('/api/git/switch', { method: 'POST', body: { projectPath, branch, threadId } }),
  createBranch: (projectPath: string, branch: string, threadId?: string) => request<GitView>('/api/git/create', { method: 'POST', body: { projectPath, branch, threadId } }),
  /** A commit named in a reply: its full hash and web page, or a 404 when it isn't a commit here. */
  gitCommit: (projectPath: string, hash: string) => request<{ hash: string; url?: string }>(`/api/git/commit?${new URLSearchParams({ projectPath, hash })}`),
  pushBranch: (projectPath: string) => request<GitView>('/api/git/push', { method: 'POST', body: { projectPath } }),
  listFiles: (projectPath: string, path = '') => request<FileListing>(`/api/files?${new URLSearchParams({ projectPath, path })}`),
  /** A "documents:" path reads from the project's documents; the result keeps the same naming. */
  readFile: async (projectPath: string, tabPath: string) => {
    const { space, path } = spaceOf(tabPath)
    const read = await request<FilePreview>(`/api/files/read?${new URLSearchParams({ projectPath, path, space })}`)
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
  renameFile: async (projectPath: string, tabPath: string, name: string) => {
    const { space, path } = spaceOf(tabPath)
    const renamed = await request<{ path: string }>('/api/files/rename', { method: 'POST', body: { projectPath, path, name, space } })
    return inSpace(space, renamed.path)
  },
  searchFiles: (projectPath: string, q: string) => request<FileSearch>(`/api/files/search?${new URLSearchParams({ projectPath, q })}`),
  checkReferences: (projectPath: string, text: string) => request<ReferenceCheck[]>('/api/references/check', { method: 'POST', body: { projectPath, text } }),
  /** `expected` is the version the edit started from; null creates a new file. */
  writeFile: async (projectPath: string, tabPath: string, text: string, expected: string | null) => {
    const { space, path } = spaceOf(tabPath)
    const saved = await request<FileSaved>('/api/files/write', { method: 'PUT', body: { projectPath, path, text, expected, space } })
    return { ...saved, path: inSpace(space, saved.path) }
  },
  listWorkflows: (projectPath: string) => request<Workflow[]>(`/api/workflows?projectPath=${encodeURIComponent(projectPath)}`),
  saveWorkflow: (body: WorkflowInput, id?: string) => request<Workflow>(id ? `/api/workflows/${id}/save` : '/api/workflows', { method: 'POST', body }),
  runWorkflow: (id: string) => request<ThreadMeta>(`/api/workflows/${id}/run`, { method: 'POST', body: {} }),
  enableWorkflow: (id: string, enabled: boolean) => request<Workflow>(`/api/workflows/${id}/enabled`, { method: 'POST', body: { enabled } }),
  archiveWorkflow: (id: string) => request<Workflow>(`/api/workflows/${id}/archive`, { method: 'POST', body: {} }),
  agents: () => request<AgentStatus[]>('/api/agents'),
  listThreads: () => request<ThreadSummary[]>('/api/threads'),
  listProjects: () => request<Project[]>('/api/projects'),
  setProjectImage: (path: string, image: string | null) => request<Project>('/api/projects/image', { method: 'POST', body: { path, image } }),
  setPinnedFiles: (path: string, files: readonly string[]) => request<Project>('/api/projects/pins', { method: 'POST', body: { path, files } }),
  removeProject: (path: string) => request<{ project: Project; pausedSchedules: number }>('/api/projects/remove', { method: 'POST', body: { path } }),
  openProject: (path: string, patch: ProjectPatch = {}) =>
    request<Project>('/api/projects', { method: 'POST', body: { path, ...patch } }),
  thread: (id: string) => request<ThreadDetail>(`/api/threads/${id}/events`),
  createThread: (body: { projectPath: string; text: string; title?: string; settings: Partial<ThreadSettings> }) =>
    request<ThreadMeta>('/api/threads', { method: 'POST', body }),
  send: (id: string, text: string) => request<unknown>(`/api/threads/${id}/messages`, { method: 'POST', body: { text } }),
  approve: (id: string, requestId: string, behavior: ApprovalBehavior) =>
    request<unknown>(`/api/threads/${id}/approvals/${requestId}`, { method: 'POST', body: { behavior } }),
  /** No answers closes the agent's questions unanswered. */
  answerQuestion: (id: string, requestId: string, answers: Record<string, string> | undefined) =>
    request<unknown>(`/api/threads/${id}/questions/${requestId}`, { method: 'POST', body: answers ? { answers } : {} }),
  interrupt: (id: string) => request<unknown>(`/api/threads/${id}/interrupt`, { method: 'POST', body: {} }),
  switchAgent: (id: string, settings: Partial<ThreadSettings>) =>
    request<ThreadMeta>(`/api/threads/${id}/agent`, { method: 'POST', body: { settings } }),
  deleteThread: (id: string) => request<{ deleted: string }>(`/api/threads/${id}`, { method: 'DELETE', body: {} }),
  setCompleted: (id: string, completed: boolean) =>
    request<ThreadMeta>(`/api/threads/${id}/completed`, { method: 'POST', body: { completed } }),
  presets: () => request<Preset[]>('/api/presets'),
  savePresets: (presets: readonly Preset[]) => request<Preset[]>('/api/presets', { method: 'PUT', body: { presets } }),
  dismissAwaiting: (id: string) => request<Record<string, never>>(`/api/threads/${id}/dismiss`, { method: 'POST', body: {} }),
  changeSettings: (id: string, settings: Partial<ThreadSettings>) => request<ThreadMeta>(`/api/threads/${id}/settings`, { method: 'POST', body: { settings } }),
  listProcesses: () => request<ProcessInfo[]>('/api/processes'),
  stopProcess: (id: string) => request<ProcessInfo>(`/api/processes/${id}/stop`, { method: 'POST', body: {} }),
  restartProcess: (id: string) => request<ProcessInfo>(`/api/processes/${id}/restart`, { method: 'POST', body: {} }),
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
export type { DocumentEntry, DocumentMatch } from '../../server/files/documents.ts'
export type { MemoryEntry } from '../../server/memory/store.ts'
/** A session the CLI ran in this project, as the import window lists it. */
export type ImportableSession = SessionSummary & { inCockpit: boolean }
export type { FileMatch, ReferenceCheck } from '../../server/files/search.ts'

export type { Preset }
