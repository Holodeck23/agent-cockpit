import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { WorkflowSnapshot } from '../agents/types.ts'
import { threadSettingsSchema } from '../threads/types.ts'
import { MessageReferenceError, WORKFLOW_REFERENCE } from '../files/references.ts'
import { calendarSchema } from './calendar.ts'

export const workflowInputSchema = z.object({
  projectPath: z.string().min(1).max(1000).refine(isAbsolute, 'Choose an absolute project path'),
  /** Stable slug for @workflow: references; fixed once saved. */
  name: z.string().min(1).max(60).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase words separated by hyphens'),
  /** What people see; free to change. Falls back to the name. */
  title: z.string().trim().max(80).optional(),
  /** Groups workflows in the list, e.g. "Quality". */
  collection: z.string().trim().max(40).optional(),
  prompt: z.string().trim().min(1).max(40_000),
  settings: threadSettingsSchema.default(threadSettingsSchema.parse({})),
  intervalMinutes: z.number().int().min(5).max(43_200).nullable().default(null),
  /** Days and a local time instead of an interval; at most one of the two is set. */
  calendar: calendarSchema.nullable().default(null),
})
export type WorkflowInput = z.input<typeof workflowInputSchema>
const workflowSchema = workflowInputSchema.extend({
  id: z.uuid(), enabled: z.boolean(), nextRunAt: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string(),
  lastThreadId: z.string().optional(), lastRunAt: z.string().optional(), lastError: z.string().optional(),
  archived: z.boolean().default(false),
})
export type Workflow = z.output<typeof workflowSchema>
export interface WorkflowStore {
  list(projectPath?: string): Workflow[]
  get(id: string): Workflow | undefined
  save(input: WorkflowInput, id?: string): Workflow
  update(id: string, patch: Partial<Pick<Workflow, 'enabled' | 'nextRunAt' | 'lastThreadId' | 'lastRunAt' | 'lastError' | 'archived'>>): Workflow
}

export function createWorkflowStore(root: string): WorkflowStore {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const file = join(root, 'workflows.json')
  const read = (): Workflow[] => existsSync(file) ? z.array(workflowSchema).parse(JSON.parse(readFileSync(file, 'utf8'))) : []
  const write = (rows: Workflow[]): void => {
    writeFileSync(`${file}.tmp`, JSON.stringify(rows, null, 2), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
  }
  return {
    list: (projectPath) => read().filter((w) => !w.archived && (projectPath === undefined || w.projectPath === projectPath)),
    get: (id) => read().find((w) => w.id === id && !w.archived),
    save(input, id) {
      const parsed = workflowInputSchema.parse(input)
      if (parsed.intervalMinutes && parsed.calendar) throw new Error('Choose either a repeat interval or days and a time, not both')
      const rows = read()
      const old = id ? rows.find((w) => w.id === id && !w.archived) : undefined
      if (id && !old) throw new Error('Unknown workflow')
      if (old && old.projectPath !== parsed.projectPath) throw new Error('A workflow cannot move to another project')
      if (old && old.name !== parsed.name) throw new Error('A workflow keeps its reference name, so @workflow: mentions keep working. Change its title instead.')
      if (rows.some((w) => !w.archived && w.id !== id && w.projectPath === parsed.projectPath && w.name === parsed.name)) {
        throw new Error('A workflow with that name already exists in this project')
      }
      const now = new Date().toISOString()
      // Editing instructions or permissions always pauses the schedule for review.
      // Blank title/collection clear them rather than keeping the old value.
      const cleared = { title: parsed.title || undefined, collection: parsed.collection || undefined }
      const next: Workflow = { ...old, ...parsed, ...cleared, id: old?.id ?? randomUUID(), enabled: false, nextRunAt: null,
        archived: false, createdAt: old?.createdAt ?? now, updatedAt: now, lastError: undefined }
      write(old ? rows.map((w) => w.id === id ? next : w) : [...rows, next])
      return next
    },
    update(id, patch) {
      const rows = read()
      const old = rows.find((w) => w.id === id && !w.archived)
      if (!old) throw new Error('Unknown workflow')
      const next = workflowSchema.parse({ ...old, ...patch, updatedAt: new Date().toISOString() })
      write(rows.map((w) => w.id === id ? next : w))
      return next
    },
  }
}

/** References compose instructions into one turn, not separate agent runs. Returns the agent's text. */
export function expandWorkflows(text: string, projectPath: string, store: WorkflowStore): string {
  return resolveWorkflows(text, projectPath, store).text
}

/** The agent's text plus each referenced workflow's instructions as they were used, once per name, in order. */
export function resolveWorkflows(text: string, projectPath: string, store: WorkflowStore): { text: string; used: WorkflowSnapshot[] } {
  const workflows = store.list(projectPath)
  const used = new Map<string, WorkflowSnapshot>()
  let references = 0
  const expand = (input: string, stack: string[]): string => {
    const output = input.replace(WORKFLOW_REFERENCE, (_match, lead: string, name: string) => {
      if (++references > 32 || stack.length >= 8) throw new MessageReferenceError('Too many nested workflow references')
      if (stack.includes(name)) throw new MessageReferenceError(`Circular workflow reference: ${[...stack, name].join(' → ')}`)
      const workflow = workflows.find((w) => w.name === name)
      if (!workflow) throw new MessageReferenceError(`Unknown workflow in this project: ${name}`)
      if (!used.has(name)) used.set(name, { name, prompt: workflow.prompt })
      return `${lead}\nWorkflow ${name}:\n${expand(workflow.prompt, [...stack, name])}\n`
    })
    if (output.length > 200_000) throw new MessageReferenceError('Expanded workflow exceeds 200,000 characters')
    return output
  }
  const output = expand(text, [])
  return { text: output, used: [...used.values()] }
}
