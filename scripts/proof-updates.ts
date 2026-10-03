// Packaged-app proof for Check for Updates. Launches a packaged Cockpit with isolated state and
// the main-process inspector, then clicks the real app-menu item. Only the native dialog's button
// choice and the browser hand-off are stubbed; the menu, version, feed request and dialog content
// are the app's own. Build the app with an older version so the live feed has something to offer:
//   npx electron-builder --mac --arm64 --dir -c.directories.output=release/update-proof -c.extraMetadata.version=0.1.1
//   npm run proof:updates -- release/update-proof/mac-arm64/Cockpit.app
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const appPath = resolve(process.argv[2] ?? 'release/update-proof/mac-arm64/Cockpit.app')
const port = 9339
const portBusy = await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false)
if (portBusy) {
  console.error(`proof:updates: port ${port} is already in use; stop that process first`)
  process.exit(1)
}
const home = mkdtempSync(join(tmpdir(), 'cockpit-update-proof-'))
const child = spawn(join(appPath, 'Contents/MacOS/Cockpit'), [`--inspect=${port}`], {
  env: { ...process.env, COCKPIT_HOME: home },
  stdio: ['ignore', 'ignore', 'pipe'],
})
let stderr = ''
child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

const failures: string[] = []
const check = (ok: boolean, label: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) failures.push(label)
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

async function inspectorUrl(): Promise<string> {
  for (let i = 0; i < 100; i += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { webSocketDebuggerUrl: string }[]
      if (targets[0]) return targets[0].webSocketDebuggerUrl
    } catch { /* not listening yet */ }
    await sleep(200)
  }
  throw new Error('main-process inspector did not start')
}

function connect(url: string): Promise<(expression: string) => Promise<unknown>> {
  const socket = new WebSocket(url)
  let id = 0
  const pending = new Map<number, (value: unknown) => void>()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: unknown }; exceptionDetails?: unknown } }
    if (message.id === undefined) return
    const exception = message.result?.exceptionDetails
    pending.get(message.id)?.(exception ? { error: JSON.stringify(exception).slice(0, 600) } : message.result?.result?.value)
    pending.delete(message.id)
  })
  return new Promise((ready, fail) => {
    socket.addEventListener('error', () => fail(new Error('inspector connection failed')))
    socket.addEventListener('open', () => ready((expression) => new Promise((done) => {
      id += 1
      const call = id
      pending.set(call, done)
      setTimeout(() => {
        if (pending.delete(call)) done({ error: 'inspector call timed out after 60s' })
      }, 60_000)
      socket.send(JSON.stringify({ id: call, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    })))
  })
}

// Runs inside the app's main process: click the menu item, answer the dialog with `button`,
// and report what the app showed and what it asked the browser to open.
const scenario = (button: number, offline: boolean): string => `(async () => {
  const { app, Menu, dialog, shell } = process.mainModule.require('electron')
  for (let i = 0; i < 100 && !Menu.getApplicationMenu(); i += 1) await new Promise((r) => setTimeout(r, 100))
  const appMenu = Menu.getApplicationMenu().items[0].submenu.items
  const item = appMenu.find((entry) => entry.label === 'Check for Updates…')
  const shown = []
  const opened = []
  const realFetch = globalThis.fetch
  if (${offline}) globalThis.fetch = () => Promise.reject(new TypeError('fetch failed'))
  dialog.showMessageBox = async (...args) => { shown.push(args.at(-1)); return { response: ${button}, checkboxChecked: false } }
  shell.openExternal = async (url) => { opened.push(url) }
  item.click()
  for (let i = 0; i < 150 && shown.length === 0; i += 1) await new Promise((r) => setTimeout(r, 100))
  await new Promise((r) => setTimeout(r, 300))
  globalThis.fetch = realFetch
  return { version: app.getVersion(), labels: appMenu.map((entry) => entry.label), enabled: item.enabled, shown, opened }
})()`

interface ScenarioResult {
  readonly version: string
  readonly labels: string[]
  readonly enabled: boolean
  readonly shown: { message: string; detail: string; buttons: string[] }[]
  readonly opened: string[]
  readonly error?: string
}

try {
  const evaluate = await connect(await inspectorUrl())
  const download = await evaluate(scenario(0, false)) as ScenarioResult
  if (download.error) throw new Error(download.error)
  const dialogShown = download.shown[0]
  console.log(`     menu: ${download.labels.filter(Boolean).join(' · ')}`)
  console.log(`     dialog: ${dialogShown?.message} | ${dialogShown?.buttons.join(' / ')}`)
  check(download.labels.includes('Check for Updates…') && download.enabled, 'app menu has an enabled Check for Updates… item')
  check(download.labels.includes('Quit Cockpit') || download.labels.some((label) => /^Quit/.test(label)), 'app menu still has Quit')
  check(download.shown.length === 1 && /^Cockpit \d+\.\d+\.\d+.* is available$/.test(dialogShown?.message ?? ''), 'one dialog offers the newer release')
  check(dialogShown?.detail.includes(`You have ${download.version}.`) === true, `dialog reports the app's actual version (${download.version})`)
  check(download.opened.length === 1 && /^https:\/\/github\.com\/Holodeck23\/agent-cockpit\/releases\/download\/v[^/]+\/Cockpit-[^/]+-arm64\.dmg$/.test(download.opened[0] ?? ''), `Download Update opens the official DMG (${download.opened[0]})`)

  const later = await evaluate(scenario(1, false)) as ScenarioResult
  check(later.shown.length === 1 && later.opened.length === 0, 'Later opens nothing')

  const offline = await evaluate(scenario(0, true)) as ScenarioResult
  const offlineDialog = offline.shown[0]
  console.log(`     offline dialog: ${offlineDialog?.message} | ${offlineDialog?.detail}`)
  check(offlineDialog?.message === "Couldn't check for updates" && offline.opened.length === 0, 'offline check reports failure and opens nothing')
  check(!/up to date/i.test(offlineDialog?.message ?? '') && /does not mean/i.test(offlineDialog?.detail ?? ''), 'offline check is not worded as up to date')

  await evaluate(`process.mainModule.require('electron').app.exit(0)`).catch(() => undefined)
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error))
  console.error(error)
  if (stderr) console.error(`app stderr:\n${stderr.slice(-2000)}`)
} finally {
  await sleep(500)
  if (child.exitCode === null) child.kill('SIGTERM')
  rmSync(home, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`proof:updates FAILED (${failures.length})`)
  process.exit(1)
}
console.log('proof:updates passed')
