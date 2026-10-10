// Packaged proof for Lumen's Working Light, the D12/POL-01 composer signature that replaced the
// scanner. The script name stays `proof:scanner` so the cumulative gate keeps its stable suite key.
// Stand-in agent only (scripts/fixtures/wave65-agent: "work" holds a turn for 12 s); no provider use.
// Usage: npm run package:proof, then COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:scanner
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { messageBox, openProject, setTheme } from './lib/ui.ts'

const { check, finish } = checker()
const root = mkdtempSync(join(tmpdir(), 'cockpit-working-light-proof-'))
const project = join(root, 'app')
mkdirSync(project)
mkdirSync(PROOF_DIR, { recursive: true })
const app = await launchPackagedApp({ COCKPIT_HOME: join(root, 'state'), COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/wave65-agent') })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const shot = (page: Page, name: string) => page.screenshot({ path: join(PROOF_DIR, `working-light-${name}.png`) })

async function until(label: string, test: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await test().catch(() => false)) return true
    await sleep(150)
  }
  console.log(`  (timed out waiting for ${label})`)
  return false
}

type Box = { x: number; y: number; width: number; height: number }
const box = async (page: Page, selector: string): Promise<Box> => (await page.locator(selector).boundingBox())!
const card = (page: Page) => page.locator('.composer-card')
const light = (page: Page) => page.locator('.composer-card .working-light')
const isWorking = (page: Page) => card(page).evaluate((node) => node.classList.contains('working'))
const lightStyle = (page: Page) => light(page).evaluate((node) => {
  const rootStyle = getComputedStyle(node)
  const driftStyle = getComputedStyle(node.querySelector('i')!)
  const coreStyle = getComputedStyle(node.querySelector('i')!, '::before')
  const cardStyle = getComputedStyle(node.closest('.composer-card')!)
  return {
    opacity: rootStyle.opacity,
    cardAnimation: cardStyle.animationName,
    driftAnimation: driftStyle.animationName,
    trackHeight: rootStyle.height,
    driftLeft: driftStyle.left,
    driftRight: driftStyle.right,
    background: coreStyle.backgroundImage,
    coreWidth: coreStyle.width,
    coreHeight: coreStyle.height,
  }
})
const geometry = async (page: Page) => ({
  card: await box(page, '.composer-card'),
  textarea: await box(page, '.composer textarea'),
  send: await box(page, '.composer .send'),
  light: await box(page, '.composer-card .working-light'),
})

async function newConversation(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New conversation' }).click()
  const fresh = page.getByRole('button', { name: 'Start fresh', exact: true })
  if (await fresh.waitFor({ timeout: 3000 }).then(() => true, () => false)) await fresh.click()
  await messageBox(page).waitFor()
}

async function submitWork(page: Page): Promise<void> {
  await messageBox(page).fill('work')
  await messageBox(page).press('Enter')
  await page.locator('.thread-head h1').waitFor()
  await until('working', () => isWorking(page))
}

async function startWork(page: Page): Promise<void> {
  await newConversation(page)
  await submitWork(page)
}

function sameLayout(a: Awaited<ReturnType<typeof geometry>>, b: Awaited<ReturnType<typeof geometry>>): boolean {
  return JSON.stringify({ card: a.card, textarea: a.textarea, send: a.send, light: a.light })
    === JSON.stringify({ card: b.card, textarea: b.textarea, send: b.send, light: b.light })
}

const page = await app.firstWindow()
try {
  page.setDefaultTimeout(15_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await openProject(page, project, 'Working Light')
  await setTheme(page, 'Dark')

  // ---------- dark: idle → working → ended ----------
  await newConversation(page)
  const idleStyle = await lightStyle(page)
  check('POL-01 idle: one Working Light is mounted but invisible', await light(page).count() === 1 && idleStyle.opacity === '0', JSON.stringify(idleStyle))
  check('POL-01 idle: the hidden Working Light does not animate', idleStyle.driftAnimation === 'none' && idleStyle.cardAnimation === 'none', JSON.stringify(idleStyle))
  check('POL-01 the glow reaches but cannot cross the composer track ends', idleStyle.trackHeight === '2px' && idleStyle.driftLeft === '80px' && idleStyle.driftRight === '80px'
    && idleStyle.coreWidth === '160px' && idleStyle.coreHeight === '8px', JSON.stringify(idleStyle))
  check('POL-01 the light core is a soft radial gradient', idleStyle.background.includes('radial-gradient'), idleStyle.background)
  await shot(page, 'dark-idle')

  await submitWork(page)
  await sleep(500)
  check('POL-01 working: the composer is marked working', await isWorking(page))
  const workingStyle = await lightStyle(page)
  check('POL-01 working: the light and restrained halo animate', workingStyle.opacity === '1' && workingStyle.driftAnimation === 'working-drift' && workingStyle.cardAnimation === 'working-halo', JSON.stringify(workingStyle))
  const frame1 = await light(page).screenshot()
  await sleep(400)
  const frame2 = await light(page).screenshot()
  check('POL-01 working: the light visibly moves', !frame1.equals(frame2))
  const working = await geometry(page)
  check('POL-01 working: the light stays inside the composer', working.light.x >= working.card.x && working.light.x + working.light.width <= working.card.x + working.card.width && working.light.height === 2, JSON.stringify(working))
  await shot(page, 'dark-working')

  await page.setViewportSize({ width: 700, height: 760 })
  await sleep(200)
  const narrow = await geometry(page)
  check('POL-01 narrow: controls and light stay inside the composer', narrow.send.x + narrow.send.width <= narrow.card.x + narrow.card.width
    && narrow.light.x >= narrow.card.x && narrow.light.x + narrow.light.width <= narrow.card.x + narrow.card.width)
  check('POL-01 narrow: the composer row does not overflow', await page.locator('.composer-foot').evaluate((node) => node.scrollWidth <= node.clientWidth + 1))
  await shot(page, 'dark-working-narrow')
  await page.setViewportSize({ width: 1280, height: 800 })

  check('POL-01 ended: the turn ends', await until('turn end', async () => !(await isWorking(page)), 30_000))
  await page.getByText('Work done.').first().waitFor()
  await sleep(500)
  const endedStyle = await lightStyle(page)
  check('POL-01 ended: the light is invisible and motion stops', Number(endedStyle.opacity) <= 0.001 && endedStyle.driftAnimation === 'none' && endedStyle.cardAnimation === 'none', JSON.stringify(endedStyle))
  check('POL-01 ended: the signature caused no layout shift', sameLayout(working, await geometry(page)))
  await shot(page, 'dark-ended')

  // ---------- light theme ----------
  await setTheme(page, 'Light')
  await startWork(page)
  await sleep(500)
  const lightFrame1 = await light(page).screenshot()
  await sleep(400)
  const lightFrame2 = await light(page).screenshot()
  check('POL-01 light theme: the same Working Light is visible and moving', (await lightStyle(page)).opacity === '1' && !lightFrame1.equals(lightFrame2))
  await shot(page, 'light-working')
  await until('light turn end', async () => !(await isWorking(page)), 30_000)

  // ---------- reduced motion ----------
  await setTheme(page, 'Dark')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await startWork(page)
  await sleep(500)
  const reducedStyle = await lightStyle(page)
  check('POL-01 reduced motion: neither the light nor halo animates', reducedStyle.driftAnimation === 'none' && reducedStyle.cardAnimation === 'none', JSON.stringify(reducedStyle))
  const still1 = await light(page).screenshot()
  await sleep(500)
  const still2 = await light(page).screenshot()
  check('POL-01 reduced motion: one still light rests at the centre', still1.equals(still2) && await light(page).evaluate((node) => getComputedStyle(node.querySelector('i')!).transform !== 'none'))
  await shot(page, 'reduced-working')
  await until('reduced-motion turn end', async () => !(await isWorking(page)), 30_000)
  await sleep(500)
  check('POL-01 reduced motion ended: the still light disappears', Number((await lightStyle(page)).opacity) <= 0.001)
  await page.emulateMedia({ reducedMotion: null })
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message.split('\n')[0] : String(error))
  await shot(page, 'failure').catch(() => undefined)
} finally {
  await app.close()
}
finish('proof:scanner (Working Light)')
