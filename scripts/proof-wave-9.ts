// Packaged gate for wave 9 order 10 (in-app browser): W9-01 per-conversation pages and layout,
// W9-02 navigation/loading/error/redirect/mobile/expand, W9-03 reply links, W9-04 website logins
// per workspace across a restart and Clear website data, W9-05 new windows/permissions/downloads/
// overlays, SEC-02 page against Cockpit's own origins; then order 11 (proof-wave-9-agent.ts): the
// agent's browser tools and approvals (W9-06–W9-12, SEC-01–SEC-03). Stand-in agent only (fixtures/wave9-agent).
// Usage: npm run package:proof, then COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:wave-9
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { messageBox, openProject, setTheme } from './lib/ui.ts'
import { agentBrowserProof } from './proof-wave-9-agent.ts'

const { check, finish } = checker()
const root = mkdtempSync(join(tmpdir(), 'cockpit-wave9-proof-'))
const home = join(root, 'state')
const one = join(root, 'one')
const two = join(root, 'two')
for (const dir of [one, two]) { mkdirSync(dir); writeFileSync(join(dir, 'README.md'), '# demo\n') }
mkdirSync(PROOF_DIR, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(label: string, test: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await test().catch(() => false)) return true; await sleep(150) }
  console.log(`  (timed out waiting for ${label})`)
  return false
}

// ---------- fixture sites: A (the "app"), B (a second origin), and a port nothing listens on ----------
const hits: Record<string, number> = {}
const listen = (server: Server): Promise<string> => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)))
let B = ''
const siteA = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]!
  hits[path] = (hits[path] ?? 0) + 1
  if (path === '/set-cookie') { res.writeHead(200, { 'set-cookie': 'sid=w9; Max-Age=86400; Path=/', 'content-type': 'text/html' }); return res.end('<title>Signed in</title><p>signed in</p>') }
  if (path === '/whoami') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<title>Who</title><p id="who">${req.headers.cookie ?? 'none'}</p>`) }
  if (path === '/redirect') { res.writeHead(302, { location: `${B}/` }); return res.end() }
  if (path === '/download') { res.writeHead(200, { 'content-disposition': 'attachment; filename="report.bin"', 'content-type': 'application/octet-stream' }); return res.end('data') }
  if (path === '/two') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<title>Two</title><body style="background:#e8f0e3"><h1>Page two</h1>') }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<title>Site A</title><body style="background:#e3ebf8;font:16px system-ui"><h1>Site A</h1><a id="two" href="/two">Go to two</a>')
})
const siteB = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Site B</title><body style="background:#f8ebe3"><h1>Site B</h1>') })
const A = await listen(siteA)
B = await listen(siteB)
const deadServer = createServer()
const dead = await listen(deadServer)
await new Promise((r) => deadServer.close(r))

// ---------- the host's pages, read from the main process ----------
interface ViewInfo { readonly id: number; readonly url: string; readonly visible: boolean; readonly bounds: { x: number; y: number; width: number; height: number } }
const views = (app: ElectronApplication): Promise<ViewInfo[]> => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap((w) => w.contentView.children.map((v) => {
  const c = (v as unknown as { webContents: Electron.WebContents }).webContents
  return { id: c.id, url: c.getURL(), visible: v.getVisible(), bounds: v.getBounds() }
})))
const shown = async (app: ElectronApplication): Promise<ViewInfo | undefined> => (await views(app)).find((v) => v.visible)
const inPage = <T>(app: ElectronApplication, id: number, code: string): Promise<T> =>
  app.evaluate(({ webContents }, [wcId, js]) => webContents.fromId(wcId as number)!.executeJavaScript(js as string, true), [id, code] as const) as Promise<T>

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchPackagedApp({ COCKPIT_HOME: home, COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/wave9-agent') })
  await app.evaluate(({ shell }) => {
    const opened: string[] = []
    ;(globalThis as { __opened?: string[] }).__opened = opened
    shell.openExternal = async (url: string) => void opened.push(url)
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}
/** Cockpit's window as Playwright sees it, plus (the host draws it separately) the visible page itself. */
async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(PROOF_DIR, `wave9-${name}.png`) })
  const visible = await shown(app).catch(() => undefined)
  if (!visible) return
  const png = await app.evaluate(async ({ webContents }, id) => (await webContents.fromId(id)!.capturePage()).toPNG().toString('base64'), visible.id)
  writeFileSync(join(PROOF_DIR, `wave9-${name}-page.png`), Buffer.from(png, 'base64'))
}
const address = (page: Page) => page.getByRole('textbox', { name: 'Address' })
async function goTo(page: Page, url: string): Promise<void> {
  await address(page).click()
  await address(page).fill(url)
  await address(page).press('Enter')
}
async function converse(page: Page, prompt: string): Promise<void> {
  await page.getByRole('button', { name: 'New conversation' }).click()
  const fresh = page.getByRole('button', { name: 'Start fresh', exact: true })
  if (await fresh.waitFor({ timeout: 3000 }).then(() => true, () => false)) await fresh.click()
  await messageBox(page).fill(prompt)
  await messageBox(page).press('Enter')
  await page.locator('.thread-head h1').waitFor()
}
const card = (page: Page, text: string) => page.locator('button.card', { hasText: text }).first()
const near = (a: number, b: number) => Math.abs(a - b) <= 1

let { app, page } = await launch()
try {
  await openProject(page, one, 'One')
  await setTheme(page, 'Light')

  // ---------- W9-01 / H1: the conversation's own page beside the chat ----------
  await converse(page, `open ${A}/`)
  check('W9-01 open_preview opens the browser pane beside the chat', await until('pane', () => page.locator('.browser-pane').isVisible()))
  check('W9-01 the host shows the page at that address', await until('page A', async () => (await shown(app))?.url === `${A}/`))
  const view = (await shown(app))!
  const box = await page.locator('.browser-viewport').boundingBox()
  check('W9-01 the page sits exactly over the pane viewport', Boolean(box) && near(view.bounds.x, box!.x) && near(view.bounds.y, box!.y) && near(view.bounds.width, box!.width) && near(view.bounds.height, box!.height), JSON.stringify({ view: view.bounds, box }))
  const env = await inPage<string>(app, view.id, 'typeof window.cockpit + "/" + typeof require + "/" + typeof process')
  check('SEC-02 the page has no Cockpit bridge, no Node', env === 'undefined/undefined/undefined', env)
  await shot(page, 'light-open')

  // ---------- W9-02 navigation, reload, redirect, error, mobile, expand ----------
  await inPage(app, view.id, `document.getElementById('two').click(); 1`)
  check('W9-02 following a link in the page updates the address', await until('two', async () => (await address(page).inputValue()) === `${A}/two`))
  const back = page.getByRole('button', { name: 'Back', exact: true })
  const forward = page.getByRole('button', { name: 'Forward', exact: true })
  check('W9-02 Back is enabled and Forward is not', await until('back enabled', () => back.isEnabled()) && await forward.isDisabled())
  await back.click()
  check('W9-02 Back returns to the first page', await until('back', async () => (await shown(app))?.url === `${A}/`))
  check('W9-02 Forward is then enabled', await until('forward enabled', () => forward.isEnabled()))
  await forward.click()
  check('W9-02 Forward goes to page two again', await until('forward', async () => (await shown(app))?.url === `${A}/two`))
  const before = hits['/two'] ?? 0
  await page.getByRole('button', { name: 'Reload', exact: true }).click()
  check('W9-02 Reload asks the site again', await until('reload', async () => (hits['/two'] ?? 0) > before))
  await goTo(page, `${A}/redirect`)
  check('W9-02 a redirect shows the new origin in the address', await until('redirected', async () => (await address(page).inputValue()) === `${B}/`))
  await goTo(page, dead.replace('http://', ''))
  check('W9-02 a page that fails to load shows an error with Retry', await until('error', () => page.locator('.browser-error').getByRole('button', { name: 'Retry' }).isVisible()))
  check('W9-02 the failed page is not drawn over the error', !(await shown(app)))
  await shot(page, 'light-error')
  await goTo(page, `${A}/`)
  check('W9-02 a working address after the error shows the page again', await until('recovered', async () => (await shown(app))?.url === `${A}/`))
  await page.getByRole('button', { name: 'Mobile width' }).click()
  check('W9-02 mobile width draws the page 390 px wide', await until('mobile', async () => (await shown(app))?.bounds.width === 390))
  check('W9-02 the page itself sees a 390 px viewport', await until('viewport', async () => (await inPage<number>(app, (await shown(app))!.id, 'innerWidth')) === 390))
  await shot(page, 'light-mobile')
  await page.getByRole('button', { name: 'Desktop width' }).click()
  const paneWidth = async () => (await page.locator('.browser-pane').boundingBox())!.width
  const normal = await paneWidth()
  const windowWidth = await page.evaluate(() => innerWidth)
  const listWidth = (await page.locator('.layout > .list').boundingBox())?.width ?? 0
  await page.getByRole('button', { name: 'Expand', exact: true }).click()
  check('W9-02 Expand leaves the conversation its minimum (420 px)', await until('expanded', async () => near(await paneWidth(), windowWidth - listWidth - 420)))
  check('W9-02 the conversation stays reachable while expanded', await messageBox(page).isVisible())
  await page.getByRole('button', { name: 'Restore', exact: true }).click()
  check('W9-02 Restore returns the previous width', await until('restored', async () => near(await paneWidth(), normal)))

  // ---------- W9-05: overlays, new windows, permissions, downloads ----------
  await page.getByRole('button', { name: 'Appearance', exact: true }).click()
  check('W9-05 a Cockpit popover over the pane hides the page', await until('hidden under popover', async () => !(await shown(app))))
  await shot(page, 'light-popover')
  await page.keyboard.press('Escape')
  check('W9-05 closing it shows the page again', await until('shown again', async () => Boolean(await shown(app))))
  const pageId = (await shown(app))!.id
  await inPage(app, pageId, `window.open('${B}/', '_blank'); 1`)
  check('W9-05 a new window opens in the same page, not a new window', await until('popup in page', async () => (await shown(app))?.url === `${B}/`)
    && await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length) === 1)
  const permission = await inPage<string>(app, pageId, 'Notification.requestPermission()')
  check('W9-05 a permission request is denied, nothing granted', permission === 'denied', permission)
  await app.evaluate(({ webContents }, id) => {
    webContents.fromId(id)!.session.once('will-download', (_event, item) => {
      ;(globalThis as { __download?: unknown }).__download = { name: item.getFilename(), savePath: item.getSavePath() }
      item.cancel()
    })
  }, pageId)
  await goTo(page, `${A}/download`)
  const download = await until('download', async () => Boolean(await app.evaluate(() => (globalThis as { __download?: unknown }).__download)))
    ? await app.evaluate(() => (globalThis as { __download?: { name: string; savePath: string } }).__download) : undefined
  check('W9-05 a download has no automatic save path: the person chooses where', download?.name === 'report.bin' && download.savePath === '', JSON.stringify(download))

  // ---------- SEC-02 Cockpit's own origins ----------
  await goTo(page, `${A}/`)
  await until('back on A', async () => (await shown(app))?.url === `${A}/`)
  const cockpit = new URL(page.url())
  for (const target of [`${cockpit.origin}/api/threads`, `http://localhost:${cockpit.port}/api/threads`, `http://[::1]:${cockpit.port}/api/threads`]) {
    const outcome = await inPage<string>(app, pageId, `fetch('${target}').then(r => 'status ' + r.status, () => 'blocked')`)
    check(`SEC-02 the page cannot reach Cockpit at ${target.replace(/\/api.*/, '')}`, outcome === 'blocked', outcome)
  }
  await inPage(app, pageId, `location.href = 'file:///etc/hosts'; 1`).catch(() => undefined)
  await sleep(400)
  check('SEC-02 the page cannot navigate itself to a local file', (await shown(app))?.url === `${A}/`)
  check('SEC-02 the address field refuses other schemes', await (async () => {
    await goTo(page, 'javascript:alert(1)')
    return page.locator('.browser-error', { hasText: 'web address' }).isVisible()
  })())
  await page.getByRole('button', { name: 'Back to the page' }).click()

  // ---------- W9-03 / G5 reply links ----------
  await messageBox(page).fill(`links ${A}/two http://cockpit-proof.invalid/`)
  await messageBox(page).press('Enter')
  const reply = page.locator('.transcript').getByRole('link', { name: 'the app' })
  await reply.waitFor()
  await reply.click()
  check('W9-03 a web link in a reply opens in the conversation’s pane', await until('reply link', async () => (await shown(app))?.url === `${A}/two`))
  await page.locator('.transcript').getByRole('link', { name: 'docs' }).click()
  check('W9-03 a site that does not resolve shows the load error, not a blank page', await until('dns error', () => page.locator('.browser-error').getByRole('button', { name: 'Retry' }).isVisible()))
  await page.locator('.transcript').getByRole('link', { name: 'docs' }).click({ modifiers: ['Meta'] })
  check('W9-03 ⌘-click opens the default browser instead', await until('external', async () => (await app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? [])).includes('http://cockpit-proof.invalid/')))
  check('W9-03 an unsafe scheme is not a link at all', await page.locator('.transcript a[href^="cockpit-proof-app"]').count() === 0 && await page.locator('.transcript').getByText('launch', { exact: true }).isVisible())
  check('W9-03 a file reference keeps its in-app meaning (Files)', await page.locator('.transcript').getByRole('button', { name: /README\.md/ }).isVisible())
  await goTo(page, `${A}/`)

  // ---------- W9-01 two conversations, close, drafts ----------
  await messageBox(page).fill('a draft that stays')
  await converse(page, `open ${B}/`)
  check('W9-01 a second conversation opens its own page', await until('page B', async () => (await shown(app))?.url === `${B}/`))
  check('W9-01 only one page is drawn at a time', (await views(app)).filter((v) => v.visible).length === 1 && (await views(app)).length === 2)
  await card(page, `open ${A}/`).click()
  check('W9-01 switching back restores the first conversation’s page', await until('restore A', async () => (await shown(app))?.url === `${A}/`))
  check('W9-01 its draft is still there', await messageBox(page).inputValue() === 'a draft that stays')
  await page.getByRole('button', { name: 'Close browser' }).click()
  check('W9-01 Close hides the pane and the page', await until('closed', async () => !(await page.locator('.browser-pane').count()) && !(await shown(app))))
  await card(page, `open ${B}/`).click()
  check('W9-01 the other conversation’s pane is still open', await until('B open', async () => (await shown(app))?.url === `${B}/`))
  await card(page, `open ${A}/`).click()
  check('W9-01 the closed pane stays closed when you come back', await until('stays closed', async () => !(await page.locator('.browser-pane').count())))
  await card(page, `open ${B}/`).click()
  await until('B again', async () => Boolean(await shown(app)))

  // ---------- W9-01 at 980×640, light and dark ----------
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(980, 640))
  await sleep(400)
  // Below 1100 px the conversation and the page are tabs (persona audit item 4). Coming back to a
  // conversation whose page the agent opened keeps Workspace in view; the pane is one tab away.
  const tabs = page.getByRole('tablist', { name: 'Workspace and preview' })
  check('W9-01 at 980×640 Workspace and Preview are tabs, and the conversation stays in view', await tabs.isVisible()
    && await tabs.getByRole('tab', { name: 'Workspace' }).getAttribute('aria-selected') === 'true')
  await tabs.getByRole('tab', { name: 'Preview' }).click()
  await until('page on Preview', async () => Boolean(await shown(app)), 5000)
  const controls = ['Back', 'Forward', 'Reload', 'Mobile width', 'Expand', 'Open in browser', 'Close browser']
  let reachable = true
  for (const name of controls) {
    const b = await page.getByRole('button', { name, exact: true }).boundingBox()
    if (!b || b.x < 0 || b.x + b.width > 980 || b.y + b.height > 640) { reachable = false; console.log(`  (${name} out of reach: ${JSON.stringify(b)})`) }
  }
  check('W9-01 at 980×640 every pane control is inside the window', reachable)
  await tabs.getByRole('tab', { name: 'Workspace' }).click()
  await until('conversation width', async () => ((await page.locator('.thread').first().boundingBox())?.width ?? 0) >= 379, 5000)
  const chat = (await page.locator('.thread').first().boundingBox())?.width ?? 0
  const hiddenPage = await until('page out of view', async () => !(await shown(app)), 5000)
  check('W9-01 at 980×640 the Workspace tab gives the conversation at least 380 px and takes the page out of view', chat >= 379 && hiddenPage === true, `${Math.round(chat)} px`)
  await tabs.getByRole('tab', { name: 'Preview' }).click()
  await until('page back on Preview', async () => Boolean(await shown(app)), 5000)
  const small = (await shown(app))!
  check('W9-01 at 980×640 the page stays inside the window', small.bounds.x + small.bounds.width <= 980 && small.bounds.y + small.bounds.height <= 640, JSON.stringify(small.bounds))
  await shot(page, 'light-980')
  await setTheme(page, 'Dark')
  await until('page back after theme menu', async () => Boolean(await shown(app)))
  await shot(page, 'dark-980')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1360, 860))

  // ---------- A4: hide the list; the Conversations tab opens it as a dropdown ----------
  await setTheme(page, 'Light')
  await page.getByRole('button', { name: 'Hide conversation list' }).click()
  const tab = page.locator('#section-conversations')
  check('A4 Hide list removes the column', await until('list gone', async () => await page.locator('.layout > .list').count() === 0))
  check('A4 focus moves to the Conversations tab', await until('tab focus', () => tab.evaluate((el) => el === document.activeElement)))
  check('A4 the tab names the open conversation and opens a dropdown', (await tab.textContent() ?? '').includes(`open ${B}/`) && await tab.getAttribute('aria-haspopup') === 'dialog')
  await shot(page, 'light-list-hidden')
  await tab.click()
  const dropdown = page.getByRole('dialog', { name: 'Conversations list' })
  check('A4 the tab opens the list as a dropdown with its search focused', await until('dropdown', () => dropdown.isVisible())
    && await until('search focus', () => page.evaluate(() => document.activeElement?.closest('.list-dropdown') !== null)))
  await shot(page, 'light-list-dropdown')
  await page.keyboard.press('Escape')
  const escClosed = await until('closed', async () => !(await dropdown.count()))
  check('A4 Escape closes it and focus returns to the tab', escClosed && await until('tab focus again', () => tab.evaluate((el) => el === document.activeElement)), `closed ${escClosed}`)
  await messageBox(page).fill('B draft stays')
  await tab.click()
  await dropdown.locator('button.card', { hasText: `open ${A}/` }).click()
  check('A4 picking a conversation opens it and closes the dropdown', await until('switched', async () => (await tab.textContent() ?? '').includes(`open ${A}/`)) && !(await dropdown.count()))
  await tab.click()
  await dropdown.locator('button.card', { hasText: `open ${B}/` }).click()
  check('A4 switching through the dropdown keeps the draft (not sent, not cleared)', await until('draft', async () => await messageBox(page).inputValue() === 'B draft stays'))
  await messageBox(page).fill('')
  await tab.click()
  await page.getByRole('button', { name: 'Show conversation list' }).click()
  check('A4 title toggle brings the column back', await until('list back', async () => await page.locator('.layout > .list').count() === 1))

  // ---------- W9-04 website logins per workspace ----------
  await goTo(page, `${A}/set-cookie`)
  await until('signed in', async () => (await shown(app))?.url === `${A}/set-cookie`)
  await openProject(page, two, 'Two')
  await converse(page, `open ${A}/whoami`)
  await until('who in two', async () => (await shown(app))?.url === `${A}/whoami`)
  const whoTwo = await inPage<string>(app, (await shown(app))!.id, `document.getElementById('who').textContent`)
  check('W9-04 another workspace does not share the login', whoTwo === 'none', whoTwo)
  await openProject(page, one, 'One')
  await card(page, `open ${B}/`).click()
  await goTo(page, `${A}/whoami`)
  await until('who in one', async () => (await shown(app))?.url === `${A}/whoami`)
  const whoOne = await inPage<string>(app, (await shown(app))!.id, `document.getElementById('who').textContent`)
  check('W9-04 conversations in the same workspace share its login', whoOne === 'sid=w9', whoOne)
} catch (err) {
  check('proof ran to the end (first launch)', false, err instanceof Error ? err.message.split('\n')[0] : String(err))
  await shot(page, 'failure').catch(() => undefined)
}
await app.close()

// ---------- W9-04 after a restart; Clear website data ----------
;({ app, page } = await launch())
try {
  await openProject(page, one, 'One')
  await card(page, `open ${B}/`).click()
  check('W9-04 after a restart the pane comes back at its last address', await until('restored after restart', async () => (await shown(app))?.url === `${A}/whoami`, 15_000))
  const kept = await inPage<string>(app, (await shown(app))!.id, `document.getElementById('who').textContent`)
  check('W9-04 the website login survived the restart', kept === 'sid=w9', kept)
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await page.getByRole('menuitem', { name: 'One settings…' }).click()
  await page.locator('.project-settings').waitFor()
  await page.getByRole('button', { name: 'Clear website data' }).click()
  check('W9-04 Clear website data names the project it cleared', await until('cleared', () => page.getByText('Cleared website data for One.').isVisible()))
  await page.getByRole('button', { name: 'Done' }).click()
  await page.getByRole('button', { name: 'Reload', exact: true }).click()
  await sleep(600)
  const after = await inPage<string>(app, (await shown(app))!.id, `document.getElementById('who').textContent`)
  check('W9-04 the cleared login is gone', after === 'none', after)
} catch (err) {
  check('proof ran to the end (after restart)', false, err instanceof Error ? err.message.split('\n')[0] : String(err))
  await shot(page, 'failure-restart').catch(() => undefined)
} finally {
  await app.close()
  siteA.close()
  siteB.close()
}
// ---------- order 11: the agent's browser tools, approvals, residency, legacy tools, Use my Chrome ----------
await agentBrowserProof(check)
finish('proof:wave-9')
