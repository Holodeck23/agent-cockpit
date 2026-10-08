// Crash and error reports, PACKAGED app, against a stand-in collector on this Mac (never the real
// project). On by default (David 2026-10-08): the first launch says so once, with no question; page
// and main-process errors arrive without the home folder, the machine name, page queries or a
// breadcrumb trail; a main-process error leaves Cockpit running; Settings turns reports off, at
// once and across a restart.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import { homedir, hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { ElectronApplication, Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR } from './lib/launch-app.ts'

const home = mkdtempSync(join(tmpdir(), 'cockpit-reports-proof-'))
const state = join(home, 'state')

// The stand-in collector: every envelope Cockpit posts, decoded.
const received: string[] = []
const body = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks)
  return (req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString('utf8')
}
const collector = createServer((req, res) => {
  void body(req).then((text) => { received.push(text); res.writeHead(200, { 'content-type': 'application/json' }).end('{}') })
})
await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve))
const port = (collector.address() as { port: number }).port
const env = { COCKPIT_HOME: state, COCKPIT_SENTRY_DSN: `http://proofkey@127.0.0.1:${port}/1` }

/** Error events (not sessions or client reports) received so far, as parsed JSON. */
const events = (): Array<Record<string, unknown>> => received.flatMap((envelope) => {
  const lines = envelope.split('\n')
  return lines.flatMap((line, i) => {
    try {
      const head = JSON.parse(line) as { type?: string }
      return head.type === 'event' && lines[i + 1] ? [JSON.parse(lines[i + 1]!) as Record<string, unknown>] : []
    } catch { return [] }
  })
})
const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
async function until(read: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (read()) return true; await settle(250) }
  return read()
}

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchPackagedApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  page.setDefaultTimeout(15_000)
  return { app, page }
}

// One error from the page and one uncaught in the main process, both naming the home folder,
// the page's own address with a key, and a word that must never travel (a breadcrumb would carry it).
async function throwBoth(app: ElectronApplication, page: Page, tag: string): Promise<void> {
  const secretPath = join(homedir(), 'repos', 'client-x', 'notes.md')
  await page.evaluate(({ tag, secretPath }) => {
    console.log('breadcrumb-canary prompt text')
    setTimeout(() => { throw new Error(`proof page error ${tag} at ${secretPath} ${location.origin}/?key=window-secret`) })
  }, { tag, secretPath })
  await app.evaluate((_electron, args) => {
    console.log('breadcrumb-canary main')
    setTimeout(() => { throw new Error(`proof main error ${args.tag} at ${args.secretPath}`) })
  }, { tag, secretPath })
}

const { check, finish } = checker()
mkdirSync(PROOF_DIR, { recursive: true })
let { app, page } = await launch()
try {
  const notice = page.getByRole('status', { name: 'Crash reports' })
  await notice.waitFor()
  const said = await notice.innerText()
  check('first launch says once that crash reports are sent, what they hold and where to turn them off',
    said.includes('sends crash reports') && said.includes('home folder is hidden') && said.includes('Settings'), said.slice(0, 160))
  check('it is a notice, not a question: OK is the only button', (await notice.getByRole('button').allInnerTexts()).join('|') === 'OK')
  await page.screenshot({ path: join(PROOF_DIR, 'proof-reports-notice.png') })

  await throwBoth(app, page, 'default')
  const arrived = await until(() => events().filter((e) => JSON.stringify(e).includes('default')).length >= 2, 15_000)
  const sent = events().filter((e) => JSON.stringify(e).includes('default'))
  writeFileSync(join(PROOF_DIR, 'proof-reports-events.json'), JSON.stringify(sent, null, 2))
  check('with nothing chosen, the page error and the main-process error both arrive', arrived
    && sent.some((e) => JSON.stringify(e).includes('proof page error')) && sent.some((e) => JSON.stringify(e).includes('proof main error')), `${sent.length} events`)
  const text = JSON.stringify(sent)
  const user = homedir().split('/').pop() ?? ''
  check('no report holds the home folder or the user name', !text.includes(homedir()) && (user.length < 3 || !text.includes(user)) && text.includes('~/repos/client-x/notes.md'))
  check('no report holds the machine name', !text.includes(hostname()) && !text.includes(hostname().replace(/\.local$/, '')))
  check('no report holds the page\'s key or a breadcrumb trail', !text.includes('window-secret') && !text.includes('breadcrumb-canary') && sent.every((e) => e.breadcrumbs === undefined))
  check('each report names the version and the proof environment', sent.length > 0 && sent.every((e) => typeof e.release === 'string' && (e.release as string).startsWith('cockpit@') && e.environment === 'proof'),
    sent.map((e) => `${String(e.release)} ${String(e.environment)}`).join(', '))

  await notice.getByRole('button', { name: 'OK' }).click()
  await notice.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'Skip for now' }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor()
  check('after OK the notice does not come back in the app', await page.getByRole('status', { name: 'Crash reports' }).count() === 0)
  check('a main-process error leaves Cockpit running', await page.getByRole('button', { name: 'Settings', exact: true }).isVisible())

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  const box = settings.getByRole('checkbox', { name: /Send crash and error reports/ })
  check('Settings shows reports on', await box.isChecked())
  await box.click()
  const off = await (async () => { for (let i = 0; i < 20; i++) { if (!(await box.isChecked())) return true; await settle(250) } return false })()
  check('Settings turns them off', off)
  await settings.getByRole('button', { name: 'Done' }).click()
  const before = events().length
  await throwBoth(app, page, 'turned-off')
  await settle(4000)
  check('once off, nothing more is sent', events().length === before, `${events().length - before} new events`)
  check('the setting is stored with the state', JSON.parse(readFileSync(join(state, 'reports.json'), 'utf8')).reports === false)

  await app.close()
  ;({ app, page } = await launch())
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor()
  await settle(2000)
  check('a restart shows no notice', await page.getByRole('status', { name: 'Crash reports' }).count() === 0)
  const afterRestart = events().length
  await throwBoth(app, page, 'still-off')
  await settle(4000)
  check('still off after a restart: nothing is sent', events().length === afterRestart, `${events().length - afterRestart} new events`)
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
} finally {
  await app.close().catch(() => undefined)
  collector.close()
}
finish('PROOF REPORTS')
