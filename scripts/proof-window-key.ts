// Packaged proof for R0: only the Cockpit window can use the desktop API. Another program on the
// Mac (an agent's shell) forges Host and Origin; a page in the preview pane, or in a second
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

// A page on another local port, the kind an agent's dev server serves into the preview pane.
// Its GETs carry no Origin, so on a build without the key they passed the old guard.
let cockpitPort = 0
const devServer = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(`<p>Preview page</p><img id="probe" src="http://127.0.0.1:${cockpitPort}/api/threads/${seeded.id}/images/${icon.file}?probe=iframe-img">
<script>fetch('http://127.0.0.1:${cockpitPort}/api/threads?probe=iframe-nocors', { mode: 'no-cors' })</script>`)
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

  // The preview pane: an iframe in the same window, first on another port, then on Cockpit's own.
  const openPreview = (url: string) => app.evaluate(({ BrowserWindow }, target) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.isVisible())
    win?.webContents.send('cockpit:preview-open', target)
  }, url)
  await openPreview(devUrl)
  const frame = page.frameLocator('.preview-pane iframe')
  await frame.getByText('Preview page').waitFor()
  await until('iframe probe', async () => statuses.has('iframe-nocors'))
  // A refused image never shows as a response (the browser blocks the JSON error body), so look at
  // what the preview page got: pixels, or none.
  const devFrame = page.frames().find((f) => f.url() === devUrl)
  const settled = devFrame ? await until('probe image settled', () => devFrame.evaluate(() => (document.getElementById('probe') as HTMLImageElement).complete)) : false
  const pixels = settled && devFrame ? await devFrame.evaluate(() => (document.getElementById('probe') as HTMLImageElement).naturalWidth) : -1
  // Not part of the hole: the image route's same-origin resource policy already stopped this
  // before the key, so it holds on both builds (a guard, not a control).
  check('a preview page cannot show a conversation image', pixels === 0, `naturalWidth ${pixels}`)
  check(label('an API read by a preview page'), blocked(statuses.get('iframe-nocors')), `status ${statuses.get('iframe-nocors')}`)
  await shot(page, 'preview-other-port')
  await openPreview(`http://127.0.0.1:${cockpitPort}/?probe=iframe-self`)
  const selfFrame = await until('self frame', async () => page.frames().some((f) => f.url().includes('probe=iframe-self')))
  const inner = page.frames().find((f) => f.url().includes('probe=iframe-self'))
  const innerStatus = selfFrame && inner ? await inner.evaluate(async () => (await fetch('/api/threads')).status) : undefined
  check(label('an API call from Cockpit\'s own page inside the preview pane'), blocked(innerStatus), `status ${innerStatus}`)

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
