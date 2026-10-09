// Antigravity images, LIVE: the real `agy` (its image-generator subagent), PACKAGED app.
//   A  ask for a picture → an image appears inline in the conversation, decodes, and is a real file.
//   B  a text-only follow-up → the same image is not shown again.
// Uses a little provider usage. Usage: npm run package:proof, wait a minute (XProtect), then
//   COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:antigravity-images-live
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR } from './lib/launch-app.ts'
import { chooseAgent, headStatus, messageBox, openProject, startConversation } from './lib/ui.ts'

const { check, finish } = checker()
mkdirSync(PROOF_DIR, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const working = async (page: Page): Promise<boolean> => /Working|Starting/.test((await headStatus(page).textContent().catch(() => '')) ?? '')
async function settle(page: Page, ms = 300_000): Promise<void> {
  const end = Date.now() + ms
  let idleSince = 0
  while (Date.now() < end) {
    if (await working(page)) idleSince = 0
    else if (!idleSince) idleSince = Date.now()
    else if (Date.now() - idleSince > 4_000) return
    await sleep(400)
  }
  console.log('  (timed out waiting for the turn to end)')
}
const shown = (page: Page): Promise<Array<{ ok: boolean; w: number }>> =>
  page.locator('.conversation-image img').evaluateAll((imgs) => imgs.map((i) => ({ ok: (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0, w: (i as HTMLImageElement).naturalWidth })))

const root = mkdtempSync(join(tmpdir(), 'cockpit-agy-images-'))
const project = join(root, 'picture-project')
mkdirSync(project)
writeFileSync(join(project, 'README.md'), '# scratch\n')
const app = await launchPackagedApp({ COCKPIT_HOME: join(root, 'state') })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await openProject(page, project, 'Picture project')
  await chooseAgent(page, { agent: 'antigravity', permissions: 'manual' })
  await startConversation(page, 'Generate an image of a plain red circle on a white background. Reply with one short line.')
  await settle(page)
  const a = await shown(page)
  await page.screenshot({ path: join(PROOF_DIR, 'antigravity-images-live-A.png') })
  check('A: an image appears inline after the turn', a.length === 1, `${a.length} image(s)`)
  const badge = Number(await page.locator('.activity-badge').first().innerText().catch(() => '0'))
  if (await page.getByRole('button', { name: 'Activity' }).getAttribute('aria-expanded') !== 'true') await page.getByRole('button', { name: 'Activity' }).click()
  const pane = await page.getByRole('complementary', { name: 'Activity' }).innerText().catch(() => '')
  await page.screenshot({ path: join(PROOF_DIR, 'antigravity-images-live-activity.png') })
  check('A: the turn lists its steps in Activity, the image request among them', badge >= 1 && /subagent|Image Generator/i.test(pane), `${badge} step(s): ${pane.replace(/\s+/g, ' ').slice(0, 160)}`)
  check('A: it decodes (real pixels, not a broken link)', a.length >= 1 && a.every((i) => i.ok), JSON.stringify(a))
  const before = a.length
  await messageBox(page).fill('Thanks. Reply with the single word: ok')
  await messageBox(page).press('Enter')
  await sleep(1_500)
  await settle(page)
  const b = await shown(page)
  await page.screenshot({ path: join(PROOF_DIR, 'antigravity-images-live-B.png') })
  check('B: a text-only follow-up does not show the image again', b.length === before, `${before} → ${b.length}`)
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
} finally {
  await app.close().catch(() => undefined)
}
finish('proof:antigravity-images-live')
