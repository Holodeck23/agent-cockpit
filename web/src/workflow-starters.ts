// Five editable starters, written for Cockpit. Adding one saves a paused copy in the
// project: it never runs or schedules itself. Read-only jobs use Plan permissions;
// the dev-server starter keeps asking before it starts anything.
import type { ThreadSettings } from './api.ts'

export interface WorkflowStarter {
  readonly name: string
  readonly title: string
  readonly collection: string
  readonly summary: string
  readonly prompt: string
  readonly permissionMode: ThreadSettings['permissionMode']
}

export const WORKFLOW_STARTERS: readonly WorkflowStarter[] = [
  {
    name: 'project-orientation',
    title: 'Project orientation',
    collection: 'Understand',
    summary: 'A short map of how this project fits together.',
    permissionMode: 'plan',
    prompt: [
      'Give me a one-page orientation to this project without changing anything.',
      'Cover: what it does, how to run it, the main folders and what lives in each, where the entry points are, and how it is tested.',
      'End with the three files a newcomer should read first, and anything that looks surprising or fragile.',
    ].join('\n'),
  },
  {
    name: 'focused-review',
    title: 'Focused review',
    collection: 'Quality',
    summary: 'Reviews the uncommitted changes for real bugs.',
    permissionMode: 'plan',
    prompt: [
      'Review the uncommitted changes in this project (use git diff) without editing files.',
      'Report only real problems: bugs, missing error handling, security issues, and behaviour that contradicts nearby code.',
      'For each: the file and line, what goes wrong in a concrete case, and a suggested fix. Say plainly if you find nothing.',
    ].join('\n'),
  },
  {
    name: 'release-check',
    title: 'Release check',
    collection: 'Quality',
    summary: 'Runs the checks and says whether it is ready to ship.',
    permissionMode: 'plan',
    prompt: [
      'Tell me whether this project is ready to release, without changing any files.',
      'Find and run its own checks (tests, type check, lint, build) as documented in the repository.',
      'Report each check with pass or fail and the relevant output, list anything uncommitted, and finish with ready or not ready and why.',
    ].join('\n'),
  },
  {
    name: 'handoff-note',
    title: 'Handoff note',
    collection: 'Handoffs',
    summary: 'Writes up where the work stands for the next person.',
    permissionMode: 'plan',
    prompt: [
      'Write a handoff note for whoever picks this project up next. Put it in your reply; do not create files.',
      'Include: what changed recently (from git log and the working tree), what is unfinished, known problems, and the next three steps.',
      'Keep it under 300 words and name files rather than describing them.',
    ].join('\n'),
  },
  {
    name: 'dev-server-startup',
    title: 'Start the dev server',
    collection: 'Run',
    summary: 'Starts the app, checks its log, and opens it.',
    permissionMode: 'manual',
    prompt: [
      "Get this project's dev server running, check its log for errors, and show me the site.",
      'If it is already running, reuse it. If it fails to start, show me the error and suggest the fix instead of guessing.',
    ].join('\n'),
  },
]

/** A slug not already taken in the project: "focused-review", then "focused-review-2", … */
export function freeName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
}
