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

/** A new GitHub issue with the version and Mac filled in. No paths, logs or project names. */
export function issueUrl(info: { version: string; macos: string; arch: string }): string {
  const body = [
    '**What happened?**', '', '', '**What did you expect?**', '', '', '**Steps to reproduce**', '1. ', '',
    '---', `Cockpit ${info.version} · macOS ${info.macos} (${info.arch})`,
  ].join('\n')
  return `${REPO}/issues/new?${new URLSearchParams({ body })}`
}

// Network failures as Node, Chromium and the agent CLIs word them.
const CONNECTION = /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|CERT_\w+|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\b|failed to fetch|fetch failed|connection (error|refused|reset|timed out)|could not reach|network (error|is unreachable)|socket hang up/i

export const looksLikeConnectionError = (text: string): boolean => CONNECTION.test(text)
