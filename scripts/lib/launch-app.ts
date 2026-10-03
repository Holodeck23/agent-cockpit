// Launches the PACKAGED Cockpit.app the way Finder does: launchd's bare PATH,
// no terminal environment. Thread state goes to a throwaway COCKPIT_HOME.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication } from 'playwright-core'

export const ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const PROOF_DIR = process.env.COCKPIT_PROOF_DIR ?? join(ROOT, 'docs/proof')
export const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
// COCKPIT_APP points the proofs at another install, e.g. a copy from the published DMG.
const APP = process.env.COCKPIT_APP ?? join(ROOT, 'release/mac-arm64/Cockpit.app')
const EXECUTABLE = join(APP, 'Contents/MacOS/Cockpit')

/** `extraEnv` adds proof-specific settings, e.g. COCKPIT_AGENT_PATH for a stand-in agent. */
export async function launchPackagedApp(extraEnv: Readonly<Record<string, string>> = {}): Promise<ElectronApplication> {
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
      ...extraEnv,
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

/**
 * Proofs decide whether the user is looking at Cockpit instead of depending on (or stealing)
 * the OS focus of the Mac the proof runs on. Applies to the current page and survives reloads.
 */
export async function setLooking(app: ElectronApplication, page: import('playwright-core').Page, looking: boolean): Promise<void> {
  // Plain strings: tsx would otherwise inject its __name helper, which the page does not have.
  const patch = `(() => {
    if (Document.prototype.hasFocus.proofPatched) return
    const original = Document.prototype.hasFocus
    const patched = function () {
      const forced = sessionStorage.getItem('proof:looking')
      return forced === null ? original.call(this) : forced === '1'
    }
    patched.proofPatched = true
    Document.prototype.hasFocus = patched
  })()`
  await app.context().addInitScript(patch)
  await page.evaluate(`${patch}; sessionStorage.setItem('proof:looking', '${looking ? '1' : '0'}')`)
}
