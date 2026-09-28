// Browser proof for UI gates. Drives the real cockpit page in headless Chrome.
//   tsx scripts/proof-ui.ts parallel <projectDir>   start 3 threads, wait for all Done
//   tsx scripts/proof-ui.ts reload                  after a server restart, confirm threads persisted
import { mkdirSync } from 'node:fs'
import { chromium, type Page } from 'playwright-core'

const BASE = process.env.COCKPIT_URL ?? 'http://127.0.0.1:4317'
const OUT = new URL('../docs/proof/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })

async function startThread(page: Page, projectDir: string, prompt: string): Promise<void> {
  await page.getByRole('button', { name: 'New thread' }).click()
  await page.getByLabel('Project folder').fill(projectDir)
  await page.getByLabel('Model').fill('haiku')
  const box = page.getByPlaceholder('What should the agent do?')
  await box.fill(prompt)
  await box.press('Enter')
  await page.getByRole('heading', { level: 1, name: prompt.slice(0, 20) }).waitFor({ timeout: 15_000 }).catch(() => undefined)
}

async function chipCounts(page: Page): Promise<Record<string, number>> {
  return page.$$eval('.sidebar .chip', (chips) =>
    chips.reduce<Record<string, number>>((acc, chip) => ({ ...acc, [chip.textContent ?? '']: (acc[chip.textContent ?? ''] ?? 0) + 1 }), {}),
  )
}

const [mode, projectDir] = process.argv.slice(2)
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } })
await page.goto(BASE)

if (mode === 'parallel') {
  if (!projectDir) throw new Error('usage: proof-ui.ts parallel <projectDir>')
  await startThread(page, projectDir, 'List three prime numbers, one per line.')
  await startThread(page, projectDir, 'Name two colours of the rainbow, comma separated.')
  await startThread(page, projectDir, 'Write a four word sentence about coffee.')
  await page.waitForTimeout(1500)
  const during = await chipCounts(page)
  console.log('while running:', during)
  await page.screenshot({ path: `${OUT}phase-1-running.png` })
  await page.waitForFunction(
    () => [...document.querySelectorAll('.sidebar .chip')].filter((c) => c.textContent === 'Done').length >= 3,
    undefined,
    { timeout: 180_000 },
  )
  console.log('finished:', await chipCounts(page))
  await page.screenshot({ path: `${OUT}phase-1-done.png` })
} else if (mode === 'reload') {
  await page.waitForSelector('.sidebar .chip')
  console.log('after restart:', await chipCounts(page))
  await page.locator('.thread-row').first().click()
  await page.waitForSelector('.bubble.agent')
  console.log('opened thread shows', await page.locator('.bubble').count(), 'messages')
  await page.screenshot({ path: `${OUT}phase-1-after-restart.png` })
} else if (mode === 'approvals') {
  if (!projectDir) throw new Error('usage: proof-ui.ts approvals <projectDir>')
  await startThread(
    page,
    projectDir,
    'Use the Write tool to create allowed.txt containing yes. Then use the Write tool to create denied.txt containing no. Do not ask questions.',
  )
  const openCard = page.locator('.approval.open')
  await openCard.waitFor({ timeout: 60_000 })
  console.log('first approval:', await openCard.locator('code').textContent())
  await page.screenshot({ path: `${OUT}phase-2-approval.png` })
  await openCard.getByRole('button', { name: 'Allow', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.approval').length >= 2, undefined, { timeout: 60_000 })
  await openCard.waitFor({ timeout: 60_000 })
  console.log('second approval:', await openCard.locator('code').textContent())
  await openCard.getByRole('button', { name: 'Deny' }).click()
  await page.locator('.thread-head .chip', { hasText: /Done|Error/ }).waitFor({ timeout: 90_000 })
  await page.screenshot({ path: `${OUT}phase-2-approvals-done.png` })
  console.log('resolutions:', await page.locator('.meta-line').allTextContents())
} else if (mode === 'interrupt') {
  if (!projectDir) throw new Error('usage: proof-ui.ts interrupt <projectDir>')
  await startThread(page, projectDir, 'Write a 1500 word essay on the history of coffee. Plain text, no tools.')
  await page.locator('.bubble.streaming').waitFor({ timeout: 60_000 })
  const started = Date.now()
  await page.getByRole('button', { name: 'Stop' }).click()
  await page.locator('.thread-head .chip', { hasText: /Done|Error|Waiting/ }).waitFor({ timeout: 30_000 })
  const status = await page.locator('.thread-head .chip').textContent()
  console.log(`stopped in ${((Date.now() - started) / 1000).toFixed(1)}s, status now: ${status}`)
  await page.screenshot({ path: `${OUT}phase-2-interrupt.png` })
} else {
  throw new Error(`unknown mode ${mode}`)
}
await browser.close()
