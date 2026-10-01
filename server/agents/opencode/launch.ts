import type { PERMISSION_MODES } from '../claude/flags.ts'
import { launchAcp, type AcpMcpServer } from '../acp/launch.ts'
import type { AgentSession, EventSink } from '../types.ts'

// OpenCode (https://opencode.ai) through its Agent Client Protocol mode, `opencode acp`. It reaches any
// provider OpenCode supports, OpenRouter included: a model named "openrouter/<provider>/<model>" uses
// the key stored once with `opencode auth login`. Cockpit passes the model and the permissions as
// OPENCODE_CONFIG_CONTENT, the highest-priority layer of OpenCode's config, so the user's own
// opencode.json is left alone.

type Permission = 'ask' | 'allow' | 'deny'

/** Cockpit's permission modes in OpenCode's per-tool ask/allow/deny. */
export function opencodePermission(mode: (typeof PERMISSION_MODES)[number]): Record<'edit' | 'bash' | 'webfetch', Permission> {
  switch (mode) {
    case 'plan':
      return { edit: 'deny', bash: 'ask', webfetch: 'ask' }
    case 'acceptEdits':
      return { edit: 'allow', bash: 'ask', webfetch: 'ask' }
    case 'auto':
    case 'dontAsk':
    case 'bypassPermissions':
      return { edit: 'allow', bash: 'allow', webfetch: 'allow' }
    default:
      return { edit: 'ask', bash: 'ask', webfetch: 'ask' }
  }
}

export function opencodeConfig(settings: { model?: string; permissionMode: (typeof PERMISSION_MODES)[number] }): string {
  return JSON.stringify({ ...(settings.model ? { model: settings.model } : {}), permission: opencodePermission(settings.permissionMode) })
}

export interface OpencodeLaunchInput {
  readonly cwd: string
  readonly model?: string
  readonly permissionMode: (typeof PERMISSION_MODES)[number]
  readonly resume?: string
  readonly instructions?: string
  readonly mcp?: { readonly server: AcpMcpServer; readonly env: Readonly<Record<string, string>> }
}

export function launchOpencode(input: OpencodeLaunchInput, onEvent: EventSink): AgentSession {
  return launchAcp({
    agent: 'opencode', label: 'OpenCode', command: 'opencode', args: ['acp'], cwd: input.cwd,
    env: { OPENCODE_CONFIG_CONTENT: opencodeConfig(input), ...input.mcp?.env },
    ...(input.resume ? { resume: input.resume } : {}),
    ...(input.instructions ? { instructions: input.instructions } : {}),
    ...(input.mcp ? { mcpServers: [input.mcp.server] } : {}),
  }, onEvent)
}
