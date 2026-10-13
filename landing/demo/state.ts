// Synthetic, in-memory data only. The production UI is compiled against this adapter.
import type { ThreadDetail, ThreadMeta, ThreadSettings, StreamHandlers, ProcessInfo, Project, Workflow, MemoryEntry, Preset } from '../../web/src/api.ts'
import type { NormalizedEvent } from '../../server/agents/types.ts'
import type { PreviewOpen } from '../../server/preview/types.ts'
export const projectPath = '/demo/garden-notes'
export const settings: ThreadSettings = { agent: 'claude', permissionMode: 'manual', useHooks: false }
export const now = () => new Date().toISOString()
export const listeners = new Set<StreamHandlers>()
export const previewListeners = new Set<(preview: PreviewOpen) => void>()
export const threadListeners = new Set<(id: string) => void>()
export const SAMPLE_URL = 'http://127.0.0.1:5173/'
export const git = { repo: true, branch: 'feature/today-view', head: 'sample', branches: ['feature/today-view', 'main'], changes: ['notes.md', 'server.js'], changeCount: 2, busy: [] }
export const state = {
  director: false,
  projects: [{ path: projectPath, name: 'garden-notes', color: 'green', pinned: true, pinOrder: 1, lastOpenedAt: now() }] as Project[],
  threads: new Map<string, { -readonly [K in keyof ThreadDetail]: ThreadDetail[K] }>(),
  files: new Map<string, string>(),
  versions: new Map<string, number>(),
  processes: [] as ProcessInfo[],
  workflows: [] as Workflow[],
  memories: [] as MemoryEntry[],
  presets: [] as Preset[],
}
export function tell(kind: string, detail = '') {
  window.parent.postMessage({ source: 'cockpit-demo', kind, detail }, '*')
}
export function emit(id: string, event: NormalizedEvent, status?: ThreadDetail['status']) {
  const row = state.threads.get(id)!
  const next = { ...row, status: status ?? row.status, events: [...row.events, { ts: now(), event }] }
  state.threads.set(id, next)
  for (const listener of listeners) listener.onUpdate({ threadId: id, status: next.status, event })
}
export function createThread(title: string, text: string, choice = settings, id: string = crypto.randomUUID()): ThreadMeta {
  const meta: ThreadMeta = { id, title, projectPath, settings: choice, sessionId: id, sessionStarted: true, completed: false, createdAt: now(), updatedAt: now() }
  state.threads.set(id, { meta, status: 'done', streaming: '', transcriptPath: '/demo/transcripts/messages.md', events: [] })
  emit(id, { kind: 'user_text', text })
  return meta
}
export function reply(id: string, text: string) {
  emit(id, { kind: 'assistant_text', messageId: crypto.randomUUID(), text }, 'done')
  emit(id, { kind: 'result', ok: true }, 'done')
}
export function requestStartup(id = 'garden') {
  emit(id, { kind: 'user_text', text: 'Open the Garden Notes app so I can try the change.' })
  emit(id, { kind: 'assistant_text', messageId: crypto.randomUUID(), text: 'I’ll start the dev server, check its log, then open the app beside this conversation.' })
  emit(id, { kind: 'approval_request', requestId: crypto.randomUUID(), toolName: 'mcp__cockpit__start_process', input: { command: 'npm run dev' }, suggestions: [] }, 'needs_input')
}
export function processUpdate(status: ProcessInfo['status'], threadId = state.processes[0]?.owner.kind === 'conversation' ? state.processes[0].owner.threadId : 'garden') {
  const process: ProcessInfo = { id: 'sample-server', name: 'Garden Notes', command: 'npm run dev', projectPath, cwd: projectPath, status, startedAt: now(), exitCode: status === 'exited' ? 0 : null, signal: null, url: SAMPLE_URL, owner: { kind: 'conversation', threadId, title: state.threads.get(threadId)?.meta.title ?? 'Garden Notes' } }
  state.processes = [process]
  listeners.forEach(l => l.onProcess?.(process))
  return process
}
export function reset(recovery = false) {
  git.branch = 'feature/today-view'; git.branches = ['feature/today-view', 'main']
  state.director = recovery
  state.projects = [{ path: projectPath, name: 'garden-notes', color: 'green', pinned: true, pinOrder: 1, lastOpenedAt: now() }]
  state.threads.clear(); state.files.clear(); state.versions.clear(); state.processes = []; state.presets = []
  state.files.set('notes.md', '# Garden Notes\n\nGoal: make daily care feel calm, not like a chore.\nToday view: show plants that need water and a clear progress count.\nNext: check the cards on a narrow screen.\n')
  state.files.set('package.json', '{\n  "name": "garden-notes",\n  "scripts": { "dev": "node server.js" }\n}\n')
  state.files.set('server.js', '// Garden Notes sample server\n// The preview in this browser tour is simulated locally.\n')
  createThread('Make today’s care list easier to scan', 'Show which plants need water and make progress easy to see.', settings, 'garden')
  reply('garden', 'I added a Today view with a clear watering action and progress count. Let’s open the app and try it together.')
  createThread('Check the small-screen layout', 'Make sure the plant cards work on a phone-sized screen.', { ...settings, agent: 'codex' }, 'mobile')
  reply('mobile', 'The cards stack cleanly. The next check is whether the progress and Needs water filter make sense after you mark a plant watered.')
  state.workflows = [{ id: 'review', projectPath, name: 'review-before-sharing', title: 'Review before sharing', collection: 'Quality', prompt: 'Read @file:notes.md and prepare a short experience review.', settings, intervalMinutes: null, calendar: null, enabled: false, archived: false, nextRunAt: null, createdAt: now(), updatedAt: now() }]
  state.memories = [{ id: 'readability', scope: 'project', projectPath, text: 'Garden Notes should feel calm and readable, including on a narrow screen.', source: { kind: 'you' }, createdAt: now(), updatedAt: now() }]
  if (!recovery) requestStartup()
}
reset()
