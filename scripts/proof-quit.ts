// Packaged gate: Quit ends Cockpit, its agents and its process, even when an embedded page
// tries to veto unloading. Quit is a real Apple Event to this bundle's path (the ⌘Q route),
// never a programmatic menu click, which does nothing for role items. Stand-in agent only.
// Usage: npm run package (or COCKPIT_APP=<path>/Cockpit.app), then npm run proof:quit
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APP_BUNDLE, checker, launchPackagedApp, ROOT } from './lib/launch-app.ts'
import { openProject, startConversation } from './lib/ui.ts'

const { check, finish } = checker()
const agentDir = join(ROOT, 'scripts/fixtures/silent-agent')
const agentsAlive = (): number => {
  try { return execFileSync('pgrep', ['-f', agentDir], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length } catch { return 0 }
}

async function quitCase(label: string, veto: boolean): Promise<void> {
  const project = mkdtempSync(join(tmpdir(), 'cockpit-quit-proof-'))
  const app = await launchPackagedApp({ COCKPIT_AGENT_PATH: agentDir })
  const proc = app.process()
  let exitedAt = 0
  proc.on('exit', () => { exitedAt = Date.now() })
  try {
    const page = await app.firstWindow()
    page.setDefaultTimeout(15_000)
    await openProject(page, project, `Quit ${label}`)
    await startConversation(page, 'Keep working until Cockpit quits')
    if (veto) {
      // Playwright surfaces the unload veto as a dialog. Dismiss = stay on the page, the same answer
      // Electron gives by default; accepting would hide the very bug this case exists for.
      page.on('dialog', (dialog) => { dialog.dismiss().catch(() => {}) })
      // What a previewed web app can do: refuse to unload. A click gives it the user activation it needs.
      await page.evaluate("window.addEventListener('beforeunload', (event) => { event.preventDefault(); event.returnValue = '' })")
      await page.mouse.click(5, 300)
    }
    check(`${label}: an agent is mid-turn before quitting`, agentsAlive() > 0)
    const quitAt = Date.now()
    execFile('osascript', ['-e', `tell application "${APP_BUNDLE}" to quit`])
    for (let i = 0; i < 40 && !exitedAt; i += 1) await new Promise((r) => setTimeout(r, 250))
    check(`${label}: Quit ends the app process`, exitedAt > 0, exitedAt ? `${exitedAt - quitAt} ms` : 'still running after 10 s')
    await new Promise((r) => setTimeout(r, 500))
    check(`${label}: no agent outlives the app`, agentsAlive() === 0, `${agentsAlive()} left`)
  } finally {
    if (!exitedAt) proc.kill('SIGKILL')
  }
}

await quitCase('plain', false)
await quitCase('with a page that vetoes unloading', true)
finish('PROOF QUIT')
