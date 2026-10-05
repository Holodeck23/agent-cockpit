// Packaged proof for R0: only the Cockpit window can use the desktop API. Another program on the
// Mac (an agent's shell) forges Host and Origin; a page in the in-app browser, or in a second
// window, runs in the same app. None of them may read a conversation or answer its approval.
// Usage: npm run package:proof, then COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:window-key
// Control: run it with --control against a build from before R0. There the attacks must WORK,
// or this proof could not see the hole it guards.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { createImageStore } from '../server/threads/images.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { openProject, startConversation } from './lib/ui.ts'

const control = process.argv.includes('--control')
const { check, finish } = checker()
const root = mkdtempSync(join(tmpdir(), 'cockpit-window-key-proof-'))
const project = join(root, 'app')
mkdirSync(project)
const store = createThreadStore(join(root, 'state'))
const images = createImageStore(store.root)
mkdirSync(PROOF_DIR, { recursive: true })

const now = new Date().toISOString()
const seeded = store.create({ id: '7b7b7b7b-0000-4000-8000-000000000001', title: 'Seeded image conversation', projectPath: project,
  settings: threadSettingsSchema.parse({}), sessionId: '7b7b7b7b-0000-4000-8000-000000000002', sessionStarted: false, completed: false, createdAt: now, updatedAt: now })
const icon = images.save(seeded.id, readFileSync(join(ROOT, 'build/icon-1024.png')))
store.append(seeded.id, { kind: 'user_text', text: 'Show me the app icon' })
store.append(seeded.id, { kind: 'image', file: icon.file, mediaType: icon.mediaType, from: 'agent', name: 'icon-1024.png' })

/** Polls from Node (an async waitForFunction predicate is always truthy). */
async function until(label: string, test: () => Promise<boolean>, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await test().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 150)) }
  console.log(`  (timed out waiting for ${label})`)
  return false
}

/** What another program on the Mac sends: loopback Host, Cockpit's own Origin, JSON. */
async function forged(port: number, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return response.status
}

// A page on another local port, the kind an agent's dev server serves into the in-app browser.
// It records what its own requests got: a fetch to its own server (which must work, or "blocked"
// below would prove nothing) and a fetch to Cockpit's API.
let cockpitPort = 0
const devServer = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(`<p>Preview page</p><img id="probe" src="http://127.0.0.1:${cockpitPort}/api/threads/${seeded.id}/images/${icon.file}?probe=page-img">
<script>window.probes = {}
fetch('/?probe=own-server').then((r) => { probes.own = 'status ' + r.status }, () => { probes.own = 'blocked' })
fetch('http://127.0.0.1:${cockpitPort}/api/threads?probe=page-nocors', { mode: 'no-cors' }).then((r) => { probes.api = 'answered (' + r.type + ')' }, () => { probes.api = 'blocked' })</script>`)
})
await new Promise<void>((resolve) => devServer.listen(0, '127.0.0.1', resolve))
const devUrl = `http://127.0.0.1:${(devServer.address() as AddressInfo).port}/`

const app = await launchPackagedApp({ COCKPIT_HOME: store.root, COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/ask-agent') })
const statuses = new Map<string, number>()
const shot = (page: Page, name: string) => page.screenshot({ path: join(PROOF_DIR, `window-key-${control ? 'control-' : ''}${name}.png`) })
const blocked = (status: number | undefined): boolean => (control ? status !== undefined && status < 400 : status === 403)
const label = (what: string): string => (control ? `CONTROL (build without the key): ${what} goes through` : `${what} is refused (403)`)

try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  page.on('response', (response) => {
    const url = new URL(response.url())
    const probe = url.searchParams.get('probe')
    if (probe) statuses.set(probe, response.status())
    if (url.pathname === '/api/stream') statuses.set('stream', response.status())
  })
  await openProject(page, project, 'App')
  cockpitPort = Number(new URL(page.url()).port)

  // An approval waits in a conversation; the card arriving at all means the event stream works.
  await startConversation(page, 'Run the two steps')
  const card = page.locator('.approval.open')
  check('the approval card arrives over the event stream', await until('card', async () => (await card.count()) === 1))
  check('the event stream itself is served to the window', statuses.get('stream') === 200, `status ${statuses.get('stream')}`)
  const threadId = await page.evaluate(async () => {
    const list = (await (await fetch('/api/threads')).json()) as { data: { meta: { id: string; title: string } }[] }
    return list.data.find((t) => t.meta.title.startsWith('Run the two steps'))?.meta.id ?? ''
  })
  const fromPage = await page.evaluate(async (id) => (await (await fetch(`/api/threads/${id}/events`)).json()) as { data: { events: { event: { kind: string; requestId?: string } }[] } }, threadId)
  const approvalId = fromPage.data.events.find((e) => e.event.kind === 'approval_request')?.event.requestId ?? ''
  check('the window reads the conversation and its approval id', approvalId.length > 0)

  // Another program on the Mac: forged Host and Origin, valid ids.
  check(label('reading the conversation list from outside the window'), blocked(await forged(cockpitPort, 'GET', '/api/threads')))
  check(label('reading the conversation from outside the window'), blocked(await forged(cockpitPort, 'GET', `/api/threads/${threadId}/events`)))
  check(label('starting a conversation from outside the window'), blocked(await forged(cockpitPort, 'POST', '/api/threads', { projectPath: project, text: 'from outside', settings: {} })))
  const allow = await forged(cockpitPort, 'POST', `/api/threads/${threadId}/approvals/${approvalId}`, { behavior: 'allow' })
  check(label('curl Allow on the waiting approval'), blocked(allow), `status ${allow}`)
  if (control) {
    check('CONTROL: the curl Allow answered the card', await until('card answered', async () => (await card.filter({ hasText: 'echo step 2' }).count()) === 1))
  } else {
    check('the outside Allow left the card waiting', (await card.count()) === 1 && (await card.filter({ hasText: 'echo step 1' }).count()) === 1)
    check('a guessed key is refused (403)', await forged(cockpitPort, 'GET', '/api/threads', undefined, { 'x-cockpit-window': 'f'.repeat(64) }) === 403)

    // The person, in the window: a real click still answers it.
    await card.getByRole('button', { name: 'Allow', exact: true }).click()
    check('a real click on Allow answers the approval', await until('step 2', async () => (await card.filter({ hasText: 'echo step 2' }).count()) === 1))
    await card.getByRole('button', { name: 'Allow', exact: true }).click()
    check('the reply after both answers streams in', await until('reply', async () => (await page.locator('.bubble.agent').filter({ hasText: 'Both steps answered.' }).count()) === 1))
    await shot(page, 'answered')
    // The page cannot pick its own key: whatever it sends is replaced on the way out.
    check('a key the page makes up is replaced, the call still works', await page.evaluate(async () =>
      (await fetch('/api/threads', { headers: { 'x-cockpit-window': 'f'.repeat(64) } })).status) === 200)
  }

  // Conversation images still load in the window (an <img> from the main frame).
  await page.evaluate((id) => { location.search = `?thread=${id}` }, seeded.id)
  check('conversation images still load in the window', await until('image', () => page.locator('.image-item .conversation-image img').evaluateAll((imgs) =>
    imgs.length === 1 && imgs.every((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0))))
  await shot(page, 'image')

  // The in-app browser (wave 9): the host draws the page in its own view, in the workspace's
  // partition, so it is read from the main process. The host cancels every request to Cockpit's
  // ports, so the API never answers at all: the probe is "blocked", not a 403. A build from before
  // the in-app browser had an iframe here instead, so the control run skips this part.
  if (!control) {
    const openPreview = (url: string) => app.evaluate(({ BrowserWindow }, preview) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.isVisible())
      win?.webContents.send('cockpit:preview-open', preview)
    }, { url, projectPath: project, threadId: seeded.id })
    const views = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap((w) => w.contentView.children)
      .map((v) => (v as unknown as { webContents?: Electron.WebContents }).webContents)
      .filter((c): c is Electron.WebContents => Boolean(c) && !c!.isDestroyed()).map((c) => c.getURL()))
    const inView = (url: string, js: string): Promise<unknown> => app.evaluate(async ({ BrowserWindow }, { url, js }) => {
      const contents = BrowserWindow.getAllWindows().flatMap((w) => w.contentView.children)
        .map((v) => (v as unknown as { webContents?: Electron.WebContents }).webContents)
        .find((c) => c && !c.isDestroyed() && c.getURL() === url)
      return contents ? await contents.executeJavaScript(js, true) : undefined
    }, { url, js })
    await openPreview(devUrl)
    check('the dev page opens in the in-app browser', await until('dev page', async () => String(await inView(devUrl, 'document.body.innerText')).includes('Preview page')))
    const probes = async () => (await inView(devUrl, 'JSON.stringify(window.probes)')) as string | undefined
    await until('page probes', async () => { const p = JSON.parse((await probes()) ?? '{}') as Record<string, string>; return Boolean(p.own && p.api) })
    const got = JSON.parse((await probes()) ?? '{}') as Record<string, string>
    check('the page can still fetch from its own server', got.own === 'status 200', got.own)
    check('an API read by a page in the in-app browser is blocked by the host', got.api === 'blocked', got.api)
    const settled = await until('probe image settled', async () => (await inView(devUrl, `document.getElementById('probe').complete`)) === true)
    const pixels = settled ? await inView(devUrl, `document.getElementById('probe').naturalWidth`) : -1
    check('a page in the in-app browser cannot show a conversation image', pixels === 0, `naturalWidth ${pixels}`)
    await shot(page, 'preview-other-port')
    // Cockpit's own address is refused before anything loads: the pane says so, and no view holds it.
    await openPreview(`http://127.0.0.1:${cockpitPort}/?probe=self`)
    const pane = page.getByRole('complementary', { name: 'Browser' })
    check('the in-app browser refuses Cockpit\'s own address', await until('refusal', async () =>
      (await pane.getByRole('alert').filter({ hasText: 'not Cockpit itself' }).count()) === 1))
    check('no page ever loads Cockpit\'s own address', !(await views()).some((url) => url.includes('probe=self')))
    await shot(page, 'preview-self-refused')
  }

  // A second window in the same app (as the hidden window that captures a preview for an agent).
  const second = await app.evaluate(async ({ BrowserWindow }, url) => {
    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })
    try {
      await win.loadURL(url)
      return await win.webContents.executeJavaScript(`fetch('/api/threads').then((r) => r.status)`) as number
    } finally {
      win.destroy()
    }
  }, `http://127.0.0.1:${cockpitPort}/?probe=second-window`)
  check(label('an API call from a second window'), blocked(second), `status ${second}`)

  // And the window itself still works after all of that.
  check('the window still uses the API afterwards', await page.evaluate(async () => (await fetch('/api/threads')).status) === 200)
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
} finally {
  await app.close().catch(() => {})
  devServer.close()
}
finish(control ? 'proof:window-key --control' : 'proof:window-key')
