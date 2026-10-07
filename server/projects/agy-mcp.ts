// P3: the per-project opt-in for Antigravity to use Cockpit's tools (W10.1, W10-04). Connect and
// Disconnect are the user's explicit actions in project settings; a launch only keeps the plugin
// in place. The plugin holds no secret; the session token goes in agy's own environment.
import { connectPlugin, disconnectPlugin, entryFor, type PluginFailure } from '../agents/antigravity/mcp-plugin.ts'
import type { McpCommand } from '../mcp/sessions.ts'
import type { Project, ProjectStore } from './store.ts'

export type AgyMcpChange =
  | { readonly ok: true; readonly project: Project; readonly message?: string; readonly backup?: string }
  | PluginFailure
  | { readonly ok: false; readonly code: 'unavailable' | 'unknown_project'; readonly message: string }

export interface AgyMcp {
  setConnected(projectPath: string, connected: boolean): AgyMcpChange
  /** Just before an Antigravity session starts: may it get Cockpit's tools in this folder? */
  prepare(projectPath: string): { readonly ready: boolean; readonly reason?: string }
}

export function createAgyMcp(projects: ProjectStore, command: McpCommand | undefined): AgyMcp {
  const find = (path: string): Project | undefined => projects.list().find((p) => p.path === path)
  return {
    setConnected(projectPath, connected) {
      const project = find(projectPath)
      if (!project) return { ok: false, code: 'unknown_project', message: 'Open this project first' }
      if (!connected) {
        if (!project.antigravityMcp) return { ok: true, project }
        const result = disconnectPlugin(projectPath, project.antigravityMcp)
        if (!result.ok) return result
        return { ok: true, project: projects.setAntigravityMcp(projectPath, undefined), ...(result.message ? { message: result.message } : {}) }
      }
      if (!command) return { ok: false, code: 'unavailable', message: "Cockpit's tools are available to agents in the Cockpit app only." }
      const result = connectPlugin(projectPath, entryFor(command), { mode: 'connect', ...(project.antigravityMcp ? { owned: project.antigravityMcp } : {}) })
      if (!result.ok) return result
      return { ok: true, project: projects.setAntigravityMcp(projectPath, result.ownership), ...(result.backup ? { backup: result.backup } : {}) }
    },
    prepare(projectPath) {
      const owned = find(projectPath)?.antigravityMcp
      if (!owned || !command) return { ready: false }
      const result = connectPlugin(projectPath, entryFor(command), { mode: 'launch', owned })
      if (!result.ok) return { ready: false, reason: result.message }
      // The app moved or was rebuilt: its own unchanged entry was rewritten, so record what is there now.
      if (result.ownership.entryHash !== owned.entryHash || result.ownership.created.length !== owned.created.length) projects.setAntigravityMcp(projectPath, result.ownership)
      return { ready: true }
    },
  }
}
