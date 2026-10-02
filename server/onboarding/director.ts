import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentStatus } from '../agents/status.ts'
import type { AgentId } from '../agents/types.ts'
import type { ThreadMeta } from '../threads/types.ts'
import { SAMPLE_SERVER } from './sample.ts'

/** Keep provider model/effort defaults and require approval for actions. */
export function automaticAgent(statuses: readonly AgentStatus[], recent: readonly ThreadMeta[] = [], sample = false): AgentId | undefined {
  const installed = new Set(statuses.filter((s) => s.installation.installed && (!sample || s.id !== 'antigravity')).map((s) => s.id))
  const last = [...recent].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).find((t) => installed.has(t.settings.agent))
  return last?.settings.agent ?? (['claude', 'codex', 'opencode', 'antigravity'] as const).find((id) => installed.has(id))
}

export function directorDismissed(root: string): boolean {
  return existsSync(join(root, 'first-run-dismissed'))
}

export function dismissDirector(root: string): void {
  // An exclusive marker survives port/profile changes; existing bytes are never replaced.
  try { writeFileSync(join(root, 'first-run-dismissed'), 'Dismissed\n', { flag: 'wx', mode: 0o600 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
}

export function prepareSample(root: string): { projectPath: string; text: string } {
  const projectPath = join(root, 'samples', '90-second-sample')
  mkdirSync(projectPath, { recursive: true, mode: 0o700 })
  const file = join(projectPath, 'server.cjs')
  // Retrying the sample preserves any edits the user or agent made.
  try { writeFileSync(file, SAMPLE_SERVER, { flag: 'wx', mode: 0o600 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
  const command = `ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} server.cjs`
  return { projectPath, text: `Show me this sample app. Use Cockpit's start_process tool with command ${command} and name "90-second sample". Read its output to find the local URL, open it with open_preview, and inspect it with inspect_preview. Do not install dependencies or edit files. Tell me what you actually see and suggest one small change I could try next. If a step fails, explain the failure instead of claiming success.` }
}

export const ORIENTATION_PROMPT = 'Help me pick up work in this project. Read its instructions and a few key files, check Git state if it is a repository, then briefly explain what it does, where work seems to have stopped, and one useful next step. Ground your conclusion in file names and observed state. Do not edit files, install dependencies, or start processes yet.'
