import { statSync } from 'node:fs'
import type { ThreadManager } from '../threads/manager.ts'
import type { ThreadStore } from '../threads/store.ts'
import { expandWorkflows, type WorkflowStore } from './store.ts'

export function createWorkflowRunner(store: WorkflowStore, manager: ThreadManager, threads: ThreadStore, now = Date.now) {
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  const requireWorkflow = (id: string) => {
    const workflow = store.get(id)
    if (!workflow) throw new Error('Unknown workflow')
    return workflow
  }
  const isBusy = (id: string): boolean => manager.summaries().some((t) => t.meta.workflowId === id &&
    (t.status === 'working' || t.status === 'needs_input'))
  const run = (id: string, trigger: 'manual' | 'scheduled' = 'manual') => {
    if (stopped) throw new Error('Cockpit is shutting down')
    const workflow = requireWorkflow(id)
    if (isBusy(id)) throw new Error('This workflow already has a running conversation')
    try {
      if (!statSync(workflow.projectPath).isDirectory()) throw new Error('Project folder is unavailable')
      const text = expandWorkflows(workflow.prompt, workflow.projectPath, store)
      const thread = manager.create({ projectPath: workflow.projectPath, settings: workflow.settings, text,
        title: `${workflow.name} · ${trigger === 'scheduled' ? 'Scheduled' : 'Run'}`,
        workflowId: id, workflowTrigger: trigger })
      store.update(id, { lastThreadId: thread.id, lastRunAt: new Date(now()).toISOString(), lastError: undefined })
      return thread
    } catch (error) {
      store.update(id, { enabled: false, nextRunAt: null, lastError: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }
  const setEnabled = (id: string, enabled: boolean) => {
    const workflow = requireWorkflow(id)
    if (enabled && !workflow.intervalMinutes) throw new Error('Choose a repeat interval first')
    if (enabled) expandWorkflows(workflow.prompt, workflow.projectPath, store)
    return store.update(id, { enabled, nextRunAt: enabled ? new Date(now() + workflow.intervalMinutes! * 60_000).toISOString() : null,
      lastError: undefined })
  }
  const tick = () => {
    if (stopped) return
    for (const workflow of store.list()) {
      if (!workflow.enabled || !workflow.nextRunAt || !workflow.intervalMinutes || Date.parse(workflow.nextRunAt) > now()) continue
      // Persist the claim before launching: no duplicate launch after restart, no backlog replay.
      store.update(workflow.id, { nextRunAt: new Date(now() + workflow.intervalMinutes * 60_000).toISOString() })
      if (isBusy(workflow.id)) continue
      try { run(workflow.id, 'scheduled') } catch { /* run saved the error and paused the schedule */ }
    }
  }
  const unsubscribe = manager.subscribe(({ threadId, event }) => {
    if (event.kind !== 'error' && !(event.kind === 'result' && !event.ok)) return
    const thread = threads.get(threadId)
    if (!thread?.workflowId || thread.workflowTrigger !== 'scheduled' || !store.get(thread.workflowId)) return
    store.update(thread.workflowId, { enabled: false, nextRunAt: null,
      lastError: event.kind === 'error' ? event.message : event.stopped ? 'Scheduled run was stopped' : 'Scheduled run failed; open its conversation' })
  })
  return {
    run, setEnabled, tick,
    start() {
      if (timer || stopped) return
      timer = setInterval(() => {
        try { tick() } catch (error) { console.error('[cockpit] scheduler stopped:', error); if (timer) clearInterval(timer); timer = undefined }
      }, 5000)
      timer.unref()
    },
    close() { stopped = true; if (timer) clearInterval(timer); unsubscribe() },
  }
}
export type WorkflowRunner = ReturnType<typeof createWorkflowRunner>
