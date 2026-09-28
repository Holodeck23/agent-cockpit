// Launches the PACKAGED Cockpit.app the way Finder does: launchd's bare PATH,
// no terminal environment. Thread state goes to a throwaway COCKPIT_HOME.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication } from 'playwright-core'

export const ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const PROOF_DIR = join(ROOT, 'docs/proof')
export const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
const EXECUTABLE = join(ROOT, 'release/mac-arm64/Cockpit.app/Contents/MacOS/Cockpit')

export async function launchPackagedApp(): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: EXECUTABLE,
    env: {
      HOME: process.env.HOME ?? '',
      USER: process.env.USER ?? '',
      LOGNAME: process.env.LOGNAME ?? process.env.USER ?? '',
      SHELL: process.env.SHELL ?? '/bin/zsh',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      PATH: LAUNCHD_PATH,
      COCKPIT_HOME: mkdtempSync(join(tmpdir(), 'cockpit-app-state-')),
    },
  })
}

export function checker(): { check: (name: string, ok: boolean, detail?: string) => void; finish: (label: string) => never } {
  const results: boolean[] = []
  return {
    check(name, ok, detail) {
      results.push(ok)
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
    },
    finish(label) {
      const failed = results.filter((ok) => !ok).length
      console.log(failed === 0 ? `${label} PASS (${results.length} checks)` : `${label} FAIL (${failed} of ${results.length})`)
      process.exit(failed === 0 ? 0 : 1)
    },
  }
}
