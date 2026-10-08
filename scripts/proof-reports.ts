// Crash and error reports and the beta terms, PACKAGED app, against a stand-in collector on this
// Mac (never the real project). The beta is conditional on its terms (BETA-TERMS.md, David
// 2026-10-08): a first launch shows them before anything else, Quit ends the app, and nothing is
// sent until they are accepted. Then page and main-process errors arrive without the home folder,
// the machine name, page queries or a breadcrumb trail, with no switch to turn reports off; a
// main-process error leaves Cockpit running; terms accepted by install.sh are not asked again.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import { homedir, hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { ElectronApplication, Page } from 'playwright-core'
import { BETA_TERMS_VERSION } from '../electron/telemetry-choice.ts'
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

async function launch(stateDir = state): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchPackagedApp({ ...env, COCKPIT_HOME: stateDir })
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
  const terms = page.getByRole('dialog', { name: 'Cockpit beta terms' })
  await terms.waitFor()
  const said = await terms.innerText()
  check('a first launch shows the beta terms before anything else', said.includes('crash and error reports') && said.includes('cannot be turned off')
    && await page.getByRole('button', { name: 'Skip for now' }).count() === 0, said.slice(0, 160))
  check('the terms offer Agree and continue, or Quit, and nothing else', (await terms.getByRole('button').allInnerTexts()).join('|') === 'Agree and continue|Quit')
  await page.screenshot({ path: join(PROOF_DIR, 'proof-reports-terms.png') })

  await throwBoth(app, page, 'unaccepted')
  await settle(4000)
  check('nothing is sent before the terms are accepted', events().length === 0, `${events().length} events`)

  const closed = new Promise<boolean>((resolve) => { app.once('close', () => resolve(true)); setTimeout(() => resolve(false), 15_000) })
  await terms.getByRole('button', { name: 'Quit' }).click()
  check('Quit ends Cockpit', await closed)
  check('declining stores no acceptance', !existsSync(join(state, 'beta-terms.json')))

  ;({ app, page } = await launch())
  const again = page.getByRole('dialog', { name: 'Cockpit beta terms' })
  await again.waitFor()
  check('after Quit the next launch shows the terms again', true)
  await again.getByRole('button', { name: 'Agree and continue' }).click()
  await page.getByRole('button', { name: 'Skip for now' }).waitFor()
  check('Agree and continue opens Cockpit', true)
  check('the acceptance is stored with the state', JSON.parse(readFileSync(join(state, 'beta-terms.json'), 'utf8')).via === 'app')

  await throwBoth(app, page, 'accepted')
  const arrived = await until(() => events().filter((e) => JSON.stringify(e).includes('accepted')).length >= 2, 15_000)
  const sent = events().filter((e) => JSON.stringify(e).includes('accepted'))
  writeFileSync(join(PROOF_DIR, 'proof-reports-events.json'), JSON.stringify(sent, null, 2))
  check('once accepted, the page error and the main-process error both arrive', arrived
    && sent.some((e) => JSON.stringify(e).includes('proof page error')) && sent.some((e) => JSON.stringify(e).includes('proof main error')), `${sent.length} events`)
  const text = JSON.stringify(sent)
  const user = homedir().split('/').pop() ?? ''
  check('no report holds the home folder or the user name', !text.includes(homedir()) && (user.length < 3 || !text.includes(user)) && text.includes('~/repos/client-x/notes.md'))
  check('no report holds the machine name', !text.includes(hostname()) && !text.includes(hostname().replace(/\.local$/, '')))
  check('no report holds the page\'s key, a breadcrumb trail or the boot time', !text.includes('window-secret') && !text.includes('breadcrumb-canary')
    && !text.includes('boot_time') && sent.every((e) => e.breadcrumbs === undefined))
  check('each report names the version and the proof environment', sent.length > 0 && sent.every((e) => typeof e.release === 'string' && (e.release as string).startsWith('cockpit@') && e.environment === 'proof'),
    sent.map((e) => `${String(e.release)} ${String(e.environment)}`).join(', '))

  await page.getByRole('button', { name: 'Skip for now' }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor()
  check('a main-process error leaves Cockpit running', await page.getByRole('button', { name: 'Settings', exact: true }).isVisible())
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.waitFor()
  check('Settings has no switch to turn reports off', !(await settings.innerText()).toLowerCase().includes('crash'))
  await settings.getByRole('button', { name: 'Done' }).click()

  await app.close()
  ;({ app, page } = await launch())
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor()
  check('a restart does not ask again', await page.getByRole('dialog', { name: 'Cockpit beta terms' }).count() === 0)
  const before = events().length
  await throwBoth(app, page, 'restarted')
  check('reports keep coming after a restart', await until(() => events().length >= before + 2, 15_000), `${events().length - before} new events`)
  await app.close()

  // Accepted in Terminal by install.sh (the same file and version): the app does not ask.
  const installed = join(home, 'installed-state')
  mkdirSync(installed, { recursive: true })
  writeFileSync(join(installed, 'beta-terms.json'), `{"version":${BETA_TERMS_VERSION},"acceptedAt":"2026-10-08T14:39:00Z","via":"installer"}\n`)
  ;({ app, page } = await launch(installed))
  await page.getByRole('button', { name: 'Skip for now' }).waitFor()
  check('terms accepted by install.sh are not asked again', await page.getByRole('dialog', { name: 'Cockpit beta terms' }).count() === 0)
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
} finally {
  await app.close().catch(() => undefined)
  collector.close()
}
finish('PROOF REPORTS')
