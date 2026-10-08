// Where the Help menu, Report a Problem and connection errors send people. Shared by the
// Electron menu and the page, so both point at the same public guide.

const REPO = 'https://github.com/Holodeck23/agent-cockpit'
const DOCS = `${REPO}/blob/main/docs/user`

export const HELP = {
  guide: `${DOCS}/guide.md`,
  troubleshooting: `${DOCS}/troubleshooting.md`,
  network: `${DOCS}/troubleshooting.md#network-problems`,
  releases: `${REPO}/releases`,
} as const

/**
 * Installs or updates Cockpit from Terminal (install.sh). curl does not quarantine what it downloads,
 * so the app opens without the Gatekeeper block a browser download gets: Cockpit is not notarized.
 */
export const INSTALL_COMMAND = 'curl -fsSL https://raw.githubusercontent.com/Holodeck23/agent-cockpit/main/install.sh | sh'

/** A new GitHub issue with the version and Mac filled in. No paths, logs or project names. */
export function issueUrl(info: { version: string; macos: string; arch: string }): string {
  const body = [
    '**What happened?**', '', '', '**What did you expect?**', '', '', '**Steps to reproduce**', '1. ', '',
    '---', `Cockpit ${info.version} · macOS ${info.macos} (${info.arch})`,
  ].join('\n')
  return `${REPO}/issues/new?${new URLSearchParams({ body })}`
}

export type FeedbackKind = 'bug' | 'feedback'
export interface FeedbackReport {
  readonly kind: FeedbackKind
  readonly title: string
  readonly details: string
  /** Cockpit's version and the Mac, only when the person leaves "Include" on. */
  readonly info?: { version: string; macos: string; arch: string }
}

/** GitHub refuses very long new-issue links; the rest can be added on the page. */
export const FEEDBACK_DETAILS_MAX = 6000

/**
 * The toolbar's Report a bug / Send feedback: a new public GitHub issue, filled in and opened in
 * the browser. Nothing is sent from Cockpit; the person reviews it there and submits it (or not).
 */
export function feedbackUrl(report: FeedbackReport): string {
  const details = report.details.trim()
  const shown = details.length > FEEDBACK_DETAILS_MAX ? `${details.slice(0, FEEDBACK_DETAILS_MAX)}\n\n(shortened: paste the rest here)` : details
  const body = [
    shown || (report.kind === 'bug' ? '**What happened?**\n\n\n**What did you expect?**\n\n\n**Steps to reproduce**\n1. ' : ''),
    ...(report.info ? ['', '---', `Cockpit ${report.info.version} · macOS ${report.info.macos} (${report.info.arch})`] : []),
  ].join('\n')
  const title = `${report.kind === 'bug' ? 'Bug' : 'Feedback'}: ${report.title.trim()}`
  return `${REPO}/issues/new?${new URLSearchParams({ title, body, labels: report.kind === 'bug' ? 'bug' : 'enhancement' })}`
}

// Network failures as Node, Chromium and the agent CLIs word them.
const CONNECTION = /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|CERT_\w+|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\b|failed to fetch|fetch failed|connection (error|refused|reset|timed out)|could not reach|network (error|is unreachable)|socket hang up/i

export const looksLikeConnectionError = (text: string): boolean => CONNECTION.test(text)
