// Crash and error reports, PACKAGED app, against a stand-in collector on this Mac (never the real
// project): asked once on first launch; nothing leaves before a yes or after "No thanks"; after a
// yes in Settings, page and main-process errors arrive without the home folder, the machine name,
// page queries or a breadcrumb trail; a main-process error leaves Cockpit running; the answer is kept.
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
  const ask = page.getByRole('dialog', { name: 'Crash reports' })
  await ask.waitFor()
  check('first launch asks once whether to send crash reports, and says what they hold', (await ask.innerText()).includes('Never your conversations'))
  await page.screenshot({ path: join(PROOF_DIR, 'proof-reports-ask.png') })

  await throwBoth(app, page, 'unanswered')
  await settle(4000)
  check('nothing is sent before the person answers', events().length === 0, `${events().length} events`)

  await ask.getByRole('button', { name: 'No thanks' }).click()
  await ask.waitFor({ state: 'detached' })
  // A first launch opens on the first-run screen, where the question is asked; then on into the app.
  await page.getByRole('button', { name: 'Skip for now' }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor()
  check('after the first-run screen the question does not come back', await page.getByRole('dialog', { name: 'Crash reports' }).count() === 0)
  await throwBoth(app, page, 'declined')
  await settle(4000)
  check('nothing is sent after "No thanks"', events().length === 0, `${events().length} events`)
  check('a main-process error leaves Cockpit running', await page.getByRole('button', { name: 'Settings', exact: true }).isVisible())

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  const box = settings.getByRole('checkbox', { name: /Send crash and error reports/ })
  check('Settings shows the answer, off', !(await box.isChecked()))
  await box.check()
  await settings.getByRole('button', { name: 'Done' }).click()
  await throwBoth(app, page, 'allowed')
  const arrived = await until(() => events().filter((e) => JSON.stringify(e).includes('allowed')).length >= 2, 15_000)
  const sent = events().filter((e) => JSON.stringify(e).includes('allowed'))
  writeFileSync(join(PROOF_DIR, 'proof-reports-events.json'), JSON.stringify(sent, null, 2))
  check('after a yes, both the page error and the main-process error arrive', arrived
    && sent.some((e) => JSON.stringify(e).includes('proof page error')) && sent.some((e) => JSON.stringify(e).includes('proof main error')), `${sent.length} events`)
  const text = JSON.stringify(sent)
  const user = homedir().split('/').pop() ?? ''
  check('no report holds the home folder or the user name', !text.includes(homedir()) && (user.length < 3 || !text.includes(user)) && text.includes('~/repos/client-x/notes.md'))
  check('no report holds the machine name', !text.includes(hostname()) && !text.includes(hostname().replace(/\.local$/, '')))
  check('no report holds the page\'s key or a breadcrumb trail', !text.includes('window-secret') && !text.includes('breadcrumb-canary') && sent.every((e) => e.breadcrumbs === undefined))
  check('each report names the version and the proof environment', sent.every((e) => typeof e.release === 'string' && (e.release as string).startsWith('cockpit@') && e.environment === 'proof'),
    sent.map((e) => `${String(e.release)} ${String(e.environment)}`).join(', '))
  check('the answer is stored with the state', JSON.parse(readFileSync(join(state, 'reports.json'), 'utf8')).reports === true)

  await app.close()
  ;({ app, page } = await launch())
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor()
  await settle(2000)
  check('a restart does not ask again', await page.getByRole('dialog', { name: 'Crash reports' }).count() === 0)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const again = page.getByRole('dialog', { name: 'Settings' }).getByRole('checkbox', { name: /Send crash and error reports/ })
  check('Settings still shows yes after a restart', await again.isChecked())
  await again.uncheck()
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Done' }).click()
  const before = events().length
  await throwBoth(app, page, 'turned-off')
  await settle(4000)
  check('turning it off in Settings stops reports at once', events().length === before, `${events().length - before} new events`)
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
} finally {
  await app.close().catch(() => undefined)
  collector.close()
}
finish('PROOF REPORTS')
