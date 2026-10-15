import type { Project } from '../../projects/store.ts'
import type { ThreadMeta, ThreadSettings } from '../../threads/types.ts'

export interface ResolvedClaudeSetup {
  readonly hooks: boolean
  readonly connectors: boolean
  readonly connectorsSuppressed: boolean
}

/** Legacy absence is a capability ceiling; new clients send `inherit` explicitly. */
export function resolveClaudeSetup(settings: ThreadSettings, project: Pick<Project, 'claudeHooks' | 'claudeMcp'> | undefined,
  origin: Pick<ThreadMeta, 'workflowTrigger' | 'createdByThreadId'>): ResolvedClaudeSetup {
  const excluded = origin.workflowTrigger === 'scheduled' || origin.createdByThreadId !== undefined
  const choice = (override: 'inherit' | 'on' | 'off' | undefined, legacy: boolean, projectOn: boolean): boolean =>
    override === 'on' ? true : override === 'off' ? false : override === 'inherit' ? projectOn : legacy
  const hooks = excluded ? settings.useHooks : choice(settings.hooksSetup, settings.useHooks, project?.claudeHooks !== false)
  const wantedConnectors = !excluded && choice(settings.mcpSetup, false, project?.claudeMcp !== false)
  const connectorsSuppressed = wantedConnectors && (settings.permissionMode === 'dontAsk' || settings.permissionMode === 'bypassPermissions')
  return { hooks, connectors: wantedConnectors && !connectorsSuppressed, connectorsSuppressed }
}
