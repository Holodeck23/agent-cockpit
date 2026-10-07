// Browser proof for UI gates. Drives the real cockpit page (npm start) in headless Chrome.
//   tsx scripts/proof-ui.ts parallel <projectDir>   start 3 threads, wait for all Ready
//   tsx scripts/proof-ui.ts reload <projectDir>     after a server restart, confirm threads persisted
//   tsx scripts/proof-ui.ts approvals <projectDir>  allow one write, deny the next
//   tsx scripts/proof-ui.ts interrupt <projectDir>  stop a long turn
//   tsx scripts/proof-ui.ts switch <projectDir>     Claude writes a file, Codex answers about it
import { mkdirSync } from 'node:fs'
import { chromium, type Page } from 'playwright-core'
import { chooseAgent, headStatus, messageBox, openProject, startConversation, switchWithHandoff } from './lib/ui.ts'

const BASE = process.env.COCKPIT_URL ?? 'http://127.0.0.1:4317'
const OUT = new URL('../docs/proof/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })

async function pillCounts(page: Page): Promise<Record<string, number>> {
  return page.$$eval('.card .pill', (pills) =>
    pills.reduce<Record<string, number>>((acc, pill) => ({ ...acc, [pill.textContent ?? '']: (acc[pill.textContent ?? ''] ?? 0) + 1 }), {}),
  )
}

const [mode, projectDir] = process.argv.slice(2)
if (!projectDir) throw new Error(`usage: proof-ui.ts ${mode ?? '<mode>'} <projectDir>`)
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } })
await page.goto(BASE)
await openProject(page, projectDir)
if (mode !== 'reload') await chooseAgent(page, { model: 'haiku', permissions: mode === 'switch' ? 'acceptEdits' : 'manual' })

if (mode === 'parallel') {
  await startConversation(page, 'List three prime numbers, one per line.')
  await startConversation(page, 'Name two colours of the rainbow, comma separated.')
  await startConversation(page, 'Write a four word sentence about coffee.')
  await page.waitForTimeout(1500)
  console.log('while running:', await pillCounts(page))
  await page.screenshot({ path: `${OUT}phase-1-running.png` })
  await page.locator('.card .pill-done').nth(2).waitFor({ timeout: 180_000 })
  console.log('finished:', await pillCounts(page))
  await page.screenshot({ path: `${OUT}phase-1-done.png` })
} else if (mode === 'reload') {
  await page.locator('.card .pill').first().waitFor()
  console.log('after restart:', await pillCounts(page))
  await page.locator('.card').first().click()
  await page.locator('.bubble.agent').first().waitFor()
  console.log('opened thread shows', await page.locator('.bubble').count(), 'messages')
  await page.screenshot({ path: `${OUT}phase-1-after-restart.png` })
} else if (mode === 'approvals') {
  await startConversation(
    page,
    'Use the Write tool to create allowed.txt containing yes. Then use the Write tool to create denied.txt containing no. Do not ask questions.',
  )
  const openCard = page.locator('.approval.open')
  await openCard.waitFor({ timeout: 60_000 })
  console.log('first approval:', await openCard.locator('.approval-detail').textContent())
  await page.screenshot({ path: `${OUT}phase-2-approval.png` })
  await openCard.getByRole('button', { name: 'Allow', exact: true }).click()
  await page.locator('.note', { hasText: 'Allowed' }).waitFor({ timeout: 60_000 })
  await openCard.waitFor({ timeout: 60_000 })
  console.log('second approval:', await openCard.locator('.approval-detail').textContent())
  await openCard.getByRole('button', { name: 'Deny' }).click()
  await headStatus(page).filter({ hasText: /Ready|Error/ }).waitFor({ timeout: 90_000 })
  await page.screenshot({ path: `${OUT}phase-2-approvals-done.png` })
  console.log('resolutions:', await page.locator('.note').allTextContents())
} else if (mode === 'interrupt') {
  await startConversation(page, 'Write a 1500 word essay on the history of coffee. Plain text, no tools.')
  await page.locator('.bubble.streaming').waitFor({ timeout: 60_000 })
  const started = Date.now()
  await page.getByRole('button', { name: 'Stop' }).click()
  await headStatus(page).filter({ hasText: /Ready|Error|Waiting/ }).waitFor({ timeout: 30_000 })
  console.log(`stopped in ${((Date.now() - started) / 1000).toFixed(1)}s, status now: ${await headStatus(page).textContent()}`)
  await page.screenshot({ path: `${OUT}phase-2-interrupt.png` })
} else if (mode === 'switch') {
  await startConversation(page, 'Use the Write tool to create notes.txt containing the word alpha. Reply briefly.')
  await headStatus(page).filter({ hasText: /Ready|Error/ }).waitFor({ timeout: 120_000 })
  await page.getByRole('button', { name: 'Agent settings' }).click()
  const panel = page.getByRole('dialog', { name: 'Agent settings' })
  await panel.getByRole('radio', { name: 'Codex' }).click()
  await panel.getByLabel('Model').fill('gpt-5.6-luna')
  await switchWithHandoff(panel)
  await page.locator('.note', { hasText: 'Handed over from Claude Code to Codex' }).waitFor({ timeout: 15_000 })
  await messageBox(page).fill('Without using any tools: which file did the previous agent create, and what word is in it? One line.')
  await messageBox(page).press('Enter')
  await page.waitForTimeout(1500)
  await headStatus(page).filter({ hasText: /Ready|Error/ }).waitFor({ timeout: 180_000 })
  const answer = (await page.locator('.bubble.agent').allTextContents()).at(-1) ?? ''
  console.log('codex answered:', answer)
  console.log(/notes\.txt/i.test(answer) && /alpha/i.test(answer) ? 'SWITCH PASS' : 'SWITCH FAIL')
  await page.screenshot({ path: `${OUT}phase-3-switch.png` })
} else {
  throw new Error(`unknown mode ${mode}`)
}
await browser.close()
