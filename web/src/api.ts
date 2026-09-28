import type { Workflow, WorkflowInput } from '../../server/workflows/store.ts'
import type { ApprovalBehavior } from '../../server/agents/types.ts'
import type { ProcessInfo } from '../../server/processes/runner.ts'
import type { Project, ProjectPatch } from '../../server/projects/store.ts'
import type { ThreadUpdate } from '../../server/threads/manager.ts'
import type { StoredEvent, ThreadMeta, ThreadSettings, ThreadStatus, ThreadSummary } from '../../server/threads/types.ts'

export type { ProcessInfo, Project, ProjectPatch, StoredEvent, ThreadMeta, ThreadSettings, ThreadStatus, ThreadSummary, ThreadUpdate }

export interface ThreadDetail {
  readonly meta: ThreadMeta
  readonly status: ThreadStatus
  readonly events: StoredEvent[]
  /** messages.md on disk: the human-readable transcript. */
  readonly transcriptPath: string
  /** The agent message being streamed right now, if any. */
  readonly streaming: string
}

async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const payload = (await response.json()) as { data?: T; error?: string }
  if (!response.ok || payload.data === undefined) throw new Error(payload.error ?? `Request failed (${response.status})`)
  return payload.data
}

export const api = {
  listWorkflows: (projectPath: string) => request<Workflow[]>(`/api/workflows?projectPath=${encodeURIComponent(projectPath)}`),
  saveWorkflow: (body: WorkflowInput, id?: string) => request<Workflow>(id ? `/api/workflows/${id}/save` : '/api/workflows', { method: 'POST', body }),
  runWorkflow: (id: string) => request<ThreadMeta>(`/api/workflows/${id}/run`, { method: 'POST', body: {} }),
  enableWorkflow: (id: string, enabled: boolean) => request<Workflow>(`/api/workflows/${id}/enabled`, { method: 'POST', body: { enabled } }),
  archiveWorkflow: (id: string) => request<Workflow>(`/api/workflows/${id}/archive`, { method: 'POST', body: {} }),
  listThreads: () => request<ThreadSummary[]>('/api/threads'),
  listProjects: () => request<Project[]>('/api/projects'),
  openProject: (path: string, patch: ProjectPatch = {}) =>
    request<Project>('/api/projects', { method: 'POST', body: { path, ...patch } }),
  thread: (id: string) => request<ThreadDetail>(`/api/threads/${id}/events`),
  createThread: (body: { projectPath: string; text: string; title?: string; settings: Partial<ThreadSettings> }) =>
    request<ThreadMeta>('/api/threads', { method: 'POST', body }),
  send: (id: string, text: string) => request<unknown>(`/api/threads/${id}/messages`, { method: 'POST', body: { text } }),
  approve: (id: string, requestId: string, behavior: ApprovalBehavior) =>
    request<unknown>(`/api/threads/${id}/approvals/${requestId}`, { method: 'POST', body: { behavior } }),
  interrupt: (id: string) => request<unknown>(`/api/threads/${id}/interrupt`, { method: 'POST', body: {} }),
  switchAgent: (id: string, settings: Partial<ThreadSettings>) =>
    request<ThreadMeta>(`/api/threads/${id}/agent`, { method: 'POST', body: { settings } }),
  setCompleted: (id: string, completed: boolean) =>
    request<ThreadMeta>(`/api/threads/${id}/completed`, { method: 'POST', body: { completed } }),
  listProcesses: () => request<ProcessInfo[]>('/api/processes'),
  stopProcess: (id: string) => request<ProcessInfo>(`/api/processes/${id}/stop`, { method: 'POST', body: {} }),
}

export interface StreamHandlers {
  onUpdate(update: ThreadUpdate): void
  /** A project process started, printed its URL, is stopping, or exited. */
  onProcess?(info: ProcessInfo): void
  /** (Re)connected: anything missed while disconnected should be re-read. */
  onOpen?(): void
}

export function subscribe({ onUpdate, onProcess, onOpen }: StreamHandlers): () => void {
  const source = new EventSource('/api/stream')
  source.onopen = () => onOpen?.()
  source.onmessage = (message) => onUpdate(JSON.parse(message.data as string) as ThreadUpdate)
  source.addEventListener('process', (message) => onProcess?.(JSON.parse(message.data as string) as ProcessInfo))
  return () => source.close()
}

export type { Workflow, WorkflowInput } from '../../server/workflows/store.ts'
