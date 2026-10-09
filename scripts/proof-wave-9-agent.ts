// Packaged gate for wave 9 order 11, run by proof-wave-9.ts after the order 10 phases:
// W9-06 agent tools on a controlled app, W9-07 stale revisions, W9-08 page scope and forged ids,
// W9-09 approvals, grants and what revokes them, W9-10 residency, W9-11 legacy open/inspect,
// W9-12 Use my Chrome, SEC-01–SEC-03 against the agent's page, CROSS-03/05. Stand-in agent only
// (fixtures/wave9-agent "session"/"inspect"/"chrome"). "Remote" sites are the same local fixture
// under other names (Chromium --host-resolver-rules), so Cockpit's policy sees remote origins.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { ElectronApplication, Locator, Page } from 'playwright-core'
import { launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { messageBox, openProject, setTheme } from './lib/ui.ts'

type Check = (name: string, ok: boolean, detail?: string) => void
interface ViewInfo { readonly id: number; readonly url: string; readonly visible: boolean; readonly bounds: { x: number; y: number; width: number; height: number } }
interface CallResult { readonly code: number; readonly body: { data?: Record<string, unknown> & { page?: PageInfo; outcome?: string; detail?: string }; error?: string } }
interface PageInfo { pageId: string; revision: number; url: string; origin: string; viewport: { width: number; height: number }; timestamp: string }
interface Element { ref: string; role: string; name: string; x: number; y: number; width: number; height: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(label: string, test: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await test().catch(() => false)) return true; await sleep(150) }
  console.log(`  (timed out waiting for ${label})`)
  return false
}
const views = (app: ElectronApplication): Promise<ViewInfo[]> => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap((w) => w.contentView.children.map((v) => {
  const c = (v as unknown as { webContents: Electron.WebContents }).webContents
  return { id: c.id, url: c.getURL(), visible: v.getVisible(), bounds: v.getBounds() }
})))
const viewAt = async (app: ElectronApplication, url: string): Promise<ViewInfo | undefined> => (await views(app)).find((v) => v.url === url)
const inPage = <T>(app: ElectronApplication, id: number, code: string): Promise<T> =>
  app.evaluate(({ webContents }, [wcId, js]) => webContents.fromId(wcId as number)!.executeJavaScript(js as string, true), [id, code] as const) as Promise<T>
const text = (app: ElectronApplication, url: string, id: string): Promise<string | undefined> =>
  viewAt(app, url).then((v) => (v ? inPage<string>(app, v.id, `document.getElementById(${JSON.stringify(id)})?.textContent ?? ''`) : undefined))
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
async function say(page: Page, message: string): Promise<void> {
  await messageBox(page).fill(message)
  await messageBox(page).press('Enter')
}
const card = (page: Page, title: string) => page.locator('button.card', { hasText: title }).first()
const openApproval = (page: Page) => page.locator('.approval.open').last()
const grantButton = (approval: Locator) => approval.getByRole('button', { name: /^Allow on .+ for this run$/ })
const allow = (approval: Locator) => approval.getByRole('button', { name: 'Allow', exact: true }).click()
const deny = (approval: Locator) => approval.getByRole('button', { name: 'Deny', exact: true }).click()
const grant = (approval: Locator) => grantButton(approval).click()
async function threadId(page: Page, title: string): Promise<string> {
  return page.evaluate(async (t) => {
    const all = (await (await fetch('/api/threads')).json()).data as Array<{ meta: { id: string; title: string } }>
    return all.find((x) => x.meta.title === t)!.meta.id
  }, title)
}
const insideWindow = async (page: Page, locator: Locator): Promise<boolean> => {
  const box = await locator.boundingBox()
  const size = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  return Boolean(box) && box!.x >= 0 && box!.y >= 0 && box!.x + box!.width <= size.width + 1 && box!.y + box!.height <= size.height + 1
}

export async function agentBrowserProof(check: Check): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-wave9-agent-'))
  const home = join(root, 'state')
  const one = join(root, 'one')
  for (const dir of [one]) { mkdirSync(dir); writeFileSync(join(dir, 'README.md'), '# demo\n') }
  const hosts = join(root, 'hosts')
  const noHosts = join(root, 'no-hosts')
  mkdirSync(hosts); mkdirSync(noHosts)
  writeFileSync(join(hosts, 'com.anthropic.claude_code_browser_extension.json'), '{"name":"com.anthropic.claude_code_browser_extension"}')
  const argsLog = join(root, 'args.log')
  let sessions = 0

  // ---------- the controlled app, also served as "remote" shop.test and other.test ----------
  let cockpitPort = 0
  const hits: Record<string, number> = {}
  const swResults: string[] = []
  const app_ = (marker: string) => `<!doctype html><title>Controlled app ${marker}</title>
<body style="margin:0;font:16px system-ui;min-height:2400px;background:#f4f1ea">
<h1 style="margin:16px;font-size:20px">Controlled app ${marker}</h1>
<button id="add" style="position:absolute;left:20px;top:80px;width:140px;height:36px">Add one</button>
<output id="count" style="position:absolute;left:180px;top:86px">0</output>
<input id="who" aria-label="Name" style="position:absolute;left:20px;top:140px;width:200px;height:28px">
<p id="echo" style="position:absolute;left:240px;top:126px"></p>
<form id="f" style="position:absolute;left:20px;top:200px;margin:0"><input id="q" aria-label="Search" style="width:200px;height:28px"></form>
<p id="submitted" style="position:absolute;left:240px;top:186px"></p>
<div id="hov" tabindex="0" aria-label="Hover me" style="position:absolute;left:20px;top:260px;width:120px;height:40px;background:#ddd">Hover me</div>
<p id="hovered" style="position:absolute;left:160px;top:246px">no</p>
<div id="box" tabindex="0" aria-label="Drag me" style="position:absolute;left:20px;top:330px;width:60px;height:60px;background:#88f"></div>
<a id="next" href="/next" style="position:absolute;left:20px;top:420px">Next page</a>
<script>
const $ = (id) => document.getElementById(id)
$('add').onclick = () => { $('count').textContent = String(Number($('count').textContent) + 1) }
$('who').oninput = () => { $('echo').textContent = $('who').value }
$('f').onsubmit = (e) => { e.preventDefault(); $('submitted').textContent = $('q').value }
$('hov').onmouseenter = () => { $('hovered').textContent = 'yes' }
let drag = null
$('box').onmousedown = (e) => { drag = { x: e.clientX - $('box').offsetLeft, y: e.clientY - $('box').offsetTop } }
addEventListener('mousemove', (e) => { if (drag) { $('box').style.left = (e.clientX - drag.x) + 'px'; $('box').style.top = (e.clientY - drag.y) + 'px' } })
addEventListener('mouseup', () => { drag = null })
</script>`
  const site = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    hits[path] = (hits[path] ?? 0) + 1
    const html = (body: string) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(body) }
    if (path === '/next') return html('<title>Next</title><h1 style="margin:16px;font-size:20px">Next page</h1><button id="trap" style="position:absolute;left:20px;top:80px;width:140px;height:36px">Trap</button><p id="trapped" style="position:absolute;left:180px;top:70px">no</p><script>document.getElementById("trap").onclick=()=>{document.getElementById("trapped").textContent="clicked"}</script>')
    if (path === '/to-cockpit') { res.writeHead(302, { location: `http://127.0.0.1:${cockpitPort}/` }); return res.end() }
    if (path === '/sw-page') return html('<title>SW</title><p>service worker probe</p><script>navigator.serviceWorker.register("/sw.js").catch(() => fetch("/sw-report?result=register-failed"))</script>')
    if (path === '/sw.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' })
      return res.end(`self.addEventListener('install', (e) => { e.waitUntil(fetch('http://127.0.0.1:${cockpitPort}/api/threads').then(() => fetch('/sw-report?result=reached'), () => fetch('/sw-report?result=blocked'))) })`)
    }
    if (path === '/sw-report') { swResults.push(url.searchParams.get('result') ?? ''); res.writeHead(204); return res.end() }
    html(app_(path === '/' ? '' : path.slice(1)))
  })
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', () => resolve()))
  const P = (site.address() as AddressInfo).port
  const LOCAL = `http://127.0.0.1:${P}`
  const SHOP = `http://shop.test:${P}`
  const OTHER = `http://other.test:${P}`
  const RESOLVE = [`--host-resolver-rules=MAP shop.test 127.0.0.1, MAP other.test 127.0.0.1`]

  async function launch(extra: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
    const app = await launchPackagedApp({ COCKPIT_HOME: home, COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/wave9-agent'), W9_ARGS: argsLog, COCKPIT_CHROME_NATIVE_HOSTS: hosts, ...extra }, RESOLVE)
    const page = await app.firstWindow()
    page.setDefaultTimeout(15_000)
    await page.waitForLoadState('domcontentloaded')
    cockpitPort = Number(new URL(page.url()).port)
    return { app, page }
  }
  async function shot(app: ElectronApplication, page: Page, name: string): Promise<void> {
    await page.screenshot({ path: join(PROOF_DIR, `wave9-agent-${name}.png`) })
    const visible = (await views(app).catch(() => [])).find((v) => v.visible)
    if (!visible) return
    const png = await app.evaluate(async ({ webContents }, id) => (await webContents.fromId(id)!.capturePage()).toPNG().toString('base64'), visible.id)
    writeFileSync(join(PROOF_DIR, `wave9-agent-${name}-page.png`), Buffer.from(png, 'base64'))
  }

  /** One agent run: the stand-in waits for numbered call files and answers each in turn. */
  function runIn(page: Page) {
    const dir = join(root, `s${++sessions}`)
    mkdirSync(dir)
    let n = 0
    return {
      async start(): Promise<void> { await say(page, `session ${dir}`) },
      async call(op: string, body: Record<string, unknown> = {}, answer?: (approval: Locator) => Promise<void>): Promise<CallResult> {
        const step = ++n
        writeFileSync(join(dir, `${step}-${op}.json`), JSON.stringify(body))
        if (answer) {
          const approval = openApproval(page)
          await approval.waitFor({ timeout: 15_000 })
          await answer(approval)
        }
        await until(`call ${step} ${op}`, async () => existsSync(join(dir, `${step}.code`)), 30_000)
        const raw = existsSync(join(dir, `${step}.out`)) ? readFileSync(join(dir, `${step}.out`), 'utf8') : '{}'
        return { code: Number(readFileSync(join(dir, `${step}.code`), 'utf8')), body: JSON.parse(raw || '{}') }
      },
      /** Writes the call and returns at once: for a call that a Stop will cut off. */
      fire(op: string, body: Record<string, unknown> = {}): string {
        const step = ++n
        writeFileSync(join(dir, `${step}-${op}.json`), JSON.stringify(body))
        return join(dir, `${step}.out.part`)
      },
      async end(): Promise<void> {
        writeFileSync(join(dir, `${n + 1}-end.json`), '{}')
        await until('session end', () => page.locator('.bubble.agent').getByText(`Session done after ${n} calls.`).isVisible(), 15_000)
      },
    }
  }
  // Answered cards fold into a decisions line, so count the approval requests the conversation recorded.
  const asked = (page: Page, id: string): Promise<number> => page.evaluate(async (t) =>
    ((await (await fetch(`/api/threads/${t}/events`)).json()).data.events as Array<{ event: { kind: string } }>).filter((e) => e.event.kind === 'approval_request').length, id)
  const elementsOf = (r: CallResult): Element[] => (r.body.data?.elements as Element[] | undefined) ?? []
  const refFor = (r: CallResult, name: string): string => elementsOf(r).find((e) => e.name === name)?.ref ?? 'missing'
  const directCall = async (op: string, body: unknown): Promise<number> => {
    const [mcpUrl, token] = readFileSync(`${argsLog}.token`, 'utf8').trim().split(' ')
    const response = await fetch(`${mcpUrl}/api/mcp/browser/${op}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return response.status
  }

  // ======================= launch 3: agent tools, approvals, legacy, Chrome =======================
  let { app, page } = await launch()
  try {
    await openProject(page, one, 'One')
    await setTheme(page, 'Light')

    // ---------- W9-06: every operation against the controlled app, the person watching ----------
    await converse(page, 'agent A')
    await page.locator('.bubble.agent').getByText('OK.').first().waitFor()
    const aId = await threadId(page, 'agent A')
    const pageA = `thread:${aId}`
    const run1 = runIn(page)
    await run1.start()
    let r = await run1.call('navigate', { url: `${LOCAL}/` })
    const info = r.body.data?.page ?? (r.body.data as unknown as PageInfo)
    check('W9-06 opening the local app needs no approval', r.code === 200 && await asked(page, aId) === 0, `${r.code} ${JSON.stringify(r.body).slice(0, 160)}`)
    check('W9-06 every response names the page, revision, origin, viewport and time', info?.pageId === pageA && typeof info.revision === 'number' && info.origin === LOCAL && info.viewport?.width > 0 && Boolean(info.timestamp), JSON.stringify(info))
    check('W9-06 the agent’s page shows beside its conversation', await until('pane for agent page', async () => (await viewAt(app, `${LOCAL}/`))?.visible === true))
    r = await run1.call('read')
    const rev = r.body.data?.page?.revision ?? -1
    check('W9-06 read lists the page text and its controls with refs for this revision', String(r.body.data?.text ?? '').includes('Controlled app') && ['Add one', 'Name', 'Search', 'Hover me', 'Drag me'].every((n) => refFor(r, n).startsWith(`e${rev}-`)), elementsOf(r).map((e) => e.name).join(', '))
    const box = elementsOf(r).find((e) => e.name === 'Drag me')!
    const first = r
    let cardText = ''
    let grantLabel = ''
    r = await run1.call('click', { revision: rev, ref: refFor(first, 'Add one') }, async (approval) => {
      cardText = await approval.textContent() ?? ''
      grantLabel = await grantButton(approval).textContent() ?? ''
      await shot(app, page, 'approval-light')
      await grant(approval)
    })
    check('W9-06 the first input asks, naming the page’s origin and the action', cardText.includes(`127.0.0.1:${P}`) && /click/i.test(cardText), cardText.slice(0, 200))
    check('W9-06 the card offers the run grant for that exact site', grantLabel === `Allow on 127.0.0.1:${P} for this run`, grantLabel)
    check('W9-06 click: the button really counted one', r.body.data?.outcome === 'done' && await text(app, `${LOCAL}/`, 'count') === '1', JSON.stringify(r.body.data?.detail))
    const SECRET = 'Wave nine typed this'
    r = await run1.call('type', { revision: rev, ref: refFor(first, 'Name'), text: SECRET })
    check('W9-06 type: the field holds the text, with no second approval', await text(app, `${LOCAL}/`, 'echo') === SECRET && await asked(page, aId) === 1, `${await text(app, `${LOCAL}/`, 'echo')} / ${await asked(page, aId)} asked`)
    check('W9-06 the result reports only the length of what was typed', String(r.body.data?.detail).includes(`${SECRET.length} characters`) && !JSON.stringify(r.body).includes(SECRET))
    await run1.call('type', { revision: rev, ref: refFor(first, 'Search'), text: 'abc' })
    r = await run1.call('key', { revision: rev, key: 'Enter' })
    check('W9-06 key: Enter submits the form', r.body.data?.outcome === 'done' && await text(app, `${LOCAL}/`, 'submitted') === 'abc')
    r = await run1.call('hover', { revision: rev, ref: refFor(first, 'Hover me') })
    check('W9-06 hover: the hover target saw the pointer', await text(app, `${LOCAL}/`, 'hovered') === 'yes')
    r = await run1.call('drag', { revision: rev, from: { x: box.x + 30, y: box.y + 30 }, to: { x: box.x + 130, y: box.y + 80 }, steps: 6 })
    const moved = await inPage<string>(app, (await viewAt(app, `${LOCAL}/`))!.id, `getComputedStyle(document.getElementById('box')).left + ' ' + getComputedStyle(document.getElementById('box')).top`)
    check('W9-06 drag: the box moved by exactly the drag', moved === `${box.x + 100}px ${box.y + 50}px`, moved)
    r = await run1.call('scroll', { revision: rev, dy: 600 })
    const scrolled = await inPage<number>(app, (await viewAt(app, `${LOCAL}/`))!.id, 'scrollY')
    check('W9-06 scroll: the page scrolled and the result says where to', scrolled > 0 && String(r.body.data?.detail).includes(`(0, ${scrolled})`), `${scrolled} ${r.body.data?.detail}`)
    r = await run1.call('screenshot')
    const shownA = await viewAt(app, `${LOCAL}/`)
    const pngBytes = Buffer.from(String(r.body.data?.data ?? ''), 'base64')
    writeFileSync(join(PROOF_DIR, 'wave9-agent-screenshot.png'), pngBytes)
    check('W9-06 screenshot: a PNG of exactly the agent’s page at its viewport size', r.code === 200 && pngBytes.subarray(1, 4).toString() === 'PNG' && r.body.data?.width === shownA?.bounds.width && r.body.data?.height === shownA?.bounds.height, `${r.body.data?.width}×${r.body.data?.height} vs ${JSON.stringify(shownA?.bounds)}`)
    check('W9-06 the screenshot reports the page and revision it shows', r.body.data?.page?.pageId === pageA && r.body.data?.page?.revision === rev)
    const events = await page.evaluate(async (id) => JSON.stringify(await (await fetch(`/api/threads/${id}/events`)).json()), aId)
    check('W9-06 typed text is in no stored event, only its length', !events.includes(SECRET) && events.includes(`"characters":${SECRET.length}`))
    let found = ''
    try { found = execFileSync('grep', ['-rl', '--exclude-dir=electron', SECRET, home], { encoding: 'utf8' }) } catch { found = '' }
    const onDisk = found.trim().split('\n').filter(Boolean)
    check('W9-06 typed text is in no Cockpit file on disk (events, transcript)', onDisk.length === 0, onDisk.join(', '))

    // ---------- W9-07: a page that changed refuses the stale action ----------
    await run1.call('scroll', { revision: rev, dy: -600 })
    r = await run1.call('read')
    const rev7 = r.body.data?.page?.revision ?? -1
    const addAt = elementsOf(r).find((e) => e.name === 'Add one')!
    await goTo(page, `${LOCAL}/next`)
    await until('user moved to next', async () => Boolean(await viewAt(app, `${LOCAL}/next`)))
    r = await run1.call('click', { revision: rev7, ref: refFor(r, 'Add one') })
    check('W9-07 after the person navigates, a ref from before is refused as stale', r.body.data?.outcome === 'stale' && r.body.data?.page?.url === `${LOCAL}/next`, String(JSON.stringify(r.body)).slice(0, 200))
    r = await run1.call('click', { revision: rev7, x: addAt.x + 10, y: addAt.y + 10 })
    check('W9-07 a point from before is refused too: the button now there is not clicked', r.body.data?.outcome === 'stale' && await text(app, `${LOCAL}/next`, 'trapped') === 'no')
    r = await run1.call('read')
    const rev7b = r.body.data?.page?.revision ?? -1
    await page.getByRole('button', { name: 'Mobile width' }).click()
    await until('mobile', async () => (await viewAt(app, `${LOCAL}/next`))?.bounds.width === 390)
    r = await run1.call('click', { revision: rev7b, x: 30, y: 90 })
    check('W9-07 after a viewport change the old revision is refused', r.body.data?.outcome === 'stale' && await text(app, `${LOCAL}/next`, 'trapped') === 'no', JSON.stringify(r.body.data?.page?.viewport))
    await page.getByRole('button', { name: 'Desktop width' }).click()
    // Approved, but the person moved the page before answering: still refused.
    r = await run1.call('navigate', { url: `${SHOP}/` }, allow)
    check('W9-07 a remote site opens after an approval (resolver stand-in for a real site)', r.code === 200 && r.body.data?.origin === SHOP, JSON.stringify(r.body).slice(0, 160))
    r = await run1.call('read', {}, allow)
    const rev7c = r.body.data?.page?.revision ?? -1
    r = await run1.call('click', { revision: rev7c, ref: refFor(r, 'Add one') }, async (approval) => {
      await goTo(page, `${SHOP}/next`)
      await until('shop next', async () => Boolean(await viewAt(app, `${SHOP}/next`)))
      await allow(approval)
    })
    check('W9-07 approved after the page changed: refused, nothing clicked on the new page', r.body.data?.outcome === 'stale' && await text(app, `${SHOP}/next`, 'trapped') === 'no', String(JSON.stringify(r.body)).slice(0, 160))
    await run1.end()

    // ---------- W9-08 / CROSS-03: agent A works on its page while the person looks at B ----------
    await converse(page, `open ${LOCAL}/b`)
    await until('page B shown', async () => (await viewAt(app, `${LOCAL}/b`))?.visible === true)
    const bId = await threadId(page, `open ${LOCAL}/b`)
    await card(page, 'agent A').click()
    const run2 = runIn(page)
    await run2.start()
    r = await run2.call('navigate', { url: `${LOCAL}/a` })
    r = await run2.call('read')
    const revA = r.body.data?.page?.revision ?? -1
    const readA = r
    await run2.call('click', { revision: revA, ref: refFor(readA, 'Add one') }, grant)
    await card(page, `open ${LOCAL}/b`).click()
    await until('B shown again', async () => (await viewAt(app, `${LOCAL}/b`))?.visible === true)
    r = await run2.call('click', { revision: revA, ref: refFor(readA, 'Add one') })
    check('W9-08 agent A clicks its own hidden page while the person views B', r.body.data?.outcome === 'done' && await text(app, `${LOCAL}/a`, 'count') === '2' && (await viewAt(app, `${LOCAL}/a`))?.visible === false)
    check('CROSS-03 the page the person looks at is untouched and still shown', await text(app, `${LOCAL}/b`, 'count') === '0' && (await viewAt(app, `${LOCAL}/b`))?.visible === true)
    r = await run2.call('hover', { revision: revA, ref: refFor(readA, 'Hover me') })
    check('W9-08 hover reaches the hidden page (pages are not throttled)', await text(app, `${LOCAL}/a`, 'hovered') === 'yes')
    r = await run2.call('scroll', { revision: revA, dy: 500 })
    check('W9-08 scroll reaches the hidden page', (await inPage<number>(app, (await viewAt(app, `${LOCAL}/a`))!.id, 'scrollY')) > 0)
    r = await run2.call('type', { revision: revA, ref: refFor(readA, 'Name'), text: 'background' })
    check('W9-08 typing reaches the hidden page', await text(app, `${LOCAL}/a`, 'echo') === 'background')
    r = await run2.call('screenshot')
    const hiddenA = await viewAt(app, `${LOCAL}/a`)
    check('W9-08 a screenshot of the hidden page is that page, still hidden', r.code === 200 && r.body.data?.page?.url === `${LOCAL}/a` && r.body.data?.width === hiddenA?.bounds.width && hiddenA?.visible === false)
    r = await run2.call('read', { pageId: `thread:${bId}` })
    check('W9-08 / SEC-03 another conversation’s page id is refused without telling anything about it', r.code === 403 && !JSON.stringify(r.body).includes('/b') && !JSON.stringify(r.body).includes(bId), JSON.stringify(r.body))
    r = await run2.call('click', { revision: revA, x: 5, y: 5, runId: 'forged-run' })
    check('W9-08 a forged run id is refused', r.code === 400)
    r = await run2.call('read', { workspaceId: 'forged-workspace' })
    check('SEC-03 a forged workspace id is refused', r.code === 400)
    check('W9-08 page B is still untouched after the forged calls', await text(app, `${LOCAL}/b`, 'count') === '0')
    await card(page, 'agent A').click()

    // ---------- W9-09 / CROSS-05: Deny, origin change, Stop, page destroyed, replay ----------
    r = await run2.call('navigate', { url: `${SHOP}/` }, deny)
    check('W9-09 Deny: nothing opens', r.code === 409 && Boolean(await viewAt(app, `${LOCAL}/a`)))
    r = await run2.call('click', { revision: revA, ref: refFor(readA, 'Add one') }, allow)
    check('W9-09 a Deny removes the run’s grants: the local app asks again', r.body.data?.outcome === 'done')
    r = await run2.call('navigate', { url: `${SHOP}/` }, grant)
    r = await run2.call('read')
    const shopRead = r
    r = await run2.call('click', { revision: shopRead.body.data?.page?.revision, ref: refFor(shopRead, 'Add one') })
    check('W9-09 the run grant covers that site without asking again', r.body.data?.outcome === 'done' && await text(app, `${SHOP}/`, 'count') === '1')
    let otherCard = ''
    r = await run2.call('navigate', { url: `${OTHER}/` }, async (approval) => { otherCard = await approval.textContent() ?? ''; await allow(approval) })
    check('W9-09 another origin needs its own grant', otherCard.includes(`other.test:${P}`) && r.code === 200)
    r = await run2.call('read', {}, deny)
    check('W9-09 and is refused when denied', r.code === 409)
    // A Deny takes every grant of the run with it, shop.test's too: it asks again.
    let reasked = false
    r = await run2.call('navigate', { url: `${SHOP}/` }, async (approval) => { reasked = true; await grant(approval) })
    check('W9-09 a Deny on one site also ends the run’s grant for another', reasked && r.code === 200)
    // The page goes away: its grants go with it.
    r = await run2.call('read')
    check('W9-09 (the shop grant is in force before the page goes: no card)', r.code === 200)
    await app.evaluate(({ webContents }, id) => webContents.fromId(id)?.close(), (await viewAt(app, `${SHOP}/`))!.id)
    await until('page destroyed', async () => !(await viewAt(app, `${SHOP}/`)))
    let askedAgain = false
    r = await run2.call('navigate', { url: `${SHOP}/` }, async (approval) => { askedAgain = true; await allow(approval) })
    check('W9-09 a destroyed page takes its grant with it: the next call asks again', askedAgain && r.code === 200)
    // Stop while a grant is live, then replay the call with the session's own token.
    await run2.call('navigate', { url: `${SHOP}/` }, grant)
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    await until('stopped', async () => !(await page.getByRole('button', { name: 'Stop', exact: true }).isVisible()))
    const replay = await directCall('click', { revision: 0, x: 10, y: 10 })
    check('W9-09 after Stop, replaying a call with the agent’s token does nothing', replay === 409, String(replay))
    const run3 = runIn(page)
    await run3.start()
    r = await run3.call('read', {}, allow)
    const pending = run3.fire('click', { revision: r.body.data?.page?.revision, ref: refFor(r, 'Add one') })
    const waiting = openApproval(page)
    check('W9-09 no grant survives into the next run: it asks again', await waiting.waitFor({ timeout: 15_000 }).then(() => true, () => false))
    // CROSS-05: Stop while the card waits; the late answer is impossible and nothing runs.
    await page.getByRole('button', { name: 'Stop', exact: true }).click()
    const closed = await until('card closed', async () => await page.locator('.approval.open').count() === 0)
    await until('late reply', async () => existsSync(pending) && readFileSync(pending, 'utf8').length > 0, 10_000)
    await sleep(500)
    check('CROSS-05 Stop while the approval waits: the card closes and nothing is clicked', closed && await text(app, `${SHOP}/`, 'count') === '0', `${await text(app, `${SHOP}/`, 'count')}`)
    check('CROSS-05 the cut-off call got a refusal, not a result', existsSync(pending) && readFileSync(pending, 'utf8').includes('"error"'), existsSync(pending) ? readFileSync(pending, 'utf8').slice(0, 120) : 'no reply')

    // ---------- SEC-02 / SEC-03 from the agent's side ----------
    const run4 = runIn(page)
    await run4.start()
    for (const url of ['file:///etc/hosts', 'javascript:alert(1)', `http://127.0.0.1:${cockpitPort}/`, `http://localhost:${cockpitPort}/api/threads`, 'chrome://gpu']) {
      r = await run4.call('navigate', { url })
      check(`SEC-02 the agent cannot open ${url.slice(0, 40)}`, r.code === 400, String(r.code))
    }
    r = await run4.call('navigate', { url: `${LOCAL}/to-cockpit` })
    check('SEC-02 a local page that redirects to Cockpit does not land there', r.code === 200 && !String(r.body.data?.url ?? '').includes(`:${cockpitPort}`), String(r.body.data?.url))
    r = await run4.call('navigate', { url: `${LOCAL}/sw-page` })
    check('SEC-02 a service worker’s own request to Cockpit is blocked, and it says so', await until('sw report', async () => swResults.length > 0), swResults.join(','))
    check('SEC-02 (the worker reported blocked, not reached)', swResults.every((x) => x === 'blocked'), swResults.join(','))
    await run4.call('navigate', { url: `${SHOP}/` }, grant)
    const shopView = (await viewAt(app, `${SHOP}/`))!
    const rebound = await inPage<string>(app, shopView.id, `Promise.all([
      fetch('http://shop.test:${cockpitPort}/api/threads').then(() => 'read', () => 'refused'),
      fetch('http://127.0.0.1:${cockpitPort}/api/threads', { mode: 'no-cors' }).then(() => 'reached', () => 'blocked'),
      fetch('http://127.0.0.1:${cockpitPort}/api/threads', { headers: { 'x-cockpit-window': 'forged', origin: 'http://127.0.0.1:${cockpitPort}' } }).then(() => 'read', () => 'refused'),
    ]).then((r) => r.join(','))`)
    check('SEC-01/02 a remote page gets nothing from Cockpit: by another name, plainly, or with forged headers', rebound === 'refused,blocked,refused', rebound)
    for (const op of ['toString', 'constructor', '..%2F..%2Fthreads']) {
      const status = await directCall(op, {})
      check(`SEC-03 the browser route knows only its own operations (${op})`, status === 404, String(status))
    }
    const [mcpUrl, token] = readFileSync(`${argsLog}.token`, 'utf8').trim().split(' ')
    const control = await fetch(`${mcpUrl}/api/threads`, { headers: { authorization: `Bearer ${token}` } })
    check('SEC-01 the agent’s token does not open the control API', control.status === 403, String(control.status))
    await run4.end()

    // ---------- W9-11: legacy open_preview / inspect_preview on the conversation's own page ----------
    await converse(page, `open ${LOCAL}/c`)
    await until('page c', async () => (await viewAt(app, `${LOCAL}/c`))?.visible === true)
    await sleep(600)
    check('W9-11 open_preview loads the conversation’s page once (not twice)', hits['/c'] === 1, String(hits['/c']))
    const cId = await threadId(page, `open ${LOCAL}/c`)
    await app.evaluate(({ BrowserWindow }) => {
      const g = globalThis as { __maxWindows?: number; __watch?: ReturnType<typeof setInterval> }
      g.__maxWindows = BrowserWindow.getAllWindows().length
      g.__watch = setInterval(() => { g.__maxWindows = Math.max(g.__maxWindows ?? 0, BrowserWindow.getAllWindows().length) }, 10)
    })
    const shotFile = join(root, 'inspect')
    await say(page, `inspect ${LOCAL}/c ${shotFile}`)
    await until('inspect done', async () => existsSync(`${shotFile}.code`), 20_000)
    const maxWindows = await app.evaluate(() => { const g = globalThis as { __maxWindows?: number; __watch?: ReturnType<typeof setInterval> }; clearInterval(g.__watch); return g.__maxWindows })
    const inspected = JSON.parse(readFileSync(`${shotFile}.out`, 'utf8')).data as { page?: { pageId: string; url: string }; width: number; height: number; data: string }
    const viewC = await viewAt(app, `${LOCAL}/c`)
    check('W9-11 inspect_preview keeps its contract (PNG, size, address)', readFileSync(`${shotFile}.code`, 'utf8') === '200' && Buffer.from(inspected.data, 'base64').subarray(1, 4).toString() === 'PNG')
    check('W9-11 and captures exactly the conversation’s own page', inspected.page?.pageId === `thread:${cId}` && inspected.width === viewC?.bounds.width && inspected.height === viewC?.bounds.height, `${inspected.width}×${inspected.height} ${JSON.stringify(viewC?.bounds)}`)
    check('W9-11 without the separate capture window', maxWindows === 1, String(maxWindows))
    check('W9-11 nor a second load of the page', hits['/c'] === 1, String(hits['/c']))
    const remoteFile = join(root, 'inspect-remote')
    await say(page, `inspect ${SHOP}/ ${remoteFile}`)
    await until('inspect remote', async () => existsSync(`${remoteFile}.code`), 20_000)
    check('W9-11 a remote address cannot use the local-only tools', readFileSync(`${remoteFile}.code`, 'utf8') === '400')

    // ---------- W9-12: Use my Chrome ----------
    await converse(page, 'chrome D')
    await page.locator('.bubble.agent').getByText('OK.').first().waitFor()
    await page.getByRole('button', { name: 'Agent settings' }).click()
    const panel = page.getByRole('dialog', { name: 'Agent settings' })
    check('W9-12 the setting says Claude Code supports it and the extension helper is there, without a turn', await until('readiness', () => panel.getByText('the Claude extension’s helper is installed', { exact: false }).isVisible()))
    await panel.getByRole('checkbox', { name: 'Use my Chrome' }).check()
    await shot(app, page, 'chrome-setting-light')
    await panel.getByRole('button', { name: 'Apply' }).click()
    check('W9-12 turning it on is recorded and applies from the next message', await until('note', () => page.getByText('using your Chrome. Applies from your next message.', { exact: false }).isVisible()))
    const launches = () => readFileSync(argsLog, 'utf8').split('-----\n').filter(Boolean)
    // First call of a fresh session: Chrome is not there.
    await say(page, 'chrome off')
    check('W9-12 unavailable: says the extension is not connected', await until('off', () => page.getByText('Could not reach your Chrome. Browser extension is not connected', { exact: false }).isVisible()))
    const last = launches().at(-1) ?? ''
    check('W9-12 the launch adds --chrome and keeps strict MCP wiring', last.includes('--chrome\n') && last.includes('--strict-mcp-config\n'), last.split('\n').filter((a) => a.startsWith('--')).join(' '))
    await say(page, 'chrome ok')
    check('W9-12 Connecting shows while Chrome has not answered', await until('connecting', () => page.locator('.chrome-connecting').isVisible(), 5000))
    check('W9-12 connected', await until('connected', () => page.getByText('Connected to your Chrome.').isVisible()))
    await say(page, 'chrome drop')
    check('W9-12 disconnected is reported', await until('drop', () => page.getByText('Your Chrome disconnected.', { exact: false }).isVisible()))
    await say(page, 'chrome hang')
    await page.locator('.chrome-connecting').waitFor()
    await page.getByRole('button', { name: 'Agent settings' }).click()
    await panel.getByRole('checkbox', { name: 'Use my Chrome' }).uncheck()
    check('W9-12 the setting cannot change mid-turn (idle boundary)', await panel.getByRole('button', { name: 'Apply' }).isDisabled() && await panel.getByText('Stop the current turn', { exact: false }).isVisible())
    await page.keyboard.press('Escape')
    await messageBox(page).fill('my draft stays')
    await shot(app, page, 'chrome-connecting-light')
    await page.locator('.chrome-connecting').getByRole('button', { name: 'Cancel' }).click()
    check('W9-12 Cancel stops waiting at once', await until('cancelled', () => page.getByText('Stopped while connecting to your Chrome.').isVisible(), 5000))
    check('W9-12 the draft is kept', await messageBox(page).inputValue() === 'my draft stays')
    await say(page, 'chrome hang')
    const hungAt = Date.now()
    const failed = await until('timeout', () => page.getByText('Chrome did not answer within 30 seconds', { exact: false }).isVisible(), 40_000)
    check('W9-12 no answer: fails after 30 s with what to check, once', failed && Date.now() - hungAt >= 29_000 && Date.now() - hungAt < 40_000, `${Math.round((Date.now() - hungAt) / 1000)} s`)
    check('W9-12 and the turn is stopped, not left working', await until('not working', async () => !(await page.getByRole('button', { name: 'Stop', exact: true }).isVisible())))
    await page.getByRole('button', { name: 'Agent settings' }).click()
    await panel.getByRole('checkbox', { name: 'Use my Chrome' }).uncheck()
    await panel.getByRole('button', { name: 'Apply' }).click()
    const before = launches().length
    await say(page, 'after')
    await until('relaunch', async () => launches().length > before)
    check('W9-12 turning it off applies at the next launch', launches().length > before && !(launches().at(-1) ?? '').includes('--chrome\n'))

    // ---------- dark and narrow: the new controls stay usable ----------
    await setTheme(page, 'Dark')
    await page.setViewportSize({ width: 980, height: 640 }).catch(() => undefined)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(980, 640))
    await card(page, 'agent A').click()
    const run5 = runIn(page)
    await run5.start()
    await run5.call('navigate', { url: `${SHOP}/` }, async (approval) => {
      await shot(app, page, 'approval-dark-980')
      check('W9-06 at 980×640 (dark) the grant button is inside the window', await insideWindow(page, grantButton(approval)))
      await allow(approval)
    })
    await run5.end()
    await card(page, 'chrome D').click()
    await page.getByRole('button', { name: 'Agent settings' }).click()
    await shot(app, page, 'chrome-setting-dark-980')
    check('W9-12 at 980×640 (dark) Use my Chrome is inside the window', await insideWindow(page, panel.getByRole('checkbox', { name: 'Use my Chrome' })))
    await page.keyboard.press('Escape')
  } catch (err) {
    check('proof ran to the end (agent tools)', false, err instanceof Error ? err.message.split('\n')[0] : String(err))
    await shot(app, page, 'failure').catch(() => undefined)
  }
  const chromeBefore = execFileSync('sh', ['-c', 'pgrep -x "Google Chrome" | wc -l'], { encoding: 'utf8' }).trim()
  await app.close()
  const chromeAfter = execFileSync('sh', ['-c', 'pgrep -x "Google Chrome" | wc -l'], { encoding: 'utf8' }).trim()
  check('W9-12 Quit leaves the person’s Chrome as it was', chromeBefore === chromeAfter, `${chromeBefore} → ${chromeAfter}`)

  // ======================= launch 4: residency (proof limits: idle 3 s, 3 pages) =======================
  // Its own state folder: nothing from the first launch on the start screen.
  ;({ app, page } = await launch({ COCKPIT_HOME: join(root, 'state-residency'), COCKPIT_PROOF_BROWSER_IDLE_MS: '3000', COCKPIT_PROOF_BROWSER_MAX: '3', COCKPIT_CHROME_NATIVE_HOSTS: noHosts }))
  try {
    await openProject(page, one, 'One')
    await setTheme(page, 'Light')
    await page.getByRole('button', { name: 'Agent settings' }).click()
    check('W9-12 without the extension helper, the setting says it is not set up', await until('not set up', () => page.getByRole('dialog', { name: 'Agent settings' }).getByText('not set up on this Mac', { exact: false }).isVisible()))
    await page.keyboard.press('Escape')
    // An idle page the person left is unloaded after the idle time.
    await converse(page, `open ${LOCAL}/x`)
    await until('x', async () => (await viewAt(app, `${LOCAL}/x`))?.visible === true)
    await converse(page, `open ${LOCAL}/p2`)
    await until('p2', async () => (await viewAt(app, `${LOCAL}/p2`))?.visible === true)
    check('W9-10 an idle page is unloaded after the idle time', await until('x unloaded', async () => !(await viewAt(app, `${LOCAL}/x`)), 10_000))
    const typeInto = async (url: string) => inPage(app, (await viewAt(app, url))!.id, `document.getElementById('who').value = 'unsaved words'; 1`)
    await typeInto(`${LOCAL}/p2`)
    // p1 is held by an agent run's grant, p2 and p3 hold unsaved typing, p3 is shown.
    await converse(page, 'p1 agent')
    await page.locator('.bubble.agent').getByText('OK.').first().waitFor()
    const p1 = runIn(page)
    await p1.start()
    await p1.call('navigate', { url: `${LOCAL}/p1` })
    const p1read = await p1.call('read')
    await p1.call('click', { revision: p1read.body.data?.page?.revision, ref: refFor(p1read, 'Add one') }, grant)
    await converse(page, `open ${LOCAL}/p3`)
    await until('p3', async () => (await viewAt(app, `${LOCAL}/p3`))?.visible === true)
    await typeInto(`${LOCAL}/p3`)
    await sleep(4500)
    check('W9-10 the shown page stays loaded', (await viewAt(app, `${LOCAL}/p3`))?.visible === true)
    check('W9-10 a page with unsaved typing stays loaded', Boolean(await viewAt(app, `${LOCAL}/p2`)))
    check('W9-10 the page an agent run holds stays loaded (no active-page theft)', Boolean(await viewAt(app, `${LOCAL}/p1`)))
    // All three in use: a fourth page explains instead of taking one.
    await converse(page, `links ${LOCAL}/p4 ${SHOP}/`)
    await page.locator('.transcript').getByRole('link', { name: 'the app' }).click()
    const list = page.locator('.browser-capacity')
    check('W9-10 when every page is in use, opening another explains and lists them', await until('capacity', () => list.isVisible()) && await list.locator('li').count() === 3)
    check('W9-10 a page with unsaved typing warns before it is closed; the agent’s page does not claim typing', await list.locator('li', { hasText: 'Controlled app p2' }).getByRole('button', { name: 'Discard typing and close' }).isVisible()
      && await list.locator('li', { hasText: 'Controlled app p1' }).getByRole('button', { name: 'Close page' }).isVisible())
    await shot(app, page, 'capacity-light')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(980, 640))
    await sleep(300)
    check('W9-10 at 980×640 the capacity list’s buttons are inside the window', await insideWindow(page, list.getByRole('button').last()))
    await list.locator('li', { hasText: 'Controlled app p3' }).getByRole('button', { name: 'Discard typing and close' }).click()
    check('W9-10 closing one makes room and the new page opens', await until('p4 open', async () => (await viewAt(app, `${LOCAL}/p4`))?.visible === true))
    // Back to a wide window: below 1100 px the page you just opened takes the view (Workspace / Preview tabs).
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1360, 860))
    await sleep(300)
    // The run ends: p1 is idle now, is unloaded, and comes back visibly reloaded.
    await card(page, 'p1 agent').click()
    await p1.end()
    await card(page, `open ${LOCAL}/p2`).click()
    check('W9-10 once its run ended, the agent’s page is unloaded when idle', await until('p1 unloaded', async () => !(await viewAt(app, `${LOCAL}/p1`)), 12_000))
    await card(page, 'p1 agent').click()
    const noted = await until('reloaded note', () => page.getByText('Reloaded: Cockpit unloaded this page while it was idle', { exact: false }).isVisible(), 12_000)
    check('W9-10 reopening it reloads it visibly and says typing was not kept', noted && await until('p1 back', async () => (await viewAt(app, `${LOCAL}/p1`))?.visible === true))
    await shot(app, page, 'reloaded-light')
    // Deleting a conversation closes its page.
    const p2Id = await threadId(page, `open ${LOCAL}/p2`)
    check('W9-10 (the page to delete is loaded)', Boolean(await viewAt(app, `${LOCAL}/p2`)))
    await page.evaluate(async (id) => { await fetch(`/api/threads/${id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' } }) }, p2Id)
    check('W9-10 deleting a conversation closes its page', await until('p2 gone', async () => !(await viewAt(app, `${LOCAL}/p2`))))
  } catch (err) {
    check('proof ran to the end (residency)', false, err instanceof Error ? err.message.split('\n')[0] : String(err))
    await shot(app, page, 'failure-residency').catch(() => undefined)
  } finally {
    await app.close()
    site.close()
  }
}
