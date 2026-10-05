import { z } from 'zod'
import { workflowInputSchema, type Workflow, type WorkflowStore } from './store.ts'
import type { ThreadSettings } from '../threads/types.ts'

// What an agent may do with save_workflow (decision P1, 2026-10-03). By default it only creates
// a new workflow with its schedule off, for the user to review. A project setting lets agents
// update existing workflows by name and set schedules too; Cockpit then skips the approval card.

const days = z.array(z.number().int().min(0).max(6)).min(1).max(7).describe('0 = Sunday … 6 = Saturday')
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time like 09:00').describe('24-hour local time, e.g. "09:00"')

export const agentWorkflowShape = {
  name: workflowInputSchema.shape.name,
  prompt: workflowInputSchema.shape.prompt,
  title: z.string().trim().max(80).optional().describe('What people see; defaults to the name'),
  schedule: z.union([z.object({ days, time }), z.object({ everyMinutes: z.number().int().min(5).max(43_200) })]).optional()
    .describe('When it repeats. Only allowed when the user let agents manage workflows in Project settings.'),
}
export const agentWorkflowSchema = z.object(agentWorkflowShape)
export type AgentWorkflowInput = z.input<typeof agentWorkflowSchema>

/** Refused under the project's setting; maps to HTTP 403 / 409 with a message the agent can relay. */
export class AgentWorkflowRefused extends Error {
  constructor(message: string, readonly status: 403 | 409) { super(message) }
}

const SETTING = 'Project settings → Let agents manage workflows'

/** Refuses what the project's setting does not allow; returns the workflow an update would change. Safe to call before asking the user. */
export function checkAgentWorkflow(store: WorkflowStore, projectPath: string, raw: AgentWorkflowInput, allowed: boolean): Workflow | undefined {
  const input = agentWorkflowSchema.parse(raw)
  const existing = store.list(projectPath).find((w) => w.name === input.name)
  if (!allowed && existing) {
    throw new AgentWorkflowRefused(`A workflow named ${input.name} already exists. Choose another name, or ask the user to edit it in Workflows or to allow this in ${SETTING}.`, 409)
  }
  if (!allowed && input.schedule) {
    throw new AgentWorkflowRefused(`Agents cannot schedule workflows in this project. Save it without a schedule for the user to turn on in Workflows, or ask them to allow it in ${SETTING}.`, 403)
  }
  return existing
}

export function saveAgentWorkflow(store: WorkflowStore, projectPath: string, raw: AgentWorkflowInput, options: {
  allowed: boolean
  /** Turns the schedule on (the runner works out the next run). */
  enable: (id: string) => Workflow
  timeZone: string
}): Workflow & { updated: boolean; pausedReason?: string } {
  const input = agentWorkflowSchema.parse(raw)
  const existing = checkAgentWorkflow(store, projectPath, input, options.allowed)

  const schedule = input.schedule === undefined ? {}
    : 'everyMinutes' in input.schedule ? { intervalMinutes: input.schedule.everyMinutes, calendar: null }
      : { intervalMinutes: null, calendar: { days: input.schedule.days, time: input.schedule.time, timeZone: options.timeZone } }
  const saved = store.save({
    projectPath, name: input.name, prompt: input.prompt,
    // An update keeps what the agent did not mention: title, collection, agent settings and the schedule's shape.
    title: input.title ?? existing?.title, collection: existing?.collection, settings: existing?.settings,
    intervalMinutes: existing?.intervalMinutes ?? null, calendar: existing?.calendar ?? null, ...schedule,
  }, existing?.id)
  // Saving pauses a schedule; an allowed agent's save keeps one that was on, or turns on the one it set.
  // Not for a workflow that runs with more than manual permissions: an agent rewriting its prompt would
  // get its instructions run unattended with those permissions, so its schedule waits for the user.
  const unattended = existing && runsUnattended(existing.settings)
  const enabled = !unattended && (input.schedule !== undefined || existing?.enabled === true)
  return { ...(enabled ? options.enable(saved.id) : saved), updated: existing !== undefined,
    ...(unattended ? { pausedReason: `it runs with ${existing.settings.permissionMode} permissions${existing.settings.useHooks ? ' and your hooks' : ''}, so the user must turn its schedule back on in Workflows` } : {}) }
}

/** More than read-only or ask-every-time: such a run can act without anyone approving it. */
export function runsUnattended(settings: ThreadSettings): boolean {
  return !(settings.permissionMode === 'manual' || settings.permissionMode === 'plan') || settings.useHooks
}
