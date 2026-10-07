import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export interface ResolvedExecutable {
  readonly path: string
  readonly realpath: string
  readonly fingerprint: string
}

/**
 * The executable a spawn of `command` would run: the first executable file on PATH. Spawns
 * nothing. The fingerprint changes whenever the file is replaced, which is how a background
 * self-update (Claude, agy) is noticed without running the CLI.
 */
export function resolveExecutable(command: string, pathEnv: string): ResolvedExecutable | undefined {
  for (const dir of pathEnv.split(':')) {
    if (!dir || !isAbsolute(dir)) continue
    const path = join(dir, command)
    try {
      accessSync(path, constants.X_OK)
      const realpath = realpathSync(path)
      const stat = statSync(realpath)
      if (!stat.isFile()) continue
      return { path, realpath, fingerprint: `${realpath}|${stat.size}|${stat.mtimeMs}|${stat.ino}` }
    } catch {
      // Not here, not executable, or a dangling link: keep looking, as the shell would.
    }
  }
  return undefined
}
