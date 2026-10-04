import { state, git, projectPath, settings, now, listeners, previewListeners, SAMPLE_URL, createThread, emit, reply, requestStartup, processUpdate, tell } from './state'
import type { api as productionApi, StreamHandlers, MemoryEntry } from '../../web/src/api.ts'

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}
const copy = <T,>(value: T): T => structuredClone(value)
const remote = { enabled: false, devices: [], pairings: [], available: false, problem: 'Phone pairing needs the installed Mac app. This browser demo stays on this device.' }
const get = (id: string) => {
  const row = state.threads.get(id)
  if (!row) throw new Error('This sample conversation is no longer available.')
  return row
}
const file = (path: string) => {
  const text = state.files.get(path)
  if (text === undefined) throw new Error('Choose a file in the sample project.')
  return { path, text, bytes: new TextEncoder().encode(text).length, version: String(state.versions.get(path) ?? 0) }
}
const methods = {
  director: () => ({ show: state.director }),
  dismissDirector: () => { state.director = false; return {} },
  pageMode: () => ({ mode: 'local' }),
  agents: () => ['claude', 'codex', 'opencode', 'antigravity'].map(id => ({ id, installation: { installed: true, version: 'sample agent · no connection' } })),
  listProjects: () => state.projects.filter(p => !p.hidden),
  openProject: (_path: string, patch = {}) => {
    state.projects[0] = { ...state.projects[0]!, hidden: false, ...patch }; return state.projects[0]
  },
  removeProject: () => { state.projects[0] = { ...state.projects[0]!, hidden: true }; return { project: state.projects[0], pausedSchedules: 0 } },
  recentWork: () => ({ offerId: 'sample', agents: ['claude', 'codex', 'opencode'], warnings: [], git,
    choices: [...state.threads.values()].map(t => ({ key: t.meta.id, sessionId: t.meta.id, agent: t.meta.settings.agent, title: t.meta.title, task: t.meta.id === 'theme' ? 'Now make it follow the system setting' : 'Check the layout on narrow screens', updatedAt: t.meta.createdAt, busy: false })) }),
  resumeWork: ({ key, agent }: any) => {
    const row = get(key); row.meta = { ...row.meta, settings: { ...row.meta.settings, agent } }
    requestStartup(key); state.director = false; tell('approval'); return row.meta
  },
  startDirector: () => { requestStartup(); state.director = false; tell('approval'); return get('theme').meta },
  listThreads: () => [...state.threads.values()].map(t => {
    const last = t.events.map(e => e.event).filter(e => e.kind === 'assistant_text').at(-1)
    return { meta: t.meta, status: t.status, messageCount: t.events.filter(e => /^(user_text|assistant_text)$/.test(e.event.kind)).length, lastActivityAt: t.meta.updatedAt, preview: last?.text ?? '' }
  }),
  thread: (id: string) => get(id),
  searchThreads: (q: string) => [...state.threads.values()].filter(t => JSON.stringify(t.events).toLowerCase().includes(q.toLowerCase())).map(t => ({ id: t.meta.id, excerpt: t.meta.title })),
  approve: (id: string, requestId: string, behavior: 'allow' | 'allow_session' | 'deny') => {
    emit(id, { kind: 'approval_resolved', requestId, behavior })
    if (behavior === 'deny') {
      reply(id, 'Startup denied. Nothing started. Send “start the app” to request approval again.'); tell('denied')
    } else {
      processUpdate('running')
      reply(id, 'The sample is open in Preview. Try Count a launch. Then edit notes.md or switch the agent below to continue in the same conversation.')
      previewListeners.forEach(fn => fn(SAMPLE_URL)); tell('preview')
    }
    return {}
  },
  send: (id: string, text: string) => {
    if (/start|resume|preview/i.test(text)) { requestStartup(id); tell('approval'); return {} }
    emit(id, { kind: 'user_text', text })
    reply(id, 'Sample response: your message is now in this conversation. This demo does not call an AI model. Try “start the app”, edit notes.md in Files, or run Review the next step in Workflows.'); tell('message'); return {}
  },
  createThread: ({ text, title, settings: choice }: any) => {
    const meta = createThread(title || text.slice(0, 64), text, { ...settings, ...choice })
    reply(meta.id, 'Your sample conversation is ready. Try “start the app” to request the preview. No model is connected.'); return meta
  },
  switchAgent: (id: string, choice: any) => {
    const row = get(id), from = row.meta.settings.agent
    row.meta = { ...row.meta, settings: { ...row.meta.settings, ...choice } }
    emit(id, { kind: 'agent_switch', from, to: row.meta.settings.agent }); tell('handoff', row.meta.settings.agent); return row.meta
  },
  changeSettings: (id: string, choice: any) => {
    const row = get(id); row.meta = { ...row.meta, settings: { ...row.meta.settings, ...choice } }
    emit(id, { kind: 'settings_changed', ...row.meta.settings }); return row.meta
  },
  setCompleted: (id: string, completed: boolean) => { const row = get(id); row.meta = { ...row.meta, completed }; emit(id, { kind: 'completion_changed', completed }); return row.meta },
  deleteThread: (id: string) => { emit(id, { kind: 'thread_deleted' }); state.threads.delete(id); return { deleted: id } },
  interrupt: (id: string) => { emit(id, { kind: 'result', ok: false, stopped: true }, 'idle'); return {} },
  dismissAwaiting: (id: string) => { emit(id, { kind: 'awaiting_dismissed' }); return {} },
  gitState: () => git,
  switchBranch: (_path: string, branch: string) => { git.branch = branch; return git },
  createBranch: (_path: string, branch: string) => { if (!git.branches.includes(branch)) git.branches.push(branch); git.branch = branch; return git },
  listFiles: () => ({ path: '', entries: [...state.files.keys()].filter(p => !p.startsWith('documents:')).map(path => ({ name: path, path, kind: 'file' })), truncated: false }),
  readFile: (_project: string, path: string) => file(path),
  writeFile: (_project: string, path: string, text: string, expected: string | null) => {
    if (state.files.has(path) && expected !== String(state.versions.get(path) ?? 0)) throw new ApiError('Sample file changed; reload before saving.', 409)
    state.files.set(path, text); state.versions.set(path, (state.versions.get(path) ?? 0) + 1); tell('saved', path); return file(path)
  },
  renameFile: (_project: string, path: string, name: string) => {
    if (state.files.has(name)) throw new Error('A sample file already has this name.')
    const existing = file(path); state.files.set(name, existing.text); state.versions.set(name, Number(existing.version)); state.files.delete(path); return name
  },
  listDocuments: () => [],
  searchFiles: (_project: string, q: string) => ({ matches: [...state.files.keys()].filter(path => path.includes(q)).map(path => ({ path, name: path, kind: 'file' })), truncated: false }),
  checkReferences: () => [],
  listWorkflows: () => state.workflows.filter(w => !w.archived),
  saveWorkflow: (body: any, id?: string) => {
    const w = { ...body, id: id ?? crypto.randomUUID(), enabled: false, archived: false, nextRunAt: null, createdAt: now(), updatedAt: now() }
    const i = state.workflows.findIndex(w => w.id === id); if (i < 0) state.workflows.push(w); else state.workflows[i] = { ...state.workflows[i], ...w }; return i < 0 ? w : state.workflows[i]
  },
  runWorkflow: (id: string) => {
    const w = state.workflows.find(w => w.id === id)
    if (!w) throw new Error('This sample workflow is no longer available.')
    const meta = createThread(w.title || w.name, w.prompt, w.settings)
    // The copied file is a user message, so literal HTML/Markdown stays literal.
    emit(meta.id, { kind: 'user_text', text: 'Saved notes used for this sample run:\n\n' + (state.files.get('notes.md') ?? '(No notes.md file)') })
    reply(meta.id, 'Sample checklist (fixed, no model call):\n\n- Try the launch counter.\n- Check the layout on a narrow screen.\n- Record the next step in notes.md.')
    w.lastThreadId = meta.id; w.lastRunAt = now(); tell('workflow'); return meta
  },
  archiveWorkflow: (id: string) => { const w = state.workflows.find(w => w.id === id); if (!w) throw new Error('Workflow not found.'); w.archived = true; return w },
  enableWorkflow: () => { throw new Error('Scheduling needs the installed app. You can save and run workflows manually in this demo.') },
  listMemory: () => state.memories,
  addMemory: (_project: string, scope: 'project' | 'everywhere', text: string) => { const row: MemoryEntry = { id: crypto.randomUUID(), projectPath, scope, text, source: { kind: 'you' }, createdAt: now(), updatedAt: now() }; state.memories.push(row); return row },
  updateMemory: (id: string, text: string) => { const row = state.memories.find(m => m.id === id); if (!row) throw new Error('Memory not found.'); row.text = text; row.updatedAt = now(); return row },
  deleteMemory: (id: string) => { state.memories = state.memories.filter(m => m.id !== id); return { removed: id } },
  clearMemory: () => { const removed = state.memories.length; state.memories = []; return { removed } },
  listProcesses: () => state.processes,
  stopProcess: () => processUpdate('exited'),
  restartProcess: () => processUpdate('running'),
  readProcess: (_id: string, options: { since?: number }) => ({ process: state.processes[0], lines: options.since ? [] : [{ seq: 1, stream: 'stdout', text: 'Sample log: dev server ready. Local: http://127.0.0.1:5173/', ts: now() }], next: 1, dropped: 0 }),
  remoteStatus: () => remote,
  setRemote: () => { throw new Error(remote.problem) },
  presets: () => state.presets,
  savePresets: (rows: any[]) => { state.presets = rows; return rows },
  listImportable: () => [],
}
// Unknown actions fail visibly; no API or native request can escape the simulation.
export const api = new Proxy(methods, {
  get(target, key: string) {
    return async (...args: any[]) => {
      const method = target[key as keyof typeof methods] as ((...args: any[]) => unknown) | undefined
      if (!method) throw new Error('This action needs the installed Mac app. The browser demo uses sample data only.')
      return copy(await method(...args))
    }
  },
}) as unknown as typeof productionApi
export function subscribe(handlers: StreamHandlers) {
  listeners.add(handlers); queueMicrotask(() => { if (listeners.has(handlers)) handlers.onOpen?.() })
  return () => { listeners.delete(handlers) }
}
