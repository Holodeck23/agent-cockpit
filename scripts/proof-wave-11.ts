// Packaged gate for wave 11 (order 14, H5 phone live preview): W11-01–W11-07, SEC-04–SEC-06 and the
// automatable half of CROSS-07, on the PACKAGED app with a phone-sized Chrome. W11-08 (the real
// Pixel over the real tailnet) is order 15 and is not claimed here.
//
// Nothing here touches this Mac's real Tailscale. The app runs a stand-in `tailscale` CLI
// (scripts/fixtures/wave11-tailscale, found first through COCKPIT_AGENT_PATH) whose Serve table a
// loopback HTTPS proxy plays (scripts/lib/fake-serve.ts), with the tailnet name resolved to
// 127.0.0.1 in the phone's Chrome. The real `tailscale serve status` is read before and after and
// must be unchanged. A stand-in agent (scripts/fixtures/wave11-agent) starts the two fixture apps
// through Cockpit's MCP API, behind its approval cards: A is a real Vite 8 dev server with HMR and
// server sessions (scripts/fixtures/wave11-apps/a), B a plain Node app (b.mjs).
//
// Usage: npm run package:proof, wait a minute (XProtect scans fresh binaries), then
//   COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:wave-11
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { connect, createServer as netServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, devices, type Browser, type BrowserContext, type ElectronApplication, type Page, type WebSocket } from 'playwright-core'
import { startFakeServe } from './lib/fake-serve.ts'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { apiPost, headStatus, openProject, setTheme, startConversation } from './lib/ui.ts'

const { check, finish } = checker()
const HOST = 'proof-mac.tail-proof.ts.net'
const LOGIN = 'proof@example.com'
const CONTROL_HTTPS = 10000
const CONTROL = `https://${HOST}:${CONTROL_HTTPS}`
const ORIGIN_A = `https://${HOST}:8443`
const ORIGIN_B = `https://${HOST}:8444`
const FIX = join(ROOT, 'scripts/fixtures')
const PROMPT = 'Start the garden site apps'

const root = mkdtempSync(join(tmpdir(), 'cockpit-wave11-proof-'))
const state = join(root, 'state'), project = join(root, 'garden-site'), ts = join(root, 'tailscale'), bystander = join(root, 'bystander')
for (const dir of [state, project, ts, bystander]) mkdirSync(dir, { recursive: true })
cpSync(join(FIX, 'wave11-apps/a'), project, { recursive: true })
cpSync(join(FIX, 'wave11-apps/b.mjs'), join(project, 'b.mjs'))
writeFileSync(join(project, '.wave11-processes'), [
  `site|${process.execPath} ${join(ROOT, 'node_modules/vite/bin/vite.js')} --config vite.config.mjs`,
  `admin|${process.execPath} b.mjs`,
].join('\n') + '\n')
writeFileSync(join(bystander, 'UNRELATED-APP.txt'), 'an unrelated program on the same port\n')
mkdirSync(PROOF_DIR, { recursive: true })

// ---------- helpers ----------
async function freePort(): Promise<number> {
  const probe = netServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}
const portOpen = (port: number): Promise<boolean> => new Promise((resolve) => {
  const socket = connect(port, '127.0.0.1', () => { socket.destroy(); resolve(true) })
  socket.on('error', () => resolve(false))
})
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
const calls = (): string[] => readFileSync(join(ts, 'calls.log'), 'utf8').split('\n').filter(Boolean)
const changes = (): string[] => calls().filter((c) => !c.startsWith('status') && !c.startsWith('serve status'))
/** page.evaluate has no timeout: a call that never answers is named, not waited on forever. */
const bounded = <T>(what: string, work: Promise<T>, ms = 10_000): Promise<T> =>
  Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} did not answer in ${ms} ms`)), ms))])
const getJson = <T>(page: Page, path: string): Promise<T> =>
  bounded(`GET ${path}`, page.evaluate(async (p) => ((await (await fetch(p)).json()) as { data: unknown }).data, path) as Promise<T>)
const step = (label: string): void => console.log(`  · ${label}`)
interface Proc { id: string; name: string; status: string; url?: string; projectPath: string; pid?: number }
const procs = async (page: Page): Promise<Proc[]> => (await getJson<Proc[]>(page, '/api/processes')).filter((p) => p.projectPath === project)
const shot = (page: Page, name: string) => page.screenshot({ path: join(PROOF_DIR, `wave11-${name}.png`) })
/** A phone layout that spills past the screen stretches innerWidth with it; compare with the screen (recipe 2026-09-29). */
const fits = (page: Page) => page.evaluate(() => window.innerWidth <= screen.width && document.documentElement.scrollWidth <= screen.width
  && [...document.querySelectorAll<HTMLElement>('.menu, .phone-apps-state, .process-row, .thread-head')].filter((el) => el.offsetParent !== null)
    .every((el) => el.getBoundingClientRect().right <= window.innerWidth + 1))
/** Opens the Phone access panel unless it is open already (a second click would close it). */
async function phonePanel(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: 'Phone access', exact: true })
  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click()
  await page.locator('.phone-menu').waitFor()
}
/** The stand-in Serve's self-signed certificate makes Chrome refuse the service worker; its toast is not under test. */
async function dismissToasts(phone: Page): Promise<void> {
  for (const button of await phone.getByRole('button', { name: 'Dismiss' }).all()) await button.click({ timeout: 1000 }).catch(() => undefined)
}
/** Opens the phone's apps menu unless it is open already. */
async function appsMenu(phone: Page): Promise<void> {
  if (!(await phone.locator('.phone-apps-menu').isVisible())) await phone.locator('.phone-apps .process-chip').click()
  await phone.locator('.phone-apps-menu').waitFor()
}
/** A row whose name is exactly `name` (the project folder, garden-site, contains "site"). */
const row = (scope: Page | import('playwright-core').Locator, rowClass: string, nameClass: string, name: string) =>
  scope.locator(rowClass).filter({ has: ("page" in scope ? scope.page() : scope).locator(nameClass, { hasText: new RegExp(`^${name}$`) }) })
const realServe = (): Promise<string> => new Promise((resolve) => {
  // The real CLI, from the normal PATH: read-only `serve status`, with a timeout (the CLI can hang).
  execFile('/bin/sh', ['-lc', 'command -v tailscale >/dev/null && tailscale serve status --json || echo "(no tailscale CLI)"'],
    { timeout: 15_000 }, (error, stdout) => resolve(error ? `(unavailable: ${error.message.split('\n')[0]})` : stdout.trim()))
})

const before = await realServe()
for (const port of [47822, 47823]) {
  if (await portOpen(port)) { console.log(`Port ${port} (a phone-preview listener) is already in use on this Mac; close what holds it, then rerun.`); process.exit(1) }
}
const phonePort = await freePort()
writeFileSync(join(state, 'remote.json'), JSON.stringify({ port: phonePort, httpsPort: CONTROL_HTTPS }))
execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${HOST}`,
  '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem')], { stdio: 'ignore' })
writeFileSync(join(ts, 'calls.log'), '')
const serve = startFakeServe({ dir: ts, login: LOGIN, cert: readFileSync(join(root, 'cert.pem'), 'utf8'), key: readFileSync(join(root, 'key.pem'), 'utf8') })

let app: ElectronApplication | undefined
let phoneBrowser: Browser | undefined
let squatter: ChildProcess | undefined
try {
  app = await launchPackagedApp({
    COCKPIT_HOME: state,
    COCKPIT_AGENT_PATH: `${join(FIX, 'wave11-agent')}:${join(FIX, 'wave11-tailscale')}`,
    COCKPIT_PROOF_TAILSCALE: ts, COCKPIT_PROOF_TAILNET_HOST: HOST, COCKPIT_PROOF_TAILNET_LOGIN: LOGIN,
    COCKPIT_PROOF_PREVIEW_FIRST_BYTE_MS: '3000',
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await openProject(page, project, 'Garden site')

  // ---------- 1. Two apps started the way an agent starts them ----------
  await startConversation(page, PROMPT)
  for (let i = 0; i < 2; i += 1) {
    const approval = page.locator('.approval.open')
    await approval.waitFor({ timeout: 30_000 })
    await approval.getByRole('button', { name: 'Allow', exact: true }).click()
    await approval.waitFor({ state: 'detached' }).catch(() => undefined)
  }
  await headStatus(page).filter({ hasText: 'Ready' }).waitFor({ timeout: 30_000 })
  const running = await until('both apps running with an address', async () => {
    const list = (await procs(page)).filter((p) => p.status === 'running' && p.url)
    return list.length === 2 ? list : undefined
  }, 40_000)
  const site = running?.find((p) => p.name === 'site'), admin = running?.find((p) => p.name === 'admin')
  check('1 the agent started both apps through Cockpit, each behind an approval', Boolean(site?.url && admin?.url), running?.map((p) => `${p.name} ${p.url}`).join(', '))
  if (!site || !admin) throw new Error('fixture apps did not start')

  // ---------- 2. Phone access on (control origin through the stand-in Serve) ----------
  await phonePanel(page)
  await page.getByRole('button', { name: 'Turn on phone access' }).click()
  await page.locator('.phone-qr').waitFor()
  check('2 turning phone access on ran only the control entry', changes().join(' | ') === `serve --bg --https=${CONTROL_HTTPS} http://127.0.0.1:${phonePort}`, changes().join(' | '))
  await until('the stand-in Serve to listen', async () => serve.ports().includes(CONTROL_HTTPS))

  phoneBrowser = await chromium.launch({ channel: 'chrome', args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] })
  const context: BrowserContext = await phoneBrowser.newContext({ ...devices['Pixel 9'], ignoreHTTPSErrors: true })
  const phone = await context.newPage()
  phone.setDefaultTimeout(20_000)
  await phone.goto(`${CONTROL}/`)
  await phone.getByRole('heading', { name: 'Connect this phone to Cockpit' }).waitFor()
  await phone.getByRole('button', { name: 'Ask my Mac' }).click()
  await page.locator('.phone-menu .pairing-row').getByRole('button', { name: 'Allow' }).click()
  await phone.getByRole('heading', { name: 'Conversations' }).waitFor()
  check('2 the phone pairs through the control origin', true)
  const pageHeaders = await phone.evaluate(async () => {
    const r = await fetch('/'); return { csp: r.headers.get('content-security-policy') ?? '', frame: r.headers.get('x-frame-options') ?? '' }
  })
  check('SEC-04 the phone page may post forms only to itself and the preview origins, and cannot be framed',
    pageHeaders.csp.includes(`form-action 'self' ${ORIGIN_A} ${ORIGIN_B}`) && pageHeaders.csp.includes("frame-ancestors 'none'") && pageHeaders.frame === 'DENY',
    pageHeaders.csp.match(/form-action[^;]*/)?.[0]?.slice(0, 80))

  // ---------- 3. Enable phone previews on the Mac: shown first, run on click ----------
  const panel = page.getByRole('region', { name: 'Enable phone previews' })
  await panel.waitFor()
  const before3 = changes().length
  const setUp = async (name: string, https: number, listen: number): Promise<void> => {
    await row(panel, '.device-row', '.device-name', name).getByRole('button', { name: 'Set up for phone' }).click()
    const previewRow = row(panel, '.preview-row', '.device-name', name)
    const command = (await previewRow.locator('.preview-command').textContent())?.trim()
    check(`3 ${name}: the exact Serve command is shown before anything runs`, command === `tailscale serve --bg --https=${https} http://127.0.0.1:${listen}` && changes().length === before3 + (name === 'admin' ? 1 : 0), command)
    if (name === 'site') await shot(page, 'desktop-enable-previews')
    await previewRow.getByRole('button', { name: 'Run this command' }).click()
    await previewRow.locator('.preview-on').waitFor()
    check(`3 ${name}: clicking runs exactly that command`, changes().at(-1) === `serve --bg --https=${https} http://127.0.0.1:${listen}`, changes().at(-1))
  }
  await setUp('site', 8443, 47822)
  await setUp('admin', 8444, 47823)
  check('W11-07 the panel names what may not work on the phone (hard-coded localhost and more)', /hard-coded localhost addresses/.test(await panel.innerText()))
  await shot(page, 'desktop-previews-on')
  await setTheme(page, 'Dark')
  await phonePanel(page)
  await panel.waitFor()
  await shot(page, 'desktop-previews-on-dark')
  await setTheme(page, 'Light')
  await phonePanel(page)
  await until('the stand-in Serve to listen on both previews', async () => serve.ports().includes(8443) && serve.ports().includes(8444))

  // ---------- 4. View app A on the phone (W11-01, W11-03, SEC-05) ----------
  await dismissToasts(phone)
  await phone.getByText(PROMPT).first().click()
  await dismissToasts(phone)
  const chip = phone.getByRole('button', { name: '2 apps to view' })
  await chip.waitFor()
  await chip.click()
  check('4 the phone lists the running apps, and the menu fits the screen', await phone.getByRole('button', { name: 'View app' }).count() === 2 && await fits(phone))
  await shot(phone, 'phone-apps')
  const sockets: WebSocket[] = []
  // Which tab each socket belongs to, and whether it ever got a frame (a refused handshake never does).
  const owner = new Map<WebSocket, Page>(), live = new Set<WebSocket>()
  context.on('page', (p) => p.on('websocket', (ws) => {
    sockets.push(ws); owner.set(ws, p)
    ws.on('framereceived', () => live.add(ws)); ws.on('close', () => live.delete(ws))
  }))
  /** Taps View app and returns the tab the app opened in (a new one, or the one already named for it). */
  async function viewApp(name: string, origin: string): Promise<{ tab: Page; how: string } | undefined> {
    await appsMenu(phone)
    const known = new Set(context.pages())
    const navigated = new Promise<Page>((resolve) => { for (const p of known) if (p !== phone) p.once('framenavigated', (f) => { if (f === p.mainFrame() && f.url().startsWith(origin)) resolve(p) }) })
    const opened = context.waitForEvent('page', { timeout: 15_000 })
    await row(phone, '.process-row', '.process-name', name).getByRole('button', { name: 'View app' }).click()
    const tab = await Promise.race([opened.then((p) => ({ tab: p, how: 'new tab' })), navigated.then((p) => ({ tab: p, how: 'same tab' }))]).catch(() => undefined)
    if (!tab) return undefined
    // Past the bootstrap (303 to /) onto the app; a refused ticket stays on the bootstrap's own page.
    const through = await tab.tab.waitForURL((u) => u.origin === origin && !u.pathname.startsWith('/__cockpit/'), { timeout: 15_000 }).then(() => true, () => false)
    if (!through) console.log(`  (${name} stayed on ${tab.tab.url()}: ${(await tab.tab.locator('body').innerText().catch(() => '')).slice(0, 160)})`)
    await tab.tab.waitForLoadState('load')
    return tab
  }
  const a1 = await viewApp('site', ORIGIN_A)
  if (!a1) throw new Error('View app did not open app A')
  const tabA = a1.tab
  check('W11-01 View app opens A on its own HTTPS origin; the control page stays on the control origin',
    new URL(tabA.url()).origin === ORIGIN_A && new URL(phone.url()).origin === CONTROL, `${tabA.url()} (${a1.how})`)
  await tabA.getByRole('heading', { name: 'Service A' }).waitFor()
  check('W11-03 root-relative assets and modules load (/src/main.js ran)', (await tabA.locator('#msg').textContent()) === 'Hello from A (version 1)')
  check('W11-01 the control origin never serves the app\'s files', !(await phone.evaluate(async () => (await (await fetch('/src/main.js')).text()).includes("from './msg.js'"))))
  await tabA.getByRole('button', { name: 'Log in to the app' }).click()
  await tabA.getByText('logged in, count 0').waitFor()
  await tabA.getByRole('button', { name: '+1 (server counter)' }).click()
  await tabA.getByText('logged in, count 1').waitFor()
  check('W11-03 form POSTs and a server-session (HttpOnly) sign-in work through the cookie jar', true)
  await until('SSE ticks', async () => Number(await tabA.locator('#sse').textContent()) >= 2, 8000)
  check('W11-03 server-sent events stream', Number(await tabA.locator('#sse').textContent()) >= 2)
  const echo = await tabA.evaluate(async () => ((await (await fetch('/echo')).json()) as { headers: Record<string, string> }).headers)
  const leaked = Object.keys(echo).filter((h) => h.startsWith('tailscale-') || h.startsWith('x-forwarded-') || h === 'authorization')
  check('SEC-05 the dev server gets no Cockpit cookie, Tailscale or forwarding header, and its own Host',
    leaked.length === 0 && !(echo.cookie ?? '').includes('cockpit_') && /^app_sid=/.test(echo.cookie ?? '') && echo.host === new URL(site.url!).host,
    `host ${echo.host}; cookie ${(echo.cookie ?? '').replace(/=[^;]+/g, '=…')}; leaked ${leaked.join(',') || 'none'}`)
  await tabA.goto(`${ORIGIN_A}/redirect-abs`)
  check('W11-03 an absolute redirect to the dev server stays on the preview origin', tabA.url() === `${ORIGIN_A}/landed`, tabA.url())
  await tabA.goto(`${ORIGIN_A}/deep/link`)
  check('W11-03 an SPA deep link serves the app', await tabA.getByRole('heading', { name: 'Service A' }).isVisible(), tabA.url())
  await tabA.goto(`${ORIGIN_A}/`)
  await tabA.getByText('logged in, count 1').waitFor()
  const hmr = await until('the HMR socket', async () => sockets.find((ws) => ws.url().startsWith(ORIGIN_A.replace('https', 'wss')) && !ws.isClosed()), 10_000)
  await tabA.evaluate(() => { (window as unknown as { proofMarker: string }).proofMarker = 'kept' })
  writeFileSync(join(project, 'src/msg.js'), "export const msg = 'Hello from A (version 2, edited on the Mac)'\n")
  const updated = await until('the HMR update', async () => (await tabA.locator('#msg').textContent()) === 'Hello from A (version 2, edited on the Mac)', 15_000)
  const kept = await tabA.evaluate(() => (window as unknown as { proofMarker?: string }).proofMarker)
  check('W11-03 HMR: an edit on the Mac updates the page without a reload', Boolean(hmr) && Boolean(updated) && kept === 'kept',
    `socket ${hmr ? new URL(hmr.url()).pathname + (new URL(hmr.url()).searchParams.has('token') ? ' (Vite token passed through)' : '') : 'none'}`)
  await shot(tabA, 'phone-app-a')

  // ---------- 5. B after A: separate origins, no reach across (W11-04, SEC-04) ----------
  await phone.bringToFront()
  const b1 = await viewApp('admin', ORIGIN_B)
  if (!b1) throw new Error('View app did not open app B')
  const tabB = b1.tab
  await tabB.getByRole('heading', { name: 'Service B' }).waitFor()
  check('W11-04 B opens on its own origin, and A\'s tab still shows A', new URL(tabB.url()).origin === ORIGIN_B && tabB !== tabA
    && (await tabA.reload().then(() => tabA.getByRole('heading', { name: 'Service A' }).isVisible())), `${tabB.url()} (${b1.how})`)
  await tabA.getByRole('button', { name: '+1 (server counter)' }).click()
  check('W11-04 A\'s own form still acts on A only', await tabA.getByText('logged in, count 2').isVisible().catch(() => false) || Boolean(await until('count 2', async () => tabA.getByText('logged in, count 2').isVisible())))
  await tabA.evaluate((target) => {
    const form = document.createElement('form'); form.method = 'POST'; form.action = target; document.body.append(form); form.submit()
  }, `${ORIGIN_B}/poke`)
  await tabA.waitForURL(`${ORIGIN_B}/poke`)
  const blockedText = await tabA.locator('body').innerText()
  const pokes = await tabB.evaluate(async () => ((await (await fetch('/echo')).json()) as { pokes: number }).pokes)
  check('W11-04 a form on A\'s origin posting to B is blocked and never reaches B', /Blocked/.test(blockedText) && pokes === 0, `pokes ${pokes}`)
  // A plain string: tsx would inject its __name helper into a named inner function, and the page has none.
  const reach = await tabA.evaluate(`(async () => {
    const attempt = (url, init) => fetch(url, Object.assign({ credentials: 'include' }, init)).then((r) => 'read ' + r.status, () => 'blocked')
    return { b: await attempt('${ORIGIN_B}/echo'), threads: await attempt('${CONTROL}/api/threads'),
      write: await attempt('${CONTROL}/api/threads/x/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"x"}' }) }
  })()`) as { b: string; threads: string; write: string }
  check('SEC-04 a preview page can read neither B nor the control API, nor write to it', reach.b === 'blocked' && reach.threads === 'blocked' && reach.write === 'blocked', JSON.stringify(reach))
  await tabA.goto(`${ORIGIN_A}/`)

  // ---------- 6. Bounded failures (W11-07) ----------
  const slowStarted = Date.now()
  const slowTask = tabA.evaluate(async () => { const r = await fetch('/slow'); return { status: r.status, text: await r.text() } })
  await new Promise((r) => setTimeout(r, 500))
  const controlStarted = Date.now()
  const me = await phone.evaluate(async () => (await fetch('/api/remote/me')).status)
  const controlMs = Date.now() - controlStarted
  const slow = await slowTask
  check('W11-07 a dev server that never answers gets a bounded "did not answer" page; the control API stays responsive',
    slow.status === 504 && /did not answer/.test(slow.text) && me === 200 && controlMs < 1500, `504 after ${Date.now() - slowStarted} ms; control answered in ${controlMs} ms`)
  const big = await tabA.evaluate(async () => (await fetch('/inc', { method: 'POST', body: new Uint8Array(11 * 1024 * 1024) })).status)
  check('W11-07 a request body over 10 MiB gets 413', big === 413, String(big))
  const bigHeader = await tabA.evaluate(async () => { try { return (await fetch('/', { headers: { 'x-big': 'a'.repeat(40 * 1024) } })).status } catch { return 0 } })
  check('W11-07 request headers over 32 KiB are refused by the preview (431)', bigHeader === 431, String(bigHeader))

  // ---------- 7. Stop B, put an unrelated program on its port (W11-05, SEC-06) ----------
  const bPort = Number(new URL(admin.url!).port)
  await apiPost(page, `/api/processes/${admin.id}/stop`, {})
  await until('B to stop', async () => (await procs(page)).find((p) => p.id === admin.id)?.status === 'exited')
  const stoppedResponse = await tabB.reload()
  check('W11-05 the stopped app shows "not running" with the way back, and no app content',
    stoppedResponse?.headers()['x-cockpit-preview'] === 'stopped' && await tabB.getByRole('link', { name: 'Back to Cockpit' }).getAttribute('href') === `${CONTROL}/`)
  await shot(tabB, 'phone-state-stopped')
  squatter = spawn('/usr/bin/python3', ['-m', 'http.server', String(bPort), '--bind', '127.0.0.1'], { cwd: bystander, stdio: 'ignore' })
  await until('the unrelated program to listen', () => portOpen(bPort))
  const squatted = await tabB.reload()
  const squattedText = await tabB.locator('body').innerText()
  check('W11-05 an unrelated program on the old port is never reached', squatted?.headers()['x-cockpit-preview'] === 'stopped' && !/UNRELATED|Directory listing/.test(squattedText))
  const bTicket = await phone.evaluate(async (id) => (await fetch('/api/phone/preview-tickets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ processId: id }) })).json(), admin.id)
  check('W11-05 no ticket is issued for the stopped app', (bTicket as { state?: string }).state === 'stopped', JSON.stringify(bTicket))
  squatter.kill()

  // ---------- 8. Restart: old access dies, a fresh ticket opens the successor (SEC-06) ----------
  const restarted = (await apiPost(page, `/api/processes/${site.id}/restart`, {}) as { data: { id: string } }).data
  await until('A to come back', async () => (await procs(page)).find((p) => p.id === restarted.id && p.status === 'running' && p.url))
  const old = await tabA.reload()
  check('SEC-06 after a restart the old tab gets "access ended", not the app', old?.headers()['x-cockpit-preview'] === 'expired')
  await phone.bringToFront()
  const a2 = await viewApp('site', ORIGIN_A)
  check('SEC-06 a fresh ticket opens the restarted app', Boolean(a2 && await a2.tab.getByRole('heading', { name: 'Service A' }).isVisible()), a2?.how)

  // ---------- 9. Tailnet gone, then back; phone access off, then on (W11-06) ----------
  await phone.bringToFront()
  serve.disconnect()
  await appsMenu(phone)
  await row(phone, '.process-row', '.process-name', 'site').getByRole('button', { name: 'View app' }).click()
  await phone.locator('.phone-apps-state[data-state="disconnected"]').waitFor()
  await dismissToasts(phone)
  check('W11-06 without the tailnet the phone says it cannot reach the Mac, with Try again and Back', await phone.getByRole('button', { name: 'Try again', exact: true }).isVisible()
    && await phone.getByRole('button', { name: 'Back to conversation', exact: true }).isVisible() && await fits(phone))
  await shot(phone, 'phone-state-disconnected')
  step('tailnet back')
  serve.reconnect()
  await until('Serve back', async () => serve.ports().length === 3)
  const retried = await Promise.race([
    context.waitForEvent('page', { timeout: 15_000 }).then((p) => p.waitForURL(`${ORIGIN_A}/**`).then(() => p)),
    a2!.tab.waitForNavigation({ timeout: 15_000 }).then(() => a2!.tab),
    phone.getByRole('button', { name: 'Try again', exact: true }).click().then(() => new Promise<never>(() => undefined)),
  ]).catch(() => undefined)
  check('W11-06 back on the tailnet, Try again opens the app', Boolean(retried))
  if (!retried) await shot(phone, 'debug-try-again')
  await phone.getByRole('button', { name: 'Back to conversation', exact: true }).click({ timeout: 1000 }).catch(() => undefined)

  step('phone access off')
  const changesBefore = changes()
  const processesBefore = (await procs(page)).filter((p) => p.status === 'running').length
  await phonePanel(page)
  await page.getByRole('button', { name: 'Turn off phone access' }).click()
  await until('phone access off', async () => !(await getJson<{ running: boolean }>(page, '/api/remote')).running)
  const offChanges = changes().slice(changesBefore.length)
  check('W11-06 turning phone access off removes only the control entry; preview entries stay as the person set them',
    offChanges.join(' | ') === `serve --https=${CONTROL_HTTPS} off`, offChanges.join(' | '))
  const offTab = a2!.tab
  step('reload a preview tab while phone access is off')
  const offResponse = await offTab.reload({ timeout: 10_000 }).catch(() => undefined)
  check('W11-06 with phone access off the preview serves nothing', !(await offTab.locator('body').innerText()).includes('Service A'), String(offResponse?.status()))
  step('phone access on again')
  await page.getByRole('button', { name: 'Turn on phone access' }).click()
  await page.locator('.phone-qr').waitFor()
  await until('previews reopened', async () => (await getJson<{ services: { open: boolean }[] }>(page, '/api/phone/previews')).services.filter((s) => s.open).length === 2)
  const ended = await offTab.reload()
  check('W11-06 back on, an old tab needs fresh access (its sign-in is not revived)', ended?.headers()['x-cockpit-preview'] === 'expired'
    && await offTab.getByRole('link', { name: 'Back to Cockpit' }).isVisible())
  await shot(offTab, 'phone-state-expired')
  const onChanges = changes().slice(changesBefore.length + offChanges.length)
  check('W11-06 no hidden Tailscale change and no app started by retrying', onChanges.join(' | ') === `serve --bg --https=${CONTROL_HTTPS} http://127.0.0.1:${phonePort}`
    && (await procs(page)).filter((p) => p.status === 'running').length === processesBefore, onChanges.join(' | '))
  await phone.reload()
  await phone.getByText(PROMPT).first().click()
  const a3 = await viewApp('site', ORIGIN_A)
  check('W11-06 re-authentication is a fresh View app; the app sign-in (memory-only jar) starts over',
    Boolean(a3 && await a3.tab.getByText('not logged in').waitFor({ timeout: 10_000 }).then(() => true, () => false)), a3?.how)

  step('phone removed while HMR is open')
  // ---------- 10. Phone removed while HMR is open (CROSS-07, W11-02, SEC-06) ----------
  const hmrA3 = await until('a live HMR socket on the reopened tab', async () => [...live].find((ws) => owner.get(ws) === a3!.tab && ws.url().startsWith(ORIGIN_A.replace('https', 'wss'))), 10_000)
  await phonePanel(page)
  await page.locator('.phone-menu .device-row').getByRole('button', { name: 'Remove' }).click()
  const closed = await until('the HMR socket to close', async () => hmrA3 && !live.has(hmrA3), 5000)
  check('CROSS-07 removing the phone closes its open HMR socket at once', Boolean(hmrA3) && Boolean(closed), hmrA3 ? 'a socket that had received frames' : 'no live socket found')
  const gone = await a3!.tab.reload()
  check('W11-02 a removed phone gets "signed out" on the preview, with no app content', gone?.headers()['x-cockpit-preview'] === 'revoked'
    && !(await a3!.tab.locator('body').innerText()).includes('Service A'))
  await shot(a3!.tab, 'phone-state-revoked')
  await phone.reload()
  check('W11-02 and the control page asks to pair again', await phone.getByRole('heading', { name: 'Connect this phone to Cockpit' }).isVisible())
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message.split('\n')[0] : String(error))
  // Every open page, as it was when the proof stopped.
  const pages = [...(app ? await Promise.resolve(app.windows()) : []), ...(phoneBrowser?.contexts().flatMap((c) => c.pages()) ?? [])]
  for (const [i, open] of pages.entries()) await bounded('failure screenshot', open.screenshot({ path: join(PROOF_DIR, `wave11-failure-${i}.png`) }), 5000).catch(() => undefined)
} finally {
  squatter?.kill()
  await phoneBrowser?.close().catch(() => undefined)
  // A stuck app must not hang the proof: give it 15 s, then end the process the proof started.
  if (app) await bounded('app close', app.close(), 15_000).catch(() => { app?.process().kill('SIGKILL') })
  serve.close()
  const after = await realServe()
  check('this Mac\'s real Tailscale Serve config is unchanged', before === after, before.startsWith('(') ? before : 'compared')
  check('the app used the stand-in Tailscale CLI', calls().length > 0)
  appendFileSync(join(root, 'calls.txt'), calls().join('\n'))
  console.log(`state and stand-in Serve log: ${root}`)
}
finish('proof:wave-11')
