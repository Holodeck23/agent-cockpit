// What Install, Update and Sign in run, per agent and per installer (G-LIFECYCLE "Selected
// mechanism"). Every plan is a fixed executable and argument vector: nothing is assembled from
// agent output or a model name, nothing uses sudo, and anything Cockpit cannot run safely becomes
// the exact manual command plus Recheck.
import { accessSync, constants } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentCapabilities } from '../capabilities/types.ts'
import type { AgentId } from '../types.ts'

export interface InstallerSpec {
  readonly url: string
  /** The official script's bytes as reviewed (G-LIFECYCLE installers/SHA256SUMS, 2026-10-06). */
  readonly sha256: string
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}

/** Changed bytes upstream mean a new review, not a silent run: until then the manual route is offered. */
export const INSTALLERS: Readonly<Partial<Record<AgentId, InstallerSpec>>> = {
  claude: { url: 'https://claude.ai/install.sh', sha256: '3a68d3406cf674e17bed1733a4dcf37805e2e47d87417700007d7e1aa766a944', args: [] },
  // Never offers to remove an existing Homebrew or npm copy.
  codex: { url: 'https://chatgpt.com/codex/install.sh', sha256: '150e3cf675682efeaac115aa3747add3f27887896d04ce6d0b56478d8b428bf6', args: [], env: { CODEX_NON_INTERACTIVE: '1' } },
  antigravity: { url: 'https://antigravity.google/cli/install.sh', sha256: '62966c07365423bd4dc209355060744058fb30d60f5323e2d360e39de64e5042', args: [] },
}

export const AGENT_LABEL: Record<AgentId, string> = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', opencode: 'OpenCode' }

export const manualInstall = (agent: AgentId): string =>
  agent === 'opencode' ? 'curl -fsSL https://opencode.ai/install | bash   (see opencode.ai/docs)' : `curl -fsSL ${INSTALLERS[agent]!.url} | bash`

/** Homebrew must not prune unrelated formulae while updating (G-LIFECYCLE: a codex update removed ripgrep). */
export const BREW_ENV = { HOMEBREW_NO_INSTALL_CLEANUP: '1', HOMEBREW_NO_AUTOREMOVE: '1' } as const

export type Plan =
  | {
    readonly available: true
    readonly executable: string
    readonly args: readonly string[]
    readonly env?: Readonly<Record<string, string>>
    /** Where the result lands, shown before the explicit action. */
    readonly destination?: string
    /** What the user should expect: a browser, a code, a silent download. */
    readonly interaction: string
  }
  | { readonly available: false; readonly reason: string; readonly manual?: string }

const writable = (path: string): boolean => {
  try { accessSync(path, constants.W_OK); return true } catch { return false }
}

const UPDATE_INTERACTION = 'No input needed. Conversations using it are not interrupted: the update waits until they finish.'

export function updatePlanFor(caps: AgentCapabilities, tools: { readonly brew?: string }): Plan {
  const { agent } = caps
  if (caps.executable.state === 'missing') return { available: false, reason: `${AGENT_LABEL[agent]} is not installed.` }
  const { path, realpath } = caps.executable.identity
  const kind = caps.manager?.kind ?? 'unknown'
  const run = (env?: Readonly<Record<string, string>>): Plan => ({ available: true, executable: path, args: ['update'], ...(env ? { env } : {}), destination: realpath, interaction: UPDATE_INTERACTION })
  const cask = /\/Caskroom\/([^/]+)\//.exec(realpath)
  if (kind === 'homebrew' && cask) {
    const caskDir = realpath.slice(0, cask.index + cask[0].length - 1)
    const manual = `brew upgrade --cask ${cask[1]}`
    // Owned by another account (an admin install): Cockpit never uses sudo, so it hands over the command.
    if (!writable(caskDir)) return { available: false, reason: `Homebrew's folder ${dirname(caskDir)} is not writable by you, so Cockpit cannot update it.`, manual }
    if (agent === 'codex') return run(BREW_ENV)
    if (!tools.brew) return { available: false, reason: 'Homebrew is not on the PATH Cockpit uses.', manual }
    return { available: true, executable: tools.brew, args: ['upgrade', '--cask', cask[1]!], env: BREW_ENV, destination: realpath, interaction: UPDATE_INTERACTION }
  }
  if (agent === 'claude' && kind === 'npm') {
    const pkg = realpath.slice(0, realpath.indexOf('/@anthropic-ai/claude-code/') + '/@anthropic-ai/claude-code'.length)
    if (!writable(dirname(pkg))) return { available: false, reason: `npm's global folder ${dirname(pkg)} is not writable by you; Cockpit does not use sudo.`, manual: 'npm install -g @anthropic-ai/claude-code@latest' }
    return run()
  }
  if ((agent === 'claude' && kind === 'native') || (agent === 'codex' && kind !== 'unknown') || (agent === 'antigravity' && kind === 'native')) {
    return run(agent === 'codex' ? BREW_ENV : undefined)
  }
  const manual = agent === 'opencode' ? 'opencode upgrade' : `${caps.executable.identity.command} update`
  return { available: false, reason: `Cockpit does not know how ${AGENT_LABEL[agent]} at ${path} was installed, so it does not update it.`, manual }
}

export function installPlanFor(agent: AgentId, caps: AgentCapabilities, home: string): Plan {
  if (caps.executable.state !== 'missing') {
    const where = caps.executable.identity.path
    return { available: false, reason: `${AGENT_LABEL[agent]} is already installed at ${where}${caps.manager ? ` (${caps.manager.label})` : ''}. Use Update instead; Cockpit never installs a second copy.` }
  }
  const spec = INSTALLERS[agent]
  if (!spec) return { available: false, reason: `Cockpit does not install ${AGENT_LABEL[agent]}. Install it yourself, then Recheck.`, manual: manualInstall(agent) }
  const interaction = agent === 'claude'
    ? "No input needed. Claude Code's installer prints nothing while it downloads (about 3 minutes); Cancel stops it."
    : agent === 'antigravity'
      ? 'No input needed; the installer prints each step. Afterwards, sign in by running agy once in Terminal.'
      : 'No input needed; the installer prints each step.'
  return { available: true, executable: '/bin/bash', args: [...spec.args], ...(spec.env ? { env: spec.env } : {}), destination: join(home, '.local', 'bin', commandOf(agent)), interaction }
}

const commandOf = (agent: AgentId): string => ({ claude: 'claude', codex: 'codex', antigravity: 'agy', opencode: 'opencode' })[agent]

export function signinPlanFor(caps: AgentCapabilities): Plan {
  const { agent } = caps
  if (caps.executable.state !== 'found') return { available: false, reason: `${AGENT_LABEL[agent]} is not installed or did not answer.` }
  const path = caps.executable.identity.path
  if (agent === 'claude') return { available: true, executable: path, args: ['auth', 'login'], interaction: 'Opens your browser to sign in. If Claude Code asks for a code, paste it here.' }
  if (agent === 'codex') return { available: true, executable: path, args: ['login'], interaction: 'Opens your browser to sign in; Codex waits on this Mac for the answer.' }
  if (agent === 'antigravity') return { available: false, reason: 'Antigravity signs in from its own first run.', manual: 'agy' }
  return { available: false, reason: 'Cockpit does not sign in to OpenCode; use its own setup.', manual: 'opencode auth login' }
}
