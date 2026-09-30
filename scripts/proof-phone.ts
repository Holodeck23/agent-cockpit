// Phase 6 gate, run against the PACKAGED app (npm run package first): `npm run proof:phone`.
// Needs Tailscale installed and logged in on this Mac. Turns phone access on for real
// (`tailscale serve` on HTTPS 8443, so an installed Cockpit on 443 is left alone), drives a Pixel-sized Chrome through the Mac's
// tailnet address, and turns it off again at the end.
//
// Every refusal is paired with a control that shows the same path CAN succeed, so a
// dead listener or a broken probe cannot pass as a working guard:
//   - a login that is not on the allowlist is refused through real Tailscale
//     (control: the owner's login is accepted on the same address)
//   - the LAN address cannot reach the phone port (control: a listener on every
//     interface is reachable there)
//   - no identity, a foreign Origin, and an unpaired phone are refused
//   - the desktop listener still refuses the tailnet Host
// Screenshots mask the tailnet name, QR code and login: the repo is public.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, chromium, devices, type ElectronApplication, type Page } from 'playwright-core'
import { checker, LAUNCHD_PATH, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { randomUUID } from 'node:crypto'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'
import { apiPost } from './lib/ui.ts'
import { createWorkflowStore } from '../server/workflows/store.ts'
import type { ThreadDetail } from '../web/src/api.ts'
import { tailscaleBinary } from '../server/remote/tailscale.ts'

mkdirSync(PROOF_DIR, { recursive: true })
const { check, finish } = checker()
const PORT = 47822
const HTTPS_PORT = 8443

function tailscale(args: string[]): string {
  return execFileSync(tailscaleBinary(), args, { encoding: 'utf8', timeout: 15_000 })
}
const status = JSON.parse(tailscale(['status', '--json'])) as { Self: { DNSName: string; UserID: number }; User: Record<string, { LoginName: string }> }
const NAME = status.Self.DNSName.replace(/\.$/, '')
const HOST = `${NAME}:${HTTPS_PORT}`
const LOGIN = status.User[String(status.Self.UserID)]!.LoginName
const redact = (text: string): string => text.split(NAME).join('<tailnet-host>').split(LOGIN).join('<owner>')

interface Reply { status: number; body: string }
function send(url: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method, headers, timeout: 20_000 }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })
}
const reachable = (host: string, port: number) => new Promise<boolean>((resolve) => {
  const socket = connect({ host, port })
  const done = (ok: boolean) => { socket.destroy(); resolve(ok) }
  socket.setTimeout(1500, () => done(false))
  socket.on('connect', () => done(true))
  socket.on('error', () => done(false))
})

/** Polls from Node: page.waitForFunction does not await an async predicate. */
async function waitUntil<T>(page: Page, what: string, read: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read().catch(() => undefined)
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await page.waitForTimeout(400)
  }
}
const getJson = <T>(page: Page, path: string): Promise<T> =>
  page.evaluate(async (p) => ((await (await fetch(p)).json()) as { data: unknown }).data, path) as Promise<T>

interface RemoteStatus { enabled: boolean; running: boolean; pairings: { id: string; code: string; name: string }[]; devices: { id: string; name: string }[] }

async function launch(state: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ executablePath: join(ROOT, 'release/mac-arm64/Cockpit.app/Contents/MacOS/Cockpit'),
    env: { HOME: process.env.HOME ?? '', USER: process.env.USER ?? '', SHELL: process.env.SHELL ?? '/bin/zsh',
      TMPDIR: process.env.TMPDIR ?? '/tmp', PATH: LAUNCHD_PATH, COCKPIT_HOME: state } })
  const page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  return { app, page }
}

/** What HTTPS 8443 serves: 'cockpit' (this proof's port), 'none', or something else to leave alone. */
function serveTarget(): string {
  const text = tailscale(['serve', 'status', '--json']).trim()
  const web = (text ? JSON.parse(text) : {}) as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> }
  const proxy = web.Web?.[`${NAME}:${HTTPS_PORT}`]?.Handlers?.['/']?.Proxy
  return !proxy ? 'none' : proxy === `http://127.0.0.1:${PORT}` ? 'cockpit' : 'other'
}
const configFor = (extra: object) => JSON.stringify({ port: PORT, httpsPort: HTTPS_PORT, ...extra })
if (serveTarget() !== 'none') throw new Error(`Tailscale already serves HTTPS ${HTTPS_PORT} on this Mac; this proof will not overwrite it`)

// ---- 1. A login that is not on the allowlist, through real Tailscale ----
{
  const state = mkdtempSync(join(tmpdir(), 'cockpit-phone-deny-'))
  writeFileSync(join(state, 'remote.json'), configFor({ enabled: true, allowedLogins: ['someone-else@example.invalid'] }))
  const { app, page } = await launch(state)
  try {
    await waitUntil(page, 'phone access to resume', async () => (await getJson<RemoteStatus>(page, '/api/remote')).running || undefined)
    const denied = await send(`https://${HOST}/`)
    check('a Tailscale login not on the allowlist is refused through real Tailscale', denied.status === 403, `${denied.status} ${redact(denied.body)}`)
  } finally {
    await app.close()
  }
  tailscale(['serve', `--https=${HTTPS_PORT}`, 'off'])
}

// ---- 2. Turn it on from the UI, then the refusals and their controls ----
const state = mkdtempSync(join(tmpdir(), 'cockpit-phone-'))
writeFileSync(join(state, 'remote.json'), configFor({}))
// Two synthetic conversations in two projects, so the phone list has something to show.
{
  const store = createThreadStore(state)
  const seed = (folder: string, title: string, lines: [string, string]) => {
    const projectPath = join(state, folder)
    mkdirSync(projectPath, { recursive: true })
    const id = randomUUID(); const now = new Date().toISOString()
    store.create({ id, projectPath, title, settings: threadSettingsSchema.parse({ model: 'haiku' }), sessionId: randomUUID(),
      sessionStarted: false, completed: false, createdAt: now, updatedAt: now })
    store.append(id, { kind: 'user_text', text: lines[0] })
    store.append(id, { kind: 'assistant_text', messageId: 'm1', text: lines[1] })
    store.append(id, { kind: 'result', ok: true })
  }
  seed('bakery-website', 'Add opening hours to the footer', ['Add our opening hours to the footer, Mon to Sat 7 to 18.',
    'Done. The footer now lists Monday to Saturday, 7:00 to 18:00, and Sunday as closed.'])
  seed('sprout', 'Fix the watering reminder time zone', ['Reminders fire an hour early since the clocks changed.',
    'Found it: the schedule used a fixed UTC offset. It now uses the plant owner\'s time zone, and the test covers the change.'])
}
const { app, page } = await launch(state)
const phoneBrowser = await chromium.launch({ channel: 'chrome' })
try {
  await page.getByRole('button', { name: 'Phone access' }).click()
  await page.getByRole('button', { name: 'Turn on phone access' }).click()
  const on = await waitUntil(page, 'phone access on', async () => {
    const s = await getJson<RemoteStatus>(page, '/api/remote')
    return s.running ? s : undefined
  })
  check('turned on from the Phone panel; Tailscale serves the phone port', on.enabled && serveTarget() === 'cockpit')
  await page.locator('.phone-qr').waitFor()
  const masks = [page.locator('.phone-qr'), page.locator('.phone-url'), page.locator('.phone-note b')]
  await page.screenshot({ path: join(PROOF_DIR, 'phase-6-phone-panel.png'), mask: masks })
  await page.keyboard.press('Escape')

  const home = await send(`https://${HOST}/`)
  check('control: the owner reaches the page through Tailscale', home.status === 200 && home.body.includes('<div id="root">'), String(home.status))
  const me = JSON.parse((await send(`https://${HOST}/api/remote/me`)).body) as { data: { mode: string; paired: boolean; login: string } }
  check('Tailscale identity arrives: remote mode, owner login, not paired', me.data.mode === 'remote' && !me.data.paired && me.data.login === LOGIN)
  const unpaired = await send(`https://${HOST}/api/threads`)
  check('an unpaired phone is refused the API', unpaired.status === 401, String(unpaired.status))
  const foreign = await send(`https://${HOST}/api/threads`, { origin: 'https://evil.example' })
  check('a foreign Origin is refused', foreign.status === 403, String(foreign.status))
  const direct = await send(`http://127.0.0.1:${PORT}/api/threads`)
  check('the phone port without Tailscale identity is refused', direct.status === 403, String(direct.status))
  const desktopPort = Number(new URL(page.url()).port)
  const desktop = await send(`http://127.0.0.1:${desktopPort}/api/threads`, { host: HOST })
  check('the desktop listener still refuses the tailnet Host', desktop.status === 403, String(desktop.status))
  const lan = Object.values(networkInterfaces()).flat().find((i) => i?.family === 'IPv4' && !i.internal && !i.address.startsWith('100.'))?.address
  if (lan) {
    const open = createServer().listen(0, '0.0.0.0')
    await new Promise((resolve) => open.once('listening', resolve))
    const control = await reachable(lan, (open.address() as { port: number }).port)
    open.close()
    check('control: a listener on every interface is reachable on the LAN address', control)
    check('the LAN address cannot reach the phone port', !(await reachable(lan, PORT)))
  } else check('LAN checks skipped: no LAN address', true)

  // ---- 3. Pair a phone ----
  const context = await phoneBrowser.newContext({ ...devices['Pixel 9'] })
  await context.grantPermissions(['notifications'], { origin: `https://${HOST}` })
  const phone = await context.newPage()
  phone.setDefaultTimeout(20_000)
  await phone.goto(`https://${HOST}/`)
  await phone.getByRole('heading', { name: 'Connect this phone to Cockpit' }).waitFor()
  await phone.screenshot({ path: join(PROOF_DIR, 'phase-6-phone-pair.png'), mask: [phone.locator('.pair b')] })
  await phone.getByRole('button', { name: 'Ask my Mac' }).click()
  const shown = (await phone.getByLabel('Pairing code').textContent())?.trim() ?? ''
  const banner = page.locator('.pairing-banner .pairing-row')
  await banner.waitFor()
  const onMac = (await banner.locator('.pairing-code').textContent())?.trim()
  check('the Mac shows the same code as the phone', /^\d{6}$/.test(shown) && onMac === shown)
  await page.screenshot({ path: join(PROOF_DIR, 'phase-6-pairing-request.png'), mask: [page.locator('.pairing-meta'), ...masks] })
  await banner.getByRole('button', { name: 'Allow' }).click()
  await phone.getByRole('heading', { name: 'Conversations' }).waitFor()
  const paired = await getJson<{ length: number }>(phone, '/api/threads')
  check('after approval the phone opens Cockpit and reads conversations', Array.isArray(paired))
  const blocked = await phone.evaluate(async () => (await fetch('/api/threads', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectPath: '/tmp', text: 'x' }) })).status)
  check('a paired phone still cannot start conversations in arbitrary folders', blocked === 403, String(blocked))
  // ---- Phone layout ----
  await phone.getByText('Add opening hours to the footer').waitFor()
  const cards = await phone.locator('.card .card-meta').allTextContents()
  check('the phone lists every project\'s conversations, labelled by project',
    cards.some((t) => t.startsWith('bakery-website')) && cards.some((t) => t.startsWith('sprout')), cards.join(' | '))
  check('the phone shows only Conversations (no Files or Workflows)', await phone.getByRole('tab', { name: 'Files' }).count() === 0 &&
    await phone.getByRole('tab', { name: 'Workflows' }).count() === 0 && await phone.getByRole('button', { name: 'New conversation' }).count() === 0)
  // On a phone, content wider than the screen stretches the layout viewport itself, so innerWidth grows
  // with it and "wider than the window" never triggers. Compare with the screen, and measure every box.
  const fits = () => phone.evaluate(() => window.innerWidth <= screen.width && document.documentElement.scrollWidth <= screen.width &&
    [...document.querySelectorAll<HTMLElement>('.card, .bubble, .composer-card, .thread-head, .thread-actions, .approval, .send')]
      .filter((el) => el.offsetParent !== null).every((el) => el.getBoundingClientRect().right <= window.innerWidth + 1))
  check('the list fits the phone width', await fits())
  await phone.screenshot({ path: join(PROOF_DIR, 'phase-6-phone-list.png') })
  await phone.getByText('Fix the watering reminder time zone').click()
  await phone.getByRole('button', { name: 'Back to conversations' }).waitFor()
  check('a conversation opens full screen: the list is hidden', !(await phone.locator('.list').isVisible()))
  check('the phone cannot switch agents or mark complete', await phone.locator('.picker-button').count() === 0 &&
    await phone.getByRole('button', { name: 'Mark complete' }).count() === 0 && await phone.locator('.agent-static').isVisible())
  await phone.screenshot({ path: join(PROOF_DIR, 'phase-6-phone-thread.png') })
  const measured = await phone.evaluate(() => ({ screen: screen.width, inner: window.innerWidth, visual: Math.round(window.visualViewport?.width ?? 0),
    doc: document.documentElement.scrollWidth,
    boxes: [...document.querySelectorAll<HTMLElement>('.thread, .bubble, .composer-card, .thread-head, .thread-actions')]
      .map((el) => `${el.className.split(' ')[0]}:${Math.round(el.getBoundingClientRect().left)}-${Math.round(el.getBoundingClientRect().right)}`) }))
  check('the conversation fits the phone width', await fits(), JSON.stringify(measured))
  await phone.getByRole('button', { name: 'Back to conversations' }).click()
  await phone.locator('.list').waitFor()
  check('back returns to the list', await phone.locator('.thread').count() === 0 || !(await phone.locator('.thread').isVisible()))
  const manifest = await phone.evaluate(async () => {
    const res = await fetch('/manifest.webmanifest')
    const body = (await res.json()) as { name: string; display: string; icons: { src: string; purpose: string }[] }
    const icons = await Promise.all(body.icons.map(async (i) => (await fetch(i.src)).status))
    return { type: res.headers.get('content-type'), name: body.name, display: body.display, maskable: body.icons.some((i) => i.purpose === 'maskable'), icons }
  })
  check('the web app manifest and its icons are served', manifest.type === 'application/manifest+json' && manifest.name === 'Cockpit' &&
    manifest.display === 'standalone' && manifest.maskable && manifest.icons.every((code) => code === 200), JSON.stringify(manifest))

  // ---- Notifications ----
  // Chrome under automation refuses push subscriptions ("Registration failed - permission denied", headless or
  // not). Real-phone delivery remains a separate manual gate; here we check the bell and worker.
  check('the phone shows the notifications bell', await phone.getByRole('button', { name: 'Turn on notifications' }).isVisible())
  const worker = await waitUntil(phone, 'the service worker', async () =>
    (await phone.evaluate(async () => (await navigator.serviceWorker.getRegistration('/'))?.active?.scriptURL ?? '')) || undefined)
  check('the service worker is registered', worker.endsWith('/sw.js'))

  // Optional real-agent gate: npm run proof:phone -- --live
  // A single small Codex turn, with the approval answered exclusively through the phone UI.
  if (process.argv.includes('--live')) {
    const projectPath = join(state, 'phone-approval-project')
    mkdirSync(projectPath)
    const workflowStore = createWorkflowStore(state)
    const created = await apiPost(page, '/api/threads', {
      projectPath, title: 'Save a workflow from my phone',
      settings: { agent: 'codex', model: process.env.COCKPIT_CODEX_MODEL ?? 'gpt-5.6-luna', permissionMode: 'manual' },
      text: 'Use the cockpit save_workflow tool to save a workflow named phone-check with instructions "Reply PHONE_APPROVED without running tools." Do not run shell commands or edit files. After the tool succeeds, reply PHONE_APPROVED.',
    }) as { data?: { id: string }; error?: string }
    if (!created.data) throw new Error(created.error ?? 'Could not create the approval conversation')
    const id = created.data.id
    const pending = await waitUntil(page, 'the real Codex approval', async () => {
      const detail = await getJson<ThreadDetail>(page, `/api/threads/${id}/events`)
      if (detail.status === 'error' || detail.status === 'done') return { detail, failed: true }
      return detail.status === 'needs_input' ? { detail, failed: false } : undefined
    }, 120_000)
    if (pending.failed) throw new Error(`Agent finished before approval: ${JSON.stringify(pending.detail.events.slice(-3))}`)
    check('real Codex waits for approval without saving the workflow', workflowStore.list(projectPath).length === 0)
    // The exact destination used by notificationclick, including a fresh page load.
    await phone.goto(`https://${HOST}/?thread=${encodeURIComponent(id)}`)
    await phone.getByRole('heading', { name: 'Save a workflow from my phone', exact: true }).waitFor()
    const approval = phone.locator('.approval')
    await approval.waitFor()
    check('notification destination opens the requested conversation and its approval',
      !(await phone.locator('.list').isVisible()) && (await approval.innerText()).includes('save_workflow'))
    await phone.screenshot({ path: join(PROOF_DIR, 'phase-6-phone-approval.png') })
    await approval.getByRole('button', { name: 'Allow', exact: true }).click()
    const completed = await waitUntil(page, 'Codex to finish after phone approval', async () => {
      const detail = await getJson<ThreadDetail>(page, `/api/threads/${id}/events`)
      return detail.status === 'done' || detail.status === 'error' ? detail : undefined
    }, 120_000)
    check('phone approval reaches the real agent and it completes successfully', completed.status === 'done' &&
      completed.events.some(({ event }) => event.kind === 'assistant_text' && event.text.includes('PHONE_APPROVED')))
    check('the approved tool saved exactly one workflow with scheduling off',
      workflowStore.list(projectPath).length === 1 && workflowStore.list(projectPath)[0]?.enabled === false)
    await waitUntil(phone, 'the completed response over the phone live stream', async () =>
      (await phone.locator('.thread-status .status-text').innerText()).trim() === 'Ready' &&
      (await phone.locator('.bubble').last().innerText()).includes('PHONE_APPROVED') || undefined)
    check('the phone receives the completed response without reloading', true)
    await phone.screenshot({ path: join(PROOF_DIR, 'phase-6-phone-approved.png') })
  }

  const list = await getJson<RemoteStatus>(page, '/api/remote')
  check('the Mac lists the paired phone', list.devices.length === 1 && list.pairings.length === 0, `devices ${list.devices.length}, pending ${list.pairings.length}`)

  // ---- 4. Revoke and turn off ----
  await page.getByRole('button', { name: 'Phone access' }).click()
  await page.getByRole('button', { name: 'Remove' }).click()
  const revoked = await waitUntil(page, 'the revoked phone to be refused', async () => {
    const code = await phone.evaluate(async () => (await fetch('/api/threads')).status)
    return code === 401 ? code : undefined
  })
  check('a removed phone is refused again', revoked === 401)
  await page.getByRole('button', { name: 'Turn off phone access' }).click()
  await waitUntil(page, 'phone access off', async () => !(await getJson<RemoteStatus>(page, '/api/remote')).running || undefined)
  check('turning off removes the Tailscale serve entry', serveTarget() === 'none')
  check('turning off closes the phone port', !(await reachable('127.0.0.1', PORT)))
} catch (error) {
  check('proof ran to completion', false, redact(error instanceof Error ? error.message : String(error)))
} finally {
  await phoneBrowser.close()
  await app.close()
  if (serveTarget() === 'cockpit') tailscale(['serve', `--https=${HTTPS_PORT}`, 'off'])
}
finish('PHASE 6')
