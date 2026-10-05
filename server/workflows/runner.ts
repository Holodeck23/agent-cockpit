import { expandFiles } from '../files/browser.ts'
import { statSync } from 'node:fs'
import type { ThreadManager } from '../threads/manager.ts'
import type { ThreadStore } from '../threads/store.ts'
import { nextCalendarRun } from './calendar.ts'
import { expandWorkflows, resolveWorkflows, type Workflow, type WorkflowStore } from './store.ts'
import { isBusy as busyStatus } from '../threads/status.ts'

/** When a schedule fires next after `after`; undefined when the workflow has no schedule. */
export function nextRunAfter(workflow: Pick<Workflow, 'intervalMinutes' | 'calendar'>, after: number): number | undefined {
  if (workflow.calendar) return nextCalendarRun(workflow.calendar, after)
  return workflow.intervalMinutes ? after + workflow.intervalMinutes * 60_000 : undefined
}

export function createWorkflowRunner(store: WorkflowStore, manager: ThreadManager, threads: ThreadStore, now = Date.now) {
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  const requireWorkflow = (id: string) => {
    const workflow = store.get(id)
    if (!workflow) throw new Error('Unknown workflow')
    return workflow
  }
  const isBusy = (id: string): boolean => manager.summaries().some((t) => t.meta.workflowId === id && busyStatus(t.status))
  const run = (id: string, trigger: 'manual' | 'scheduled' = 'manual') => {
    if (stopped) throw new Error('Cockpit is shutting down')
    const workflow = requireWorkflow(id)
    if (isBusy(id)) throw new Error('This workflow already has a running conversation')
    try {
      if (!statSync(workflow.projectPath).isDirectory()) throw new Error('Project folder is unavailable')
      const resolved = resolveWorkflows(workflow.prompt, workflow.projectPath, store)
      const agentText = expandFiles(resolved.text, workflow.projectPath)
      const thread = manager.create({ projectPath: workflow.projectPath, settings: workflow.settings, text: workflow.prompt, agentText,
        ...(resolved.used.length ? { workflows: resolved.used } : {}),
        title: `${workflow.title || workflow.name} · ${trigger === 'scheduled' ? 'Scheduled' : 'Run'}`,
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
    const next = nextRunAfter(workflow, now())
    if (enabled && next === undefined) throw new Error('Choose when it repeats first')
    if (enabled) expandWorkflows(workflow.prompt, workflow.projectPath, store)
    return store.update(id, { enabled, nextRunAt: enabled ? new Date(next!).toISOString() : null, lastError: undefined })
  }
  const tick = () => {
    if (stopped) return
    for (const workflow of store.list()) {
      if (!workflow.enabled || !workflow.nextRunAt || Date.parse(workflow.nextRunAt) > now()) continue
      const next = nextRunAfter(workflow, now())
      if (next === undefined) continue
      // Persist the claim before launching: no duplicate launch after restart, no backlog replay.
      // The next run is counted from now, so a long gap means one late run, not one per missed slot.
      store.update(workflow.id, { nextRunAt: new Date(next).toISOString() })
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
