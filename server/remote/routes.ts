// Which API routes the phone may use. Every /api/threads and /api/git route is listed, allowed
// or not, and tests/route-parity.test.ts fails on one the router serves that is missing here,
// so a new route is a decision, never a silent default. `:name` stands for one path segment.

export interface RouteClass {
  readonly method: 'GET' | 'POST' | 'DELETE'
  readonly route: string
  readonly phone: boolean
}

export const ROUTES: readonly RouteClass[] = [
  { method: 'GET', route: 'stream', phone: true },
  { method: 'GET', route: 'projects', phone: true },
  { method: 'GET', route: 'processes', phone: true },
  { method: 'GET', route: 'runs/:id/result', phone: true },
  { method: 'GET', route: 'runs/:id/evidence/:evidenceId', phone: true },
  { method: 'POST', route: 'runs/:id/checks', phone: false },
  { method: 'POST', route: 'runs/:id/preview', phone: false },
  { method: 'POST', route: 'runs/:id/assessments', phone: false },
  { method: 'POST', route: 'checks/:id/cancel', phone: false },

  // Read conversations, reply, answer the agent, stop it.
  { method: 'GET', route: 'threads', phone: true },
  { method: 'GET', route: 'threads/:id/events', phone: true },
  { method: 'GET', route: 'threads/:id/images/:file', phone: true },
  { method: 'POST', route: 'threads/:id/messages', phone: true },
  { method: 'POST', route: 'threads/:id/approvals/:requestId', phone: true },
  { method: 'POST', route: 'threads/:id/questions/:requestId', phone: true },
  { method: 'POST', route: 'threads/:id/queued/:queuedId/remove', phone: true },
  { method: 'POST', route: 'threads/:id/interrupt', phone: true },
  // Starting, finding, reshaping or deleting conversations stays on the Mac.
  { method: 'POST', route: 'threads', phone: false },
  { method: 'GET', route: 'threads/search', phone: false },
  { method: 'DELETE', route: 'threads/:id', phone: false },
  { method: 'POST', route: 'threads/:id/completed', phone: false },
  { method: 'POST', route: 'threads/:id/dismiss', phone: false },
  { method: 'POST', route: 'threads/:id/settings', phone: false },
  { method: 'GET', route: 'threads/:id/handoff', phone: false },
  { method: 'POST', route: 'threads/:id/agent', phone: false },

  // Branches and commits stay on the Mac.
  { method: 'GET', route: 'git', phone: false },
  { method: 'GET', route: 'git/commit', phone: false },
  { method: 'POST', route: 'git/push', phone: false },
  { method: 'POST', route: 'git/switch', phone: false },
  { method: 'POST', route: 'git/create', phone: false },
  // The Changes viewer (J4) opens files in Files, which is on the Mac only.
  { method: 'GET', route: 'git/changes', phone: false },
  { method: 'GET', route: 'git/diff', phone: false },
  { method: 'GET', route: 'git/base', phone: false },
  { method: 'GET', route: 'git/run', phone: false },

  // Agent capabilities name executable paths and sign-in state (W10.1): the Mac only.
  { method: 'GET', route: 'agents/:agent/capabilities', phone: false },
  { method: 'POST', route: 'agents/:agent/capabilities/refresh', phone: false },
  // Install, update, sign-in (W10.2/W10.3): the Mac only, never MCP.
  { method: 'GET', route: 'agents/:agent/lifecycle', phone: false },
  { method: 'POST', route: 'agents/:agent/install', phone: false },
  { method: 'POST', route: 'agents/:agent/update', phone: false },
  { method: 'POST', route: 'agents/:agent/signin', phone: false },
  { method: 'POST', route: 'agents/:agent/updates/check', phone: false },
  { method: 'POST', route: 'agents/:agent/updates/skip', phone: false },
  { method: 'GET', route: 'agent-operations/:id', phone: false },
  { method: 'POST', route: 'agent-operations/:id/cancel', phone: false },
  { method: 'POST', route: 'agent-operations/:id/resume', phone: false },
  { method: 'POST', route: 'agent-operations/:id/input', phone: false },
  // P3: writes a plugin into the project folder (W10-04).
  { method: 'POST', route: 'projects/agy-mcp', phone: false },

  // Phone previews (H5, wave 11). The phone asks for a ticket on its own listener (remote/service.ts);
  // which apps get an origin, and the Tailscale entries for them, are decided on the Mac.
  { method: 'POST', route: 'phone/preview-tickets', phone: true },
  { method: 'GET', route: 'phone/previews', phone: false },
  { method: 'POST', route: 'phone/previews', phone: false },
  { method: 'POST', route: 'phone/previews/:id/serve', phone: false },
  { method: 'POST', route: 'phone/previews/:id/unserve', phone: false },

  // Worktree workspaces (M1, W12.2): folders, branches and repository changes stay on the Mac.
  { method: 'GET', route: 'projects/:id/workspaces', phone: false },
  { method: 'GET', route: 'projects/:id/workspaces/preflight', phone: false },
  { method: 'POST', route: 'projects/:id/workspaces', phone: false },
  { method: 'POST', route: 'workspace-operations/:id/recover', phone: false },
  { method: 'POST', route: 'workspace-operations/:id/dismiss', phone: false },
  // The agent's browser tools (H3, wave 9): agents' MCP calls on the Mac, never the phone.
  { method: 'POST', route: 'mcp/browser/:op', phone: false },
]

const patternOf = (route: string): RegExp =>
  new RegExp(`^/api/${route.split('/').map((s) => (s.startsWith(':') ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}$`)

const PHONE: readonly [string, RegExp][] = ROUTES.filter((r) => r.phone).map((r) => [r.method, patternOf(r.route)])

export function isPhoneRoute(method: string, pathname: string): boolean {
  return PHONE.some(([m, pattern]) => m === method && pattern.test(pathname))
}
