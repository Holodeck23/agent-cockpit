import { WORKFLOW_REFERENCE } from '../files/references.ts'
import type { WorkflowStore } from './store.ts'

/** A12: how a conversation started from a workflow is titled; the string is kept, so later renames leave it. */
export const titleFor = (workflow: { readonly title?: string; readonly name: string }): string => `@${workflow.title || workflow.name}`

/**
 * The title for a new conversation whose message opens with a reference to exactly one workflow
 * (what a workflow card puts in the message box). Several different workflows, or a reference
 * later in the message, choose none: the conversation keeps its ordinary title.
 */
export function workflowTitle(text: string, projectPath: string, store: WorkflowStore): string | undefined {
  const names = new Set([...text.matchAll(WORKFLOW_REFERENCE)].map((match) => match[2]!))
  if (names.size !== 1) return undefined
  const [name] = names
  if (!text.trimStart().startsWith(`@workflow:${name}`)) return undefined
  const workflow = store.list(projectPath).find((w) => w.name === name)
  return workflow ? titleFor(workflow) : undefined
}
