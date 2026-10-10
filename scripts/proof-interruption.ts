// D18, PACKAGED app, stand-in agents (no provider usage): what interruption and restart do and do not give.
//   A  Quit in the middle of a turn, reopen: the conversation does not claim to be Working, nothing
//      restarts by itself (no agent process after reopen), and sending a message carries on.
//   B  Quit while an approval is open, reopen: the old card cannot be answered (no Allow/Deny), the
//      conversation does not say it needs you, and a new message asks again from a fresh session.
//   C  Stop in the middle of a turn, then send a new message at once: the agent ends, the message runs.
// Usage: npm run package:proof, wait a minute (XProtect), then
//   COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:interruption
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { APP_BUNDLE, checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { headStatus, messageBox, openProject, startConversation } from './lib/ui.ts'

const { check, finish } = checker()
mkdirSync(PROOF_DIR, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SILENT = join(ROOT, 'scripts/fixtures/silent-agent')
const ASK = join(ROOT, 'scripts/fixtures/ask-agent')
const alive = (dir: string): number => {
  try { return execFileSync('pgrep', ['-f', dir], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length } catch { return 0 }
}
const until = async (what: string, test: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await test()) return true; await sleep(200) }
  console.log(`  (timed out waiting for ${what})`)
  return false
}

interface Session { home: string; project: string }
const session = (label: string): Session => {
  const home = mkdtempSync(join(tmpdir(), `cockpit-interrupt-${label}-`))
  const project = join(home, 'project')
  mkdirSync(project)
  writeFileSync(join(project, 'README.md'), '# scratch\n')
  return { home, project }
}
const launch = (s: Session, agentDir: string): Promise<ElectronApplication> =>
  launchPackagedApp({ COCKPIT_HOME: join(s.home, 'state'), COCKPIT_AGENT_PATH: agentDir })

async function quit(app: ElectronApplication): Promise<boolean> {
  let exited = false
  app.process().on('exit', () => { exited = true })
  execFile('osascript', ['-e', `tell application "${APP_BUNDLE}" to quit`])
  return until('Quit', () => exited, 12_000)
}
type Row = { meta: { id: string }; status: string }
const rows = (page: Page): Promise<Row[]> => page.evaluate(async () => ((await (await fetch('/api/threads')).json()) as { data: Row[] }).data)
const openFirstRow = async (page: Page): Promise<void> => {
  await page.getByRole('navigation', { name: 'Conversations' }).locator('.cards button').first().click()
  await page.locator('.thread-head h1').waitFor()
  await sleep(500)
}

// A: Quit mid-turn.
{
  const s = session('a')
  let app = await launch(s, SILENT)
  let page = await app.firstWindow(); page.setDefaultTimeout(15_000)
  await openProject(page, s.project, 'Interrupt A')
  await startConversation(page, 'Keep working until Cockpit quits')
  check('A: an agent is mid-turn before Quit', await until('the agent', () => alive(SILENT) > 0))
  check('A: Quit ends the app', await quit(app))
  await sleep(500)
  check('A: no agent outlives Quit', alive(SILENT) === 0, `${alive(SILENT)} left`)

  app = await launch(s, SILENT)
  page = await app.firstWindow(); page.setDefaultTimeout(15_000)
  await page.getByRole('navigation', { name: 'Conversations' }).waitFor()
  await openProject(page, s.project, 'Interrupt A')
  await openFirstRow(page)
  const after = await rows(page)
  const shown = (await headStatus(page).textContent()) ?? ''
  console.log(`  · A recorded: reopened status "${after[0]?.status}", header "${shown.trim()}"`)
  check('A: the reopened conversation is not Working or Starting', !['working', 'starting'].includes(after[0]?.status ?? '') && !/Working|Starting/.test(shown), `${after[0]?.status} / ${shown.trim()}`)
  await sleep(3_000)
  check('A: nothing restarted by itself (no agent process after reopen)', alive(SILENT) === 0, `${alive(SILENT)} running`)
  check('A: the conversation says the turn stopped, not that it will resume', /Stopped|stopped/.test((await page.locator('.transcript').innerText()) ?? ''))
  await page.screenshot({ path: join(PROOF_DIR, 'interruption-A-reopened.png') })
  await messageBox(page).fill('Carry on')
  await messageBox(page).press('Enter')
  check('A: a new message carries on in a fresh session', await until('the agent', () => alive(SILENT) > 0))
  await app.close().catch(() => undefined)
}

// B: Quit with an approval open.
{
  const s = session('b')
  let app = await launch(s, ASK)
  let page = await app.firstWindow(); page.setDefaultTimeout(15_000)
  await openProject(page, s.project, 'Interrupt B')
  await startConversation(page, 'Run a step for me')
  check('B: an approval card is open before Quit', await until('the card', async () => (await page.locator('.approval.open').count()) > 0))
  check('B: Quit ends the app', await quit(app))
  await sleep(500)

  app = await launch(s, ASK)
  page = await app.firstWindow(); page.setDefaultTimeout(15_000)
  await page.getByRole('navigation', { name: 'Conversations' }).waitFor()
  await openProject(page, s.project, 'Interrupt B')
  await openFirstRow(page)
  const after = await rows(page)
  const open = await page.locator('.approval.open').count()
  const buttons = await page.locator('.approval-actions button').count()
  console.log(`  · B recorded: status "${after[0]?.status}", open cards ${open}, answer buttons ${buttons}`)
  check('B: the old card cannot be answered (no open card, no Allow/Deny)', open === 0 && buttons === 0, `open ${open}, buttons ${buttons}`)
  check('B: the conversation does not claim it needs you', after[0]?.status !== 'needs_input', after[0]?.status ?? '')
  // Since PR #46 (via #52) an ended request is not left as a card: it joins the decision record with
  // one resolution word, here Canceled, and expanding the record names the tool it was for.
  const record = page.locator('details.decisions').first()
  check('B: the old request says why it cannot be answered (Canceled in the decision record)', /\bCanceled\b/.test((await record.locator('summary').innerText().catch(() => '')) ?? ''),
    await record.locator('summary').innerText().catch(() => 'no decision record'))
  await page.screenshot({ path: join(PROOF_DIR, 'interruption-B-reopened.png') })
  await messageBox(page).fill('Try again')
  await messageBox(page).press('Enter')
  check('B: a new message asks again from a fresh session', await until('a new card', async () => (await page.locator('.approval.open').count()) > 0))
  await app.close().catch(() => undefined)
}

// C: Stop mid-turn, then a new message at once. The wave 12 stand-in honours Stop (a HOLD turn
// runs until Cockpit interrupts it) and answers a plain message with a reply naming its folder.
{
  const W12 = join(ROOT, 'scripts/fixtures/wave12-agent')
  const s = session('c')
  const app = await launch(s, W12)
  const page = await app.firstWindow(); page.setDefaultTimeout(15_000)
  await openProject(page, s.project, 'Interrupt C')
  await startConversation(page, 'HOLD this turn until I stop you')
  check('C: the turn is running', await until('Working', async () => /Working|Starting/.test((await headStatus(page).textContent()) ?? '')))
  await page.locator('.thread-head').getByRole('button', { name: 'Stop', exact: true }).click()
  check('C: Stop ends the turn (not Working)', await until('Stop', async () => !/Working|Starting/.test((await headStatus(page).textContent()) ?? '')))
  await messageBox(page).fill('Go again now')
  await messageBox(page).press('Enter')
  const replied = await until('the new reply', async () => ((await page.locator('.transcript').innerText()) ?? '').includes('cwd='), 20_000)
  check('C: the message sent right after Stop runs and is answered', replied)
  check('C: and the turn ends cleanly afterwards', await until('Ready', async () => !/Working|Starting/.test((await headStatus(page).textContent()) ?? '')))
  await page.screenshot({ path: join(PROOF_DIR, 'interruption-C-after-stop.png') })
  await app.close().catch(() => undefined)
}
finish('proof:interruption')
