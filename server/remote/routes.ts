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
  { method: 'POST', route: 'threads/:id/agent', phone: false },

  // Branches and commits stay on the Mac.
  { method: 'GET', route: 'git', phone: false },
  { method: 'GET', route: 'git/commit', phone: false },
  { method: 'POST', route: 'git/push', phone: false },
  { method: 'POST', route: 'git/switch', phone: false },
  { method: 'POST', route: 'git/create', phone: false },
]

const patternOf = (route: string): RegExp =>
  new RegExp(`^/api/${route.split('/').map((s) => (s.startsWith(':') ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}$`)

const PHONE: readonly [string, RegExp][] = ROUTES.filter((r) => r.phone).map((r) => [r.method, patternOf(r.route)])

export function isPhoneRoute(method: string, pathname: string): boolean {
  return PHONE.some(([m, pattern]) => m === method && pattern.test(pathname))
}
