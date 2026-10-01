// U2 Processes-page gate, run against the PACKAGED app (npm run package first): `npm run proof:processes`.
// Claude is replaced by a stand-in (scripts/fixtures/dev-agent) that starts the project's dev server
// through the cockpit MCP API with its own session token, so the check costs nothing. The page must
// show the empty state, then the running server with its URL and a live log (stderr marked), search,
// Restart as a new process, Stop that closes the port, Start again, and quitting must leave nothing.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { headStatus, openProject, startConversation } from './lib/ui.ts'

interface Proc { id: string; name: string; status: string; pid?: number; url?: string; projectPath: string }

const dir = mkdtempSync(join(tmpdir(), 'cockpit-processes-proof-'))
writeFileSync(join(dir, 'server.js'), `
const http = require('node:http')
const server = http.createServer((req, res) => res.end('processes proof ok'))
server.listen(0, '127.0.0.1', () => {
  console.log('Local: http://127.0.0.1:' + server.address().port + '/')
  console.error('warning: this line goes to stderr')
  let n = 0
  setInterval(() => console.log('tick ' + ++n), 250)
})
`)

const getJson = <T>(page: Page, path: string): Promise<T> =>
  page.evaluate(async (p) => ((await (await fetch(p)).json()) as { data: unknown }).data, path) as Promise<T>
const mine = async (page: Page): Promise<Proc[]> => (await getJson<Proc[]>(page, '/api/processes')).filter((p) => p.projectPath === dir)
const alive = (pid: number | undefined): boolean => {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
const reachable = async (url: string): Promise<boolean> => {
  try { return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok } catch { return false }
}
async function until<T>(page: Page, what: string, read: () => Promise<T | undefined | false>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await page.waitForTimeout(250)
  }
}

const { check, finish } = checker()
mkdirSync(PROOF_DIR, { recursive: true })
const app = await launchPackagedApp({ COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/dev-agent') })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
const button = page.getByRole('button', { name: /^Processes/ })
const log = page.getByLabel('Output of dev server')

try {
  await openProject(page, dir, 'Processes demo')
  await button.click()
  check('empty state explains where processes come from', await page.getByText('Nothing running yet').isVisible()
    && await page.getByText(/When you ask your agent to start your site or server/).isVisible())
  await button.click()

  await startConversation(page, 'Start the dev server please')
  await headStatus(page).filter({ hasText: 'Ready' }).waitFor({ timeout: 30_000 })
  const first = await until(page, 'the dev server URL', async () => (await mine(page)).find((p) => p.url && p.status === 'running'))
  check('the agent started it through the cockpit MCP', first.name === 'dev server' && alive(first.pid), first.url)
  check('the top bar shows it running', (await button.getAttribute('aria-label')) === 'Processes (1 running)')

  await button.click()
  const port = new URL(first.url!).port
  check('listed with state and port', await page.getByRole('button', { name: new RegExp(`dev server Running · :${port}`) }).isVisible())
  check('detail shows command and URL', await page.locator('.process-detail-title code').textContent() === 'node server.js'
    && await page.getByRole('link', { name: first.url! }).isVisible())
  await until(page, 'ten ticks in the log', async () => /tick 10\b/.test(await log.textContent() ?? ''))
  const text = await log.textContent() ?? ''
  check('log shows the startup line and keeps growing', text.includes(`Local: http://127.0.0.1:${port}/`) && /tick 10\b/.test(text))
  check('stderr lines are marked', (await log.locator('.log-err').first().textContent())?.includes('warning: this line goes to stderr') === true)
  check('the server answers', await reachable(first.url!))

  await page.getByRole('searchbox', { name: 'Search processes' }).fill('nothing-like-this')
  check('search filters the list', await page.getByText('No processes match.').isVisible())
  await page.getByRole('searchbox', { name: 'Search processes' }).fill('')

  await page.getByRole('button', { name: 'Restart', exact: true }).click()
  const second = await until(page, 'the restarted server', async () => (await mine(page)).find((p) => p.id !== first.id && p.status === 'running' && p.url))
  check('restart is a new process and the old one is gone', !alive(first.pid) && alive(second.pid), `${first.id} -> ${second.id}`)
  await until(page, 'the new log', async () => (await log.textContent() ?? '').includes(`Local: ${second.url}`))
  check('the log follows the new process', true)
  await page.screenshot({ path: join(PROOF_DIR, 'proof-processes.png') })

  await page.getByRole('button', { name: 'Stop', exact: true }).click()
  await until(page, 'the stop', async () => (await mine(page)).find((p) => p.id === second.id && p.status === 'exited'))
  check('stop ends it and closes the port', !alive(second.pid) && !(await reachable(second.url!)))
  check('top bar no longer counts it', (await button.getAttribute('aria-label')) === 'Processes')
  await page.getByRole('button', { name: 'Start again' }).click()
  const third = await until(page, 'the server again', async () => (await mine(page)).find((p) => p.status === 'running' && p.url))
  check('start again brings it back', await reachable(third.url!))

  await app.close()
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const left = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter((l) => l.includes('server.js') && l.includes('node'))
  check('quitting leaves no dev server running', !alive(third.pid) && !(await reachable(third.url!)), left.join(' | ') || 'none')
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
  await page.screenshot({ path: join(PROOF_DIR, 'proof-processes-failure.png') }).catch(() => {})
  await app.close().catch(() => {})
}
finish('PROOF PROCESSES')
