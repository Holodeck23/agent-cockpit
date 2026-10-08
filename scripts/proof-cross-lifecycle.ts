// Packaged cross-feature gate for wave 12 (ACCEPTANCE CROSS-06, CROSS-10), stand-ins only.
//
//   CROSS-10  with a browser page, a native agent session, a running check and a dev server all
//             present: closing the window keeps Cockpit and every one of them (macOS); reopening
//             shows them again; a real Quit (Apple Event, the ⌘Q route) ends everything Cockpit
//             owns and leaves an unrelated server on the same Mac running.
//   CROSS-06  see the second part of this file.
//
// Usage: npm run package:proof, wait a minute (XProtect), then
//   COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:cross-lifecycle
import { execFile, execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from 'playwright-core'
import { APP_BUNDLE, checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { headStatus, messageBox, openProject, startConversation } from './lib/ui.ts'
import { crossSix } from './proof-cross-lifecycle-update.ts'

const { check, finish } = checker()
const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-cross-life-')))
const garden = join(root, 'garden')
mkdirSync(garden)
writeFileSync(join(garden, 'index.html'), '<h1>Garden site</h1>\n')
mkdirSync(PROOF_DIR, { recursive: true })

const step = (label: string): void => console.log(`  · ${label}`)
const shot = (page: Page, name: string) => page.screenshot({ path: join(PROOF_DIR, `cross-life-${name}.png`) })
async function until<T>(label: string, read: () => Promise<T | undefined | false>, ms = 20_000): Promise<T | undefined> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await read().catch(() => undefined)
    if (value) return value
    await new Promise((r) => setTimeout(r, 150))
  }
  console.log(`  (timed out waiting for ${label})`)
  return undefined
}
const pids = (pattern: string): number[] => {
  try { return execFileSync('/usr/bin/pgrep', ['-f', '--', pattern], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number) } catch { return [] }
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
const get = <T>(page: Page, path: string): Promise<T> => page.evaluate(async (p) => ((await (await fetch(p)).json()) as { data: unknown }).data, path) as Promise<T>
const working = async (page: Page): Promise<boolean> => /Working|Starting/.test((await headStatus(page).textContent()) ?? '')
const pageUrls = (app: ElectronApplication): Promise<string[]> => app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.getURL()))
// wave65-agent execs ../wave5-agent/claude; the unrelated server is told apart by its --directory.
const AGENT = 'wave5-agent/claude'
const CHECK = 'sleep 117'

// Something on this Mac that is not Cockpit's: it must outlive Cockpit's Quit.
const unrelated = spawn('/usr/bin/python3', ['-u', '-m', 'http.server', '0', '--bind', '127.0.0.1', '--directory', root], { detached: true, stdio: 'ignore' })
unrelated.unref()

async function crossTen(): Promise<void> {
  const app = await launchPackagedApp({ COCKPIT_HOME: join(root, 'state-10'), COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/wave65-agent') })
  const proc = app.process()
  let exited = false
  proc.on('exit', () => { exited = true })
  try {
    let page = await app.firstWindow()
    page.setDefaultTimeout(15_000)
    await openProject(page, garden, 'Garden')

    step('CROSS-10 a dev server, a browser page, a native session and a running check')
    await startConversation(page, 'START-WEB the garden')
    const approval = page.locator('.approval.open')
    await approval.waitFor({ timeout: 30_000 })
    await approval.getByRole('button', { name: 'Allow', exact: true }).click()
    type Proc = { id: string; name: string; status: string; url?: string; pid?: number }
    const site = await until('site', async () => (await get<Proc[]>(page, '/api/processes')).find((p) => p.name === 'garden-site' && p.status === 'running' && p.url))
    await until('turn over', async () => !(await working(page)), 20_000)
    await page.getByRole('button', { name: /^Processes/ }).click()
    await page.getByRole('button', { name: 'Open site' }).click()
    const browserUp = await until('browser page', async () => (await pageUrls(app)).some((u) => site?.url && u.startsWith(site.url)))
    // Open site routes to the server's own conversation (W7.3); go back to Conversations explicitly.
    await page.getByRole('tab', { name: /^Conversations/ }).click()
    await startConversation(page, 'hello')
    await until('hello done', async () => !(await working(page)), 20_000)
    const card: Locator = page.locator('.result-card').last()
    await card.waitFor()
    await card.locator('summary').click()
    await card.getByLabel('Exact command').fill(CHECK)
    await card.getByRole('button', { name: 'Run exactly this check' }).click()
    await until('check running', async () => pids(CHECK).length > 0)
    // The server's pid as Cockpit lists it, so a leftover from an earlier run can never stand in for it.
    const before = { agent: pids(AGENT), server: site?.pid ? [site.pid] : [], check: pids(CHECK) }
    check('CROSS-10 all four exist before the window closes', Boolean(browserUp) && before.agent.length > 0 && before.server.length === 1 && before.check.length > 0, JSON.stringify({ browser: Boolean(browserUp), ...before }))
    await shot(page, '10-before-close')

    step('CROSS-10 close the window, then reopen it')
    await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.close() })
    await until('no window', async () => (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 0)
    await new Promise((r) => setTimeout(r, 1500))
    check('CROSS-10 closing the window keeps Cockpit running (macOS)', !exited)
    check('CROSS-10 and its agent session, dev server and check', before.agent.every(alive) && before.server.every(alive) && before.check.every(alive),
      JSON.stringify({ agent: before.agent.map(alive), server: before.server.map(alive), check: before.check.map(alive) }))
    const reopened = app.waitForEvent('window')
    await app.evaluate(({ app: a }) => { a.emit('activate') })
    page = await reopened
    page.setDefaultTimeout(15_000)
    await page.waitForLoadState('domcontentloaded')
    const procs = await until('processes listed', async () => (await get<Proc[]>(page, '/api/processes')).filter((p) => p.status === 'running'))
    check('CROSS-10 reopening (Dock) shows a window with the server still running', procs?.some((p) => p.name === 'garden-site') === true)
    await page.getByRole('navigation', { name: 'Conversations' }).getByText('hello', { exact: true }).first().click()
    const again = page.locator('.result-card').last()
    await again.waitFor()
    if (!(await again.getByRole('button', { name: 'Cancel', exact: true }).isVisible().catch(() => false))) await again.locator('summary').click()
    check('CROSS-10 the reopened window shows the check still running', await again.getByRole('button', { name: 'Cancel', exact: true }).isVisible())
    const browserAgain = (await pageUrls(app)).some((u) => site?.url && u.startsWith(site.url))
    console.log(`  (browser page after reopen: ${browserAgain ? 'still loaded' : 'not loaded'})`)
    await shot(page, '10-reopened')

    step('CROSS-10 a real Quit')
    execFile('osascript', ['-e', `tell application "${APP_BUNDLE}" to quit`])
    await until('exit', async () => exited, 15_000)
    await new Promise((r) => setTimeout(r, 1000))
    check('CROSS-10 Quit ends the app', exited)
    check('CROSS-10 and everything it owned: agent, dev server, check', !before.agent.some(alive) && !before.server.some(alive) && pids(CHECK).length === 0,
      JSON.stringify({ agent: before.agent.filter(alive), server: before.server.filter(alive), check: pids(CHECK) }))
    check('CROSS-10 an unrelated server on this Mac keeps running', pids(`--directory ${root}`).length === 1)
  } catch (error) {
    check('CROSS-10 ran to the end', false, error instanceof Error ? error.message : String(error))
  } finally {
    // A failed run still ends the ordinary way, so it leaves no orphan behind; SIGKILL only if that fails.
    if (!exited) execFile('osascript', ['-e', `tell application "${APP_BUNDLE}" to quit`])
    await until('exit after failure', async () => exited, 15_000)
    if (!exited) proc.kill('SIGKILL')
  }
}

try {
  await crossTen()
  await crossSix(check, root)
} finally {
  for (const pid of pids(`--directory ${root}`)) process.kill(pid)
}
finish('proof:cross-lifecycle')
