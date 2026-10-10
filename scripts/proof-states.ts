// D10 session-state gate, run against the PACKAGED app (npm run package:proof first):
//   COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:states
// No agent usage: scripts/fixtures/states-agent leaves each conversation in one state. Checks the
// header and list label for Starting, Working, Needs you, Ready, Error and Idle (after Stop),
// and saves one screenshot per state to PROOF_DIR/states/.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { headStatus, messageBox, openProject } from './lib/ui.ts'

const home = mkdtempSync(join(tmpdir(), 'cockpit-states-proof-'))
const project = join(home, 'states-demo')
mkdirSync(project)
writeFileSync(join(project, 'README.md'), '# demo\n')
const shots = join(PROOF_DIR, 'states')
mkdirSync(shots, { recursive: true })

async function start(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: 'New conversation' }).click()
  await messageBox(page).fill(text)
  await messageBox(page).press('Enter')
  await page.getByRole('heading', { level: 1, name: text.slice(0, 20) }).waitFor()
}

const { check, finish } = checker()
const app = await launchPackagedApp({ COCKPIT_HOME: join(home, 'state'), COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/states-agent') })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
page.setDefaultTimeout(15_000)

async function expectState(label: string, text: string, title = text): Promise<void> {
  await headStatus(page).filter({ hasText: label }).waitFor()
  const card = page.locator('.card').filter({ hasText: title.slice(0, 20) })
  check(`${label}: the header says it`, ((await headStatus(page).textContent()) ?? '').includes(label))
  // The list shows a state for every busy or finished conversation; an idle one (Idle) is header-only by design.
  if (label === 'Idle') check('Idle: the list card shows no state pill (idle is header-only)', await card.locator('.pill').count() === 0)
  else check(`${label}: the list card carries the same state`, (await card.innerText()).includes(label))
  await page.screenshot({ path: join(shots, `${label.toLowerCase().replace(/ /g, '-')}.png`) })
}

try {
  await openProject(page, project, 'States demo')
  await start(page, 'Check starting state')
  await expectState('Starting', 'Check starting state')
  await page.locator('.thread-head').getByRole('button', { name: 'Stop', exact: true }).click()
  await expectState('Idle', 'Check starting state')

  await start(page, 'Check working state')
  await expectState('Working', 'Check working state')

  await start(page, 'Check question state')
  await expectState('Needs you', 'Check question state')

  await start(page, 'Check ready state')
  // J9 (frozen backlog): the Working indicator clears on the final reply, not some time later.
  await page.locator('.bubble.reply').filter({ hasText: 'Done. Nothing else to do.' }).waitFor()
  const replyShown = Date.now()
  await headStatus(page).filter({ hasText: 'Ready' }).waitFor()
  check('J9 the Working indicator clears with the final reply (within 1 s)', Date.now() - replyShown <= 1000, `${Date.now() - replyShown} ms`)
  await expectState('Ready', 'Check ready state')

  await start(page, 'Check error state')
  await expectState('Error', 'Check error state')
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
  await page.screenshot({ path: join(shots, 'failure.png') }).catch(() => {})
} finally {
  await app.close()
}
finish('PROOF STATES')
