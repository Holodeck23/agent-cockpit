// Synthetic, in-memory data only. The production UI is compiled against this adapter.
import type { ThreadDetail, ThreadMeta, ThreadSettings, StreamHandlers, ProcessInfo, Project, Workflow, MemoryEntry, Preset } from '../../web/src/api.ts'
import type { NormalizedEvent } from '../../server/agents/types.ts'
export const projectPath = '/demo/garden-app'
export const settings: ThreadSettings = { agent: 'claude', permissionMode: 'manual', useHooks: false }
export const now = () => new Date().toISOString()
export const listeners = new Set<StreamHandlers>()
export const previewListeners = new Set<(url: string) => void>()
export const threadListeners = new Set<(id: string) => void>()
export const SAMPLE_URL = 'http://127.0.0.1:5173/'
export const git = { repo: true, branch: 'feature/theme', head: 'sample', branches: ['feature/theme', 'main'], changes: ['package.json', 'server.js'], changeCount: 2, busy: [] }
export const state = {
  director: false,
  projects: [{ path: projectPath, name: 'garden-app', color: 'pink', pinned: true, pinOrder: 1, lastOpenedAt: now() }] as Project[],
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
export function requestStartup(id = 'theme') {
  emit(id, { kind: 'user_text', text: 'Resume and show me the app.' })
  emit(id, { kind: 'assistant_text', messageId: crypto.randomUUID(), text: 'I’ll start the dev server, check its log, then open the app beside this conversation.' })
  emit(id, { kind: 'approval_request', requestId: crypto.randomUUID(), toolName: 'mcp__cockpit__start_process', input: { command: 'npm run dev' }, suggestions: [] }, 'needs_input')
}
export function processUpdate(status: ProcessInfo['status']) {
  const process: ProcessInfo = { id: 'sample-server', name: 'Garden app', command: 'npm run dev', projectPath, status, startedAt: now(), exitCode: status === 'exited' ? 0 : null, signal: null, url: SAMPLE_URL }
  state.processes = [process]
  listeners.forEach(l => l.onProcess?.(process))
  return process
}
export function reset(recovery = false) {
  git.branch = 'feature/theme'; git.branches = ['feature/theme', 'main']
  state.director = recovery
  state.projects = [{ path: projectPath, name: 'garden-app', color: 'pink', pinned: true, pinOrder: 1, lastOpenedAt: now() }]
  state.threads.clear(); state.files.clear(); state.versions.clear(); state.processes = []; state.presets = []
  state.files.set('notes.md', '# Garden app\n\nKeep the layout calm and readable.\nNext: check the launch counter on mobile.\n')
  state.files.set('package.json', '{\n  "name": "garden-app",\n  "scripts": { "dev": "node server.js" }\n}\n')
  state.files.set('server.js', '// Cockpit sample server\n// The preview in this demo runs entirely in your browser.\n')
  createThread('Add a dark mode toggle to the header', 'Now make it follow the system setting.', settings, 'theme')
  reply('theme', 'Done: it follows the system until you pick one.')
  createThread('Review the mobile layout', 'Check the layout on narrow screens.', { ...settings, agent: 'codex' }, 'mobile')
  reply('mobile', 'The navigation fits. The next check is the launch counter at 390px. See notes.md for the project brief.')
  state.workflows = [{ id: 'review', projectPath, name: 'review-next-step', title: 'Review the next step', collection: 'Quality', prompt: 'Read @file:notes.md and prepare a short review checklist.', settings, intervalMinutes: null, calendar: null, enabled: false, archived: false, nextRunAt: null, createdAt: now(), updatedAt: now() }]
  state.memories = [{ id: 'readability', scope: 'project', projectPath, text: 'Keep the layout calm and readable. Check changes on a narrow screen.', source: { kind: 'you' }, createdAt: now(), updatedAt: now() }]
  if (!recovery) requestStartup()
}
reset()
