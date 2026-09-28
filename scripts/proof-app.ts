// Phase A gate: drive the PACKAGED Cockpit.app, not the dev build.
//   tsx scripts/proof-app.ts
// Launches it with launchd's bare PATH (what a Finder/Dock launch gets), so the
// app has to find `claude` through its login-shell PATH fix. Starts a Haiku
// thread from the window, waits for Done, screenshots, then quits while a second
// agent is mid-turn and checks that no agent process outlived the app.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checker, LAUNCHD_PATH, launchPackagedApp, PROOF_DIR as OUT } from './lib/launch-app.ts'
import { chooseAgent, headStatus, openProject, startConversation } from './lib/ui.ts'

mkdirSync(OUT, { recursive: true })
const claudeDir = dirname(execFileSync('which', ['claude'], { encoding: 'utf8' }).trim())
const projectDir = mkdtempSync(join(tmpdir(), 'cockpit-app-proof-'))
writeFileSync(join(projectDir, 'README.md'), '# proof project\n')
const { check, finish } = checker()

const app = await launchPackagedApp()
const appPid = app.process().pid ?? 0

const mainPath = await app.evaluate(() => process.env.PATH ?? '')
check('launched without claude on PATH', !LAUNCHD_PATH.split(':').includes(claudeDir))
check('app resolved the login-shell PATH', mainPath.split(':').includes(claudeDir), claudeDir)

const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBounds())
check('window is 1360x860', bounds?.width === 1360 && bounds.height === 860, JSON.stringify(bounds))
check('page served from loopback', /^http:\/\/127\.0\.0\.1:\d+\/$/.test(page.url()), page.url())
const bridge = await page.evaluate(() => {
  const w = window as { cockpit?: { platform: string; pickFolder: unknown } }
  return { platform: w.cockpit?.platform, picker: typeof w.cockpit?.pickFolder, inApp: document.documentElement.classList.contains('in-app') }
})
check('preload bridge present', bridge.platform === 'darwin' && bridge.picker === 'function' && bridge.inApp, JSON.stringify(bridge))
const nodeLeak = await page.evaluate(() => typeof (window as { require?: unknown }).require)
check('no Node in the page', nodeLeak === 'undefined')

const prompt = 'List three prime numbers, one per line.'
await openProject(page, projectDir)
await chooseAgent(page, { model: 'haiku' })
await startConversation(page, prompt)
await headStatus(page).filter({ hasText: /Done|Error/ }).waitFor({ timeout: 180_000 })
const status = (await headStatus(page).textContent()) ?? ''
const reply = (await page.locator('.bubble.agent').allTextContents()).join(' ')
check('Haiku thread reached Done', status === 'Done', status)
check('agent replied with primes', /\b(2|3|5|7)\b/.test(reply), reply.replace(/\s+/g, ' ').slice(0, 60))
await page.screenshot({ path: join(OUT, 'phase-A-app.png') })

// Quit while a second agent is mid-turn: the case that would orphan a process.
await startConversation(page, 'Write a 1500 word essay on the history of coffee. Plain text, no tools.')
await page.locator('.bubble.streaming').waitFor({ timeout: 60_000 })

const agentPids = execFileSync('pgrep', ['-P', String(appPid)], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter((pid) => pid && /claude/.test(execFileSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' })))
check('both agent sessions are children of the app', agentPids.length === 2, `pids ${agentPids.join(',')}`)

const quitStarted = Date.now()
await app.close()
const quitMs = Date.now() - quitStarted
const isAlive = (pid: string): boolean => {
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}
const alive = agentPids.filter(isAlive)
check(
  'quit (one agent mid-turn) left no agent running',
  alive.length === 0,
  alive.length ? `still alive: ${alive.join(',')}` : `quit took ${(quitMs / 1000).toFixed(1)}s`,
)

finish('PHASE A')
