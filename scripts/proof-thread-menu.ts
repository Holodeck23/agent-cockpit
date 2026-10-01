// U3 gate, run against the PACKAGED app (npm run package first): `npm run proof:thread-menu`.
// Claude is replaced by a stand-in (scripts/fixtures/ask-agent) that asks for two approvals per
// turn in Claude Code's own format, so the check costs nothing. Answered approvals must collapse
// into short decision lines that expand to the answer and command; a completed conversation ends with a
// Reopen bar; Mark as unread closes it and flags it; Delete asks first, stops a working agent and
// removes everything stored for the conversation.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { headStatus, openProject, startConversation } from './lib/ui.ts'

interface Summary { meta: { id: string; title: string }; status: string }

const dir = mkdtempSync(join(tmpdir(), 'cockpit-menu-proof-'))
writeFileSync(join(dir, 'README.md'), '# menu proof\n')

const getJson = <T>(page: Page, path: string): Promise<T> =>
  page.evaluate(async (p) => ((await (await fetch(p)).json()) as { data: unknown }).data, path) as Promise<T>
const threads = async (page: Page): Promise<Summary[]> => getJson<Summary[]>(page, '/api/threads')
const agentChildren = (appPid: number): number => {
  try {
    return execFileSync('pgrep', ['-P', String(appPid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
      .filter((pid) => /ask-agent\/claude/.test(execFileSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' }))).length
  } catch { return 0 }
}
async function until<T>(page: Page, what: string, read: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await page.waitForTimeout(250)
  }
}

const { check, finish } = checker()
mkdirSync(PROOF_DIR, { recursive: true })
const app = await launchPackagedApp({ COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/ask-agent') })
const appPid = app.process().pid ?? 0
const home = await app.evaluate(() => process.env.COCKPIT_HOME ?? '')
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
const card = (title: string) => page.locator('.card').filter({ hasText: title })
const openMenu = async (): Promise<void> => { await page.getByRole('button', { name: 'More' }).click() }

try {
  await openProject(page, dir, 'Menu demo')

  // Decisions
  await startConversation(page, 'Run the two steps')
  await page.locator('.approval.open').getByRole('button', { name: 'Allow', exact: true }).click()
  await page.locator('.approval.open').filter({ hasText: 'echo step 2' }).waitFor({ timeout: 15_000 })
  await page.locator('.approval.open').getByRole('button', { name: 'Deny', exact: true }).click()
  await headStatus(page).filter({ hasText: 'Ready' }).waitFor({ timeout: 15_000 })
  const summaries = page.locator('details.decisions summary')
  // Each answer is followed by the step it allowed or refused, so each gets its own line.
  check('answered approvals become decision lines, no cards left', await page.locator('.approval').count() === 0
    && JSON.stringify(await summaries.allTextContents()) === JSON.stringify(['1 decision · Allowed', '1 decision · Denied']),
    (await summaries.allTextContents()).join(' | '))
  await summaries.nth(1).click()
  const line = (await page.locator('details.decisions[open] li').allTextContents()).map((t) => t.replace(/\s+/g, ' '))
  check('expanding shows the answer, tool and command', line.length === 1 && line[0]!.startsWith('Denied') && line[0]!.includes('Bash')
    && line[0]!.includes('echo step 2'), line.join(' | '))

  // Completed bar
  await page.getByRole('button', { name: 'Mark complete' }).click()
  await page.getByText('Marked complete').waitFor({ timeout: 10_000 })
  check('a completed conversation ends with a Reopen bar', await page.locator('.completed-bar').getByRole('button', { name: 'Reopen' }).isVisible())
  await page.screenshot({ path: join(PROOF_DIR, 'proof-thread-menu.png') })
  await page.locator('.completed-bar').getByRole('button', { name: 'Reopen' }).click()
  await page.locator('.completed-bar').waitFor({ state: 'detached', timeout: 10_000 })
  check('Reopen clears it', (await page.getByRole('button', { name: 'Mark complete' }).getAttribute('aria-pressed')) === 'false')

  // Mark as unread
  await openMenu()
  await page.getByRole('menuitem', { name: 'Mark as unread' }).click()
  await page.getByRole('heading', { level: 1, name: 'Run the two steps' }).waitFor({ state: 'detached', timeout: 10_000 })
  check('marking unread closes the conversation', true)
  check('its card shows the unread dot', await card('Run the two steps').getByLabel('Unread').isVisible())
  check('the Unread filter counts it', /Unread\s*1/.test(await page.getByRole('tab', { name: /Unread/ }).textContent() ?? ''))
  await card('Run the two steps').click()
  await page.getByRole('heading', { level: 1, name: 'Run the two steps' }).waitFor()
  check('opening it reads it again', await card('Run the two steps').getByLabel('Unread').count() === 0)

  // Delete, while the agent is waiting on an approval
  await startConversation(page, 'Delete me later')
  await page.locator('.approval.open').waitFor({ timeout: 15_000 })
  const doomed = await until(page, 'the second conversation', async () => (await threads(page)).find((t) => t.meta.title === 'Delete me later'))
  const doomedDir = join(home, 'threads', doomed.meta.id)
  check('its agent is running and its folder exists', agentChildren(appPid) >= 1 && existsSync(doomedDir))
  await openMenu()
  await page.getByRole('menuitem', { name: 'Delete conversation…' }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Delete conversation' })
  check('delete asks first and says the agent is stopped', await confirm.getByText(/The agent working on it is stopped first\./).isVisible())
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  check('Cancel keeps it', existsSync(doomedDir) && await page.getByRole('heading', { level: 1, name: 'Delete me later' }).isVisible())
  const before = agentChildren(appPid)
  // Cancel goes back to the menu, which is still open.
  await page.getByRole('menuitem', { name: 'Delete conversation…' }).click()
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('heading', { level: 1, name: 'Delete me later' }).waitFor({ state: 'detached', timeout: 15_000 })
  await until(page, 'the agent to stop', async () => agentChildren(appPid) < before)
  check('the agent is stopped', agentChildren(appPid) === before - 1, `${before} -> ${agentChildren(appPid)}`)
  check('its folder is gone', !existsSync(doomedDir))
  check('it leaves the list', await card('Delete me later').count() === 0 && !(await threads(page)).some((t) => t.meta.id === doomed.meta.id))
  const gone = await page.evaluate(async (id) => (await fetch(`/api/threads/${id}/events`)).status, doomed.meta.id)
  check('the API no longer knows it', gone === 404, String(gone))
  check('the other conversation is untouched', await card('Run the two steps').isVisible())
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
  await page.screenshot({ path: join(PROOF_DIR, 'proof-thread-menu-failure.png') }).catch(() => {})
} finally {
  await app.close()
}
finish('PROOF THREAD MENU')
