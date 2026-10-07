// One structural Git operation at a time per repository (worktree create, merge, remove), keyed by
// the repository's shared .git folder so a primary checkout and its worktrees share one lock.
// In-process only: Cockpit is one process per state folder, and Git's own index.lock still guards
// against an agent or a terminal running git at the same moment.

const held = new Map<string, Promise<unknown>>()

export function withRepoLock<T>(repo: string, operation: () => Promise<T>): Promise<T> {
  const previous = held.get(repo) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(operation)
  const settled = next.catch(() => undefined)
  held.set(repo, settled)
  void settled.then(() => { if (held.get(repo) === settled) held.delete(repo) })
  return next
}

export const repoLockHeld = (repo: string): boolean => held.has(repo)
