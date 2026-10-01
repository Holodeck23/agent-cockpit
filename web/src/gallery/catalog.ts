// Cockpit's workflow gallery: original instructions, written for Cockpit. Most work inside the
// open repository. Ones that reach outside it name the tools they rely on, and tell the agent to
// stop and say so when a tool is missing. Adding one saves a paused copy: never run, never scheduled.
// Read-only jobs use Plan permissions; anything that runs commands asks first (Manual).
import type { ThreadSettings } from '../api.ts'

export const CATEGORIES = ['Understand', 'Quality', 'Maintenance', 'Git and handoffs', 'Run and debug', 'Mail, calendar and web'] as const
export type Category = (typeof CATEGORIES)[number]
export type Tool = 'Mail' | 'Calendar' | 'Browser' | 'GitHub CLI'

export interface GalleryWorkflow {
  /** Reference name the copy starts from; unique in the gallery. */
  readonly name: string
  readonly title: string
  readonly category: Category
  readonly summary: string
  readonly prompt: string
  readonly permissionMode: Extract<ThreadSettings['permissionMode'], 'plan' | 'manual'>
  /** Suggested repeat (0 = Sunday … 6 = Saturday, local time); null = on demand. */
  readonly schedule: { readonly days: readonly number[]; readonly time: string } | null
  /** Tools beyond the repository the agent needs. */
  readonly needs?: readonly Tool[]
  readonly featured?: boolean
}

const WEEKDAYS = [1, 2, 3, 4, 5]
const MONDAY = [1]
const FRIDAY = [5]
const lines = (...text: string[]): string => text.join('\n')

export const GALLERY: readonly GalleryWorkflow[] = [
  // Understand
  {
    name: 'project-orientation', title: 'Project orientation', category: 'Understand', featured: true,
    summary: 'A one-page map of how this project fits together.', permissionMode: 'plan', schedule: null,
    prompt: lines(
      'Give me a one-page orientation to this project without changing anything.',
      'Cover: what it does, how to run it, the main folders and what lives in each, where the entry points are, and how it is tested.',
      'End with the three files a newcomer should read first, and anything that looks surprising or fragile.'),
  },
  {
    name: 'architecture-sketch', title: 'Architecture sketch', category: 'Understand',
    summary: 'The main parts and how data moves between them, as a text diagram.', permissionMode: 'plan', schedule: null,
    prompt: lines(
      'Draw the architecture of this project as a plain-text diagram, without changing anything.',
      'Show the main parts (apps, services, packages or modules), what each one owns, and how data moves between them: requests, events, files, databases.',
      'Under the diagram, give each arrow one line naming the file where that connection is made. Mark anything you inferred rather than read in the code.'),
  },
  {
    name: 'week-in-review', title: 'What changed this week', category: 'Understand', featured: true,
    summary: 'The last seven days of commits, grouped by area of the code.', permissionMode: 'plan', schedule: { days: MONDAY, time: '09:00' },
    prompt: lines(
      'Summarise what changed in this repository over the last seven days, without editing anything. Use git log and git diff for that period.',
      'Group the changes by area of the code, not by commit. For each area, say what changed and why it matters to someone using or maintaining it.',
      'List separately any commits that look risky (very large, touching configuration, deleting tests), with their short hashes.'),
  },
  {
    name: 'todo-sweep', title: 'TODO sweep', category: 'Understand',
    summary: 'Every TODO and FIXME, how old it is, and which to do first.', permissionMode: 'plan', schedule: { days: FRIDAY, time: '15:00' },
    prompt: lines(
      'Collect the TODO, FIXME, HACK and XXX comments in this project, without changing anything. Skip dependencies and generated files.',
      'Group them by file, and use git blame to say how long each has been there.',
      'Finish with the five worth doing first, and why: risk to users first, then how often the code around them changes.'),
  },

  // Quality
  {
    name: 'focused-review', title: 'Focused review', category: 'Quality', featured: true,
    summary: 'Reviews the uncommitted changes for real bugs.', permissionMode: 'plan', schedule: null,
    prompt: lines(
      'Review the uncommitted changes in this project (use git diff) without editing files.',
      'Report only real problems: bugs, missing error handling, security issues, and behaviour that contradicts nearby code.',
      'For each: the file and line, what goes wrong in a concrete case, and a suggested fix. Say plainly if you find nothing.'),
  },
  {
    name: 'release-check', title: 'Release check', category: 'Quality',
    summary: 'Runs the checks and says whether it is ready to ship.', permissionMode: 'plan', schedule: null,
    prompt: lines(
      'Tell me whether this project is ready to release, without changing any files.',
      'Find and run its own checks (tests, type check, lint, build) as documented in the repository.',
      'Report each check with pass or fail and the relevant output, list anything uncommitted, and finish with ready or not ready and why.'),
  },
  {
    name: 'test-gaps', title: 'Find untested code', category: 'Quality',
    summary: 'The code most in need of tests, with cases worth writing.', permissionMode: 'plan', schedule: null,
    prompt: lines(
      'Find the code in this project most in need of tests, without writing any.',
      'Compare the test files with the source they cover, then name up to ten functions or modules with no test, ordered by how much breaks if they are wrong.',
      'For each, describe two test cases worth writing: the input and the result you would expect.'),
  },
  {
    name: 'morning-test-run', title: 'Morning test run', category: 'Quality',
    summary: 'Runs the tests and type check; one line if all is well.', permissionMode: 'manual', schedule: { days: WEEKDAYS, time: '07:30' },
    prompt: lines(
      "Run this project's test suite and type check as documented in the repository. Do not change any files.",
      'If everything passes, reply with one line saying so and how long it took.',
      'If anything fails, list each failure with the test name, the error, the file and line, and the most recent commit that touched that file.'),
  },
  {
    name: 'security-pass', title: 'Security pass', category: 'Quality',
    summary: 'Looks for common security mistakes in the code.', permissionMode: 'plan', schedule: null,
    prompt: lines(
      'Look through this project for common security mistakes, without changing anything:',
      'secrets or tokens committed to the repository; user input reaching a shell, a SQL query or a file path unchecked; routes without authentication; unsafe deserialisation; and dependencies pinned to versions with known advisories, if a lockfile shows them.',
      'For each finding: the file and line, how it could be abused in one sentence, and the fix. Say plainly if you find nothing.'),
  },

  // Maintenance
  {
    name: 'dependency-check', title: 'Outdated dependencies', category: 'Maintenance', featured: true,
    summary: 'What is out of date or has advisories, sorted by risk.', permissionMode: 'manual', schedule: { days: MONDAY, time: '10:00' },
    prompt: lines(
      "List this project's outdated dependencies and any known security advisories, without upgrading anything.",
      'Use the package manager the project already uses, for example npm outdated and npm audit, or pip list --outdated.',
      'Group the results into patch updates, minor updates, and major updates that need their changelog read. For each major update, one line on what is likely to break.'),
  },
  {
    name: 'dead-code-sweep', title: 'Dead code sweep', category: 'Maintenance',
    summary: 'Unused files, exports and scripts, with how sure it is.', permissionMode: 'plan', schedule: null,
    prompt: lines(
      'Find code in this project that nothing uses, without deleting anything:',
      'files that are never imported, exported functions with no callers, branches that cannot run, and scripts or config entries nothing refers to.',
      'For each, say how you checked and how sure you are (certain, likely, or check dynamic use first).'),
  },
  {
    name: 'readme-drift', title: 'README drift check', category: 'Maintenance',
    summary: 'Where the setup instructions no longer match the code.', permissionMode: 'plan', schedule: { days: FRIDAY, time: '11:00' },
    prompt: lines(
      'Check whether the README and other setup docs still match this project, without editing them.',
      'Compare the commands, scripts, environment variables, ports and versions they mention with what the code and configuration actually use.',
      'List each mismatch with the doc line, what is true now, and the corrected wording.'),
  },
  {
    name: 'lint-tidy', title: 'Tidy lint warnings', category: 'Maintenance',
    summary: 'Applies the automatic lint fixes and lists the rest.', permissionMode: 'manual', schedule: null,
    prompt: lines(
      "Run this project's linter and formatter as configured, and apply only the fixes the tools make automatically.",
      'Do not commit, do not change lint rules, and do not hand-edit code to silence a warning.',
      'Show which files changed, then list the warnings that remain with file and line.'),
  },

  // Git and handoffs
  {
    name: 'handoff-note', title: 'Handoff note', category: 'Git and handoffs',
    summary: 'Writes up where the work stands for the next person.', permissionMode: 'plan', schedule: null,
    prompt: lines(
      'Write a handoff note for whoever picks this project up next. Put it in your reply; do not create files.',
      'Include: what changed recently (from git log and the working tree), what is unfinished, known problems, and the next three steps.',
      'Keep it under 300 words and name files rather than describing them.'),
  },
  {
    name: 'commit-message', title: 'Draft a commit message', category: 'Git and handoffs',
    summary: 'A clear message for the staged changes; never commits.', permissionMode: 'plan', schedule: null,
    prompt: lines(
      'Write a commit message for the staged changes (git diff --cached), or for all uncommitted changes if nothing is staged. Do not commit.',
      'A subject line under 70 characters in the imperative, then a body that explains why the change was made and what a reviewer should check.',
      'If the changes do several unrelated things, say so and suggest how to split them.'),
  },
  {
    name: 'pr-description', title: 'Pull request description', category: 'Git and handoffs',
    summary: 'Describes this branch for reviewers, with a test plan.', permissionMode: 'plan', schedule: null,
    prompt: lines(
      'Write a pull request description for the current branch against the default branch. Do not push or open anything.',
      'Use the commits and the full diff. Include what changed and why, the notable changes by area, how it was tested, and a short checklist for the reviewer.',
      'Put migrations, configuration changes and anything that breaks existing behaviour at the top.'),
  },
  {
    name: 'changelog-draft', title: 'Changelog since the last tag', category: 'Git and handoffs',
    summary: 'User-facing release notes from the commits since the last tag.', permissionMode: 'plan', schedule: null,
    prompt: lines(
      'Draft changelog entries for everything since the most recent git tag, without editing files.',
      'Group them under Added, Changed, Fixed and Removed. Write for the people who use the project, and leave out internal refactors unless they change behaviour.',
      'If there is no tag yet, use the whole history and say so.'),
  },
  {
    name: 'standup-notes', title: 'Standup notes', category: 'Git and handoffs',
    summary: 'Done, in progress and blocked, from your own commits.', permissionMode: 'plan', schedule: { days: WEEKDAYS, time: '09:00' },
    prompt: lines(
      'Prepare my standup notes from this repository, without changing anything.',
      'Use my commits since the previous working day (match git config user.email), the current branch, uncommitted work, and branches with commits not yet pushed.',
      'Three short sections: done, in progress, blocked or waiting. Plain sentences, no commit hashes.'),
  },

  // Run and debug
  {
    name: 'dev-server-startup', title: 'Start the dev server', category: 'Run and debug',
    summary: 'Starts the app, checks its log, and opens it.', permissionMode: 'manual', schedule: null,
    prompt: lines(
      "Get this project's dev server running, check its log for errors, and show me the site.",
      'If it is already running, reuse it. If it fails to start, show me the error and suggest the fix instead of guessing.'),
  },
  {
    name: 'explain-latest-error', title: 'Explain the latest error', category: 'Run and debug',
    summary: 'Reads the running processes’ output and explains what broke.', permissionMode: 'manual', schedule: null,
    prompt: lines(
      "Find the most recent error in this project's running processes and explain it. Use Cockpit's process tools to list them and read their recent output.",
      'Quote the error, say which file and line it most likely comes from, explain the cause in plain words, and propose a fix.',
      'Do not change files or restart anything without asking me first.'),
  },
  {
    name: 'build-report', title: 'Build report', category: 'Run and debug',
    summary: 'Runs the production build and reports warnings and sizes.', permissionMode: 'manual', schedule: null,
    prompt: lines(
      "Run this project's production build as documented in the repository. Change nothing except the build output.",
      'Report whether it succeeded, how long it took, every warning, and the size of the main output files or bundles.',
      'If an earlier build output exists, compare sizes and flag anything that grew by more than ten percent.'),
  },

  // Mail, calendar and web
  {
    name: 'morning-brief', title: 'Morning brief', category: 'Mail, calendar and web', needs: ['Calendar', 'Mail'],
    summary: 'Today’s meetings and the emails waiting on you.', permissionMode: 'plan', schedule: { days: WEEKDAYS, time: '08:00' },
    prompt: lines(
      'Prepare a short brief for my day. This needs read access to my calendar and my email; if either is missing, say which and stop.',
      "From the calendar: today's meetings with the time, who is attending, and any agenda in the invitation.",
      'From email: messages from the last day that need a reply from me, one line each on what is being asked. Do not reply to, move or delete anything.'),
  },
  {
    name: 'meeting-prep', title: 'Meeting prep', category: 'Mail, calendar and web', needs: ['Calendar', 'Mail'],
    summary: 'Context and open questions for your next meeting.', permissionMode: 'plan', schedule: null,
    prompt: lines(
      'Help me prepare for my next meeting. This needs read access to my calendar and email; if either is missing, say which and stop.',
      'Find the next meeting on my calendar, then recent email threads with its attendees or about its subject.',
      'Tell me what the meeting is for, what was last said, the open questions, and three things I should be ready to answer. Change nothing.'),
  },
  {
    name: 'live-site-check', title: 'Live site check', category: 'Mail, calendar and web', needs: ['Browser'],
    summary: 'Opens the deployed site and reports what is broken.', permissionMode: 'plan', schedule: { days: WEEKDAYS, time: '08:30' },
    prompt: lines(
      "Check that this project's live website works. This needs a browser tool; if you do not have one, say so and stop.",
      'Find the production address in the README or the deployment configuration, and ask me if you cannot. Open the home page and up to five pages it links to.',
      'Report pages that fail to load, console errors, broken images or links, and anything visibly broken. Do not submit forms or sign in.'),
  },
  {
    name: 'issue-triage', title: 'Issue triage', category: 'Mail, calendar and web', needs: ['GitHub CLI'],
    summary: 'Sorts the week’s GitHub issues by type and priority.', permissionMode: 'manual', schedule: { days: MONDAY, time: '09:30' },
    prompt: lines(
      "Triage this repository's open GitHub issues with the GitHub CLI (gh). If gh is not installed or not signed in, say so and stop.",
      'Take the issues opened or updated in the last week. For each: a one-line summary, whether it is a bug, a request or a question, the files it probably involves, and a suggested priority.',
      'Do not comment on, label or close anything.'),
  },
]
