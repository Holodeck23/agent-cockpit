// Dev commands fork: `npm run dev` → sh → node → esbuild. Killing only the
// direct child leaves the server holding its port, so every managed process is
// spawned as its own process group and stopped as a group. There is no stdin
// EOF step (unlike agents in ../agents/stop.ts): a dev server ignores it.

export const GROUP_GRACE_MS = 3000
const POLL_MS = 50

/** True while any process in the group still exists. */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error: unknown) {
    // EPERM means it exists but belongs to someone else, which cannot happen for our own children.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal)
  } catch {
    // Already gone.
  }
}

async function waitGone(pgid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) return true
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  return !groupAlive(pgid)
}

/** SIGTERM to the whole group, SIGKILL after `graceMs`. Resolves once every member is gone. */
export async function stopGroup(pgid: number, graceMs: number = GROUP_GRACE_MS): Promise<'none' | 'SIGTERM' | 'SIGKILL'> {
  if (!groupAlive(pgid)) return 'none'
  signalGroup(pgid, 'SIGTERM')
  if (await waitGone(pgid, graceMs)) return 'SIGTERM'
  signalGroup(pgid, 'SIGKILL')
  await waitGone(pgid, graceMs)
  return 'SIGKILL'
}
