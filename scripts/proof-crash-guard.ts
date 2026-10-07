// Packaged check for the main-process crash guard (electron/crash-guard.ts): an uncaught error
// inside Cockpit's main process, where its server runs, is logged and Cockpit keeps answering.
// Without the guard Electron shows a modal error dialog and every request hangs (order 14 hit it).
// Usage: npm run package:proof, then COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:crash-guard
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker, launchPackagedApp } from './lib/launch-app.ts'

const { check, finish } = checker()
const state = mkdtempSync(join(tmpdir(), 'cockpit-crash-guard-'))
const log = join(state, 'logs', 'main-errors.log')
const bounded = <T>(what: string, work: Promise<T>, ms = 5000): Promise<T> =>
  Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} did not answer in ${ms} ms`)), ms))])

const app = await launchPackagedApp({ COCKPIT_HOME: state })
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const before = await bounded('the API before', page.evaluate(async () => (await fetch('/api/projects')).status))
  check('control: the API answers before anything goes wrong', before === 200, String(before))
  // A plain string: tsx would wrap a function with helpers the main process does not have.
  await app.evaluate(`setTimeout(() => { throw new Error('crash-guard proof: uncaught in the main process') }, 0)`)
  await app.evaluate(`setTimeout(() => { Promise.reject(new Error('crash-guard proof: unhandled rejection')) }, 0)`)
  await new Promise((r) => setTimeout(r, 1000))
  const after = await bounded('the API after', page.evaluate(async () => (await fetch('/api/projects')).status)).catch((e: Error) => e.message)
  check('after an uncaught error the API still answers (no modal dialog)', after === 200, String(after))
  const window = await bounded('a window screenshot', page.screenshot()).then(() => 'ok', (e: Error) => e.message)
  check('and the window still paints', window === 'ok', window)
  const text = existsSync(log) ? readFileSync(log, 'utf8') : ''
  check('both are in the main-process error log with their stack', text.includes('uncaught exception') && text.includes('crash-guard proof: uncaught in the main process')
    && text.includes('crash-guard proof: unhandled rejection'), log)
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message.split('\n')[0] : String(error))
} finally {
  await bounded('app close', app.close(), 15_000).catch(() => { app.process().kill('SIGKILL') })
}
finish('proof:crash-guard')
