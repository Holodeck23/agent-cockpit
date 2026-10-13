import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Stable development state per checkout, independent of an inherited desktop COCKPIT_HOME. */
export function developmentRoot(cwd = process.cwd(), env = process.env, home = homedir()): string {
  const checkout = createHash('sha256').update(realpathSync(cwd)).digest('hex').slice(0, 16)
  const root = env.COCKPIT_DEV_HOME ? resolve(cwd, env.COCKPIT_DEV_HOME) : join(home, '.agent-cockpit-dev', checkout)
  const desktop = resolve(cwd, env.COCKPIT_HOME ?? join(home, '.agent-cockpit'))
  const canonical = (path: string): string => existsSync(path) ? realpathSync(path) : resolve(path)
  if (canonical(root) === canonical(desktop)) {
    throw new Error('Development preview must use separate state. Set COCKPIT_DEV_HOME to a different folder.')
  }
  return root
}
