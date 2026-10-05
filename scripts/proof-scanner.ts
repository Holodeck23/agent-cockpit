// Packaged proof for D12, the scanner signature (acceptance POL-01): the idle placeholder sweep, the
// edge scanner while a turn runs and its end, reduce motion, light and dark, a narrow window.
// Stand-in agent only (scripts/fixtures/wave65-agent: "work" holds a turn for 12 s), no provider usage.
// Usage: npm run package:proof, then COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:scanner
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { messageBox, openProject, setTheme } from './lib/ui.ts'

const { check, finish } = checker()
const root = mkdtempSync(join(tmpdir(), 'cockpit-scanner-proof-'))
const project = join(root, 'app')
mkdirSync(project)
mkdirSync(PROOF_DIR, { recursive: true })
const app = await launchPackagedApp({ COCKPIT_HOME: join(root, 'state'), COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/wave65-agent') })
const shot = (page: Page, name: string) => page.screenshot({ path: join(PROOF_DIR, `scanner-${name}.png`) })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(label: string, test: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await test().catch(() => false)) return true; await sleep(150) }
  console.log(`  (timed out waiting for ${label})`)
  return false
}

type Box = { x: number; y: number; width: number; height: number }
/** Per-row redness of a screenshot: the most any pixel's red exceeds its green and blue. */
interface Redness { readonly rows: number[]; readonly strong: number; readonly dpr: number }

/** Decodes the PNG inside the page (no image library in this repo) and measures how red it is. */
async function redness(page: Page, png: Buffer): Promise<Redness> {
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
    const rows: number[] = []
    let strong = 0
    for (let y = 0; y < height; y++) {
      let max = 0
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        const red = data[i]! - Math.max(data[i + 1]!, data[i + 2]!)
        if (red > max) max = red
        if (red > 100) strong++
      }
      rows.push(max)
    }
    return { rows, strong, dpr: window.devicePixelRatio }
  }, png.toString('base64'))
}

const card = (page: Page) => page.locator('.composer-card')
const box = async (page: Page, selector: string): Promise<Box> => (await page.locator(selector).boundingBox())!
/** A strip over the composer's bottom edge: 6 px inside the card to 10 px below it. */
async function edgeStrip(page: Page): Promise<Buffer> {
  const b = await box(page, '.composer-card')
  return page.screenshot({ clip: { x: b.x, y: b.y + b.height - 6, width: b.width, height: 16 } })
}
/** Rows of an edge strip that lie at least `below` CSS px under the card's bottom edge. */
const rowsBelow = (r: Redness, below: number): number[] => r.rows.slice(Math.round((6 + below) * r.dpr))
const pseudo = (page: Page, which: '::before' | '::after') => card(page).evaluate((el, w) => {
  const s = getComputedStyle(el, w)
  return { content: s.content, animation: s.animationName }
}, which)
const textareaAnimations = (page: Page) => messageBox(page).evaluate((el) => el.getAnimations().map((a) => (a as CSSAnimation).animationName))

/** Placeholder frames for one full sweep period: some must show the red band, some must not. */
async function sweepFrames(page: Page, label: string): Promise<{ red: number; plain: number }> {
  const ta = await box(page, '.composer textarea')
  const width = await messageBox(page).evaluate((el) => parseFloat(getComputedStyle(el, '::placeholder').width) || 200)
  let red = 0
  let plain = 0
  let best: { strong: number; png: Buffer } = { strong: 0, png: Buffer.alloc(0) }
  for (let i = 0; i < 24; i++) {
    const png = await page.screenshot({ clip: { x: ta.x, y: ta.y, width: Math.min(ta.width, width + 40), height: Math.min(ta.height, 44) } })
    const { strong } = await redness(page, png)
    if (strong > 4) red++
    else plain++
    if (strong > best.strong) best = { strong, png }
    await sleep(200)
  }
  if (best.png.length) writeFileSync(join(PROOF_DIR, `scanner-${label}-sweep-frame.png`), best.png)
  return { red, plain }
}

/** WCAG contrast of the placeholder against the card along the whole sweep gradient (muted → red). */
// A plain string: tsx would otherwise wrap the named helpers in __name, which the page does not have.
const CONTRAST = `(() => {
  const el = document.querySelector('.composer-card')
  const probe = document.createElement('span')
  el.appendChild(probe)
  const rgb = (c) => c.match(/[0-9.]+/g).slice(0, 3).map(Number)
  const resolve = (v) => { probe.style.color = 'var(' + v + ')'; return rgb(getComputedStyle(probe).color) }
  const muted = resolve('--muted')
  const ink = resolve('--scanner-ink')
  probe.remove()
  const bg = rgb(getComputedStyle(el).backgroundColor)
  const lum = (c) => {
    const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }
  let min = Infinity
  for (let t = 0; t <= 1.0001; t += 0.1) min = Math.min(min, ratio(muted.map((m, i) => m + (ink[i] - m) * t), bg))
  return min
})()`
const placeholderContrast = (page: Page): Promise<number> => page.evaluate(CONTRAST) as Promise<number>

async function startWork(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New conversation' }).click()
  const fresh = page.getByRole('button', { name: 'Start fresh', exact: true })
  if (await fresh.waitFor({ timeout: 3000 }).then(() => true, () => false)) await fresh.click()
  await messageBox(page).fill('work')
  await messageBox(page).press('Enter')
  await page.locator('.thread-head h1').waitFor()
}
const isWorkingCard = (page: Page) => card(page).evaluate((el) => el.classList.contains('working'))

const page = await app.firstWindow()
try {
  page.setDefaultTimeout(15_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await openProject(page, project, 'Scanner')
  await setTheme(page, 'Dark')

  // ---------- dark: idle → working → ended ----------
  await page.getByRole('button', { name: 'New conversation' }).click()
  const fresh = page.getByRole('button', { name: 'Start fresh', exact: true })
  if (await fresh.waitFor({ timeout: 3000 }).then(() => true, () => false)) await fresh.click()
  await messageBox(page).waitFor()
  check('POL-01 idle: the placeholder sweep runs', (await textareaAnimations(page)).includes('scanner-placeholder'))
  check('POL-01 idle: no edge scanner', (await pseudo(page, '::after')).content === 'none')
  const darkIdle = await sweepFrames(page, 'dark-idle')
  check('POL-01 idle: a red pass crosses the placeholder, with plain frames between passes', darkIdle.red >= 1 && darkIdle.plain >= 1, `red ${darkIdle.red}, plain ${darkIdle.plain}`)
  const darkContrast = await placeholderContrast(page)
  check('POL-01 dark: the placeholder stays WCAG AA along the whole sweep', darkContrast >= 4.5, darkContrast.toFixed(2))
  await shot(page, 'dark-idle')

  await startWork(page)
  check('POL-01 working: the composer is marked working', await until('working', () => isWorkingCard(page)))
  const after = await pseudo(page, '::after')
  check('POL-01 working: the edge scanner animates', after.content !== 'none' && after.animation === 'scanner-edge', JSON.stringify(after))
  check('POL-01 working: the placeholder sweep pauses', !(await textareaAnimations(page)).includes('scanner-placeholder'))
  const w1 = await edgeStrip(page)
  await sleep(350)
  const w2 = await edgeStrip(page)
  check('POL-01 working: the scanner moves', !w1.equals(w2))
  const darkEdge = await redness(page, w2)
  check('POL-01 working: the edge shows red', darkEdge.strong > 10, `${darkEdge.strong} px`)
  check('POL-01 dark: the core glows below the edge', Math.max(...rowsBelow(darkEdge, 3)) > 30, `max ${Math.max(...rowsBelow(darkEdge, 3))}`)
  const working = { card: await box(page, '.composer-card'), textarea: await box(page, '.composer textarea'), send: await box(page, '.composer .send') }
  await shot(page, 'dark-working')
  await page.setViewportSize({ width: 700, height: 760 })
  await sleep(200)
  const narrowCard = await box(page, '.composer-card')
  const narrowSend = await box(page, '.composer .send')
  check('POL-01 narrow: the send button stays inside the composer', narrowSend.x + narrowSend.width <= narrowCard.x + narrowCard.width)
  check('POL-01 narrow: the composer row does not overflow', await page.locator('.composer-foot').evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
  check('POL-01 narrow: the scanner stays within the composer', await card(page).evaluate((el) => {
    const s = getComputedStyle(el, '::after')
    return parseFloat(s.width) <= el.clientWidth
  }))
  await shot(page, 'dark-working-narrow')
  await page.setViewportSize({ width: 1280, height: 800 })

  check('POL-01 ended: the scanner stops when the turn ends', await until('turn end', async () => !(await isWorkingCard(page)), 30_000))
  await page.getByText('Work done.').first().waitFor()
  check('POL-01 ended: no edge scanner left', (await pseudo(page, '::after')).content === 'none' && (await pseudo(page, '::before')).content === 'none')
  const ended = await redness(page, await edgeStrip(page))
  check('POL-01 ended: no red on the edge', ended.strong === 0, `${ended.strong} px`)
  const idle = { card: await box(page, '.composer-card'), textarea: await box(page, '.composer textarea'), send: await box(page, '.composer .send') }
  check('POL-01 no layout shift between working and idle', JSON.stringify(idle) === JSON.stringify(working), `${JSON.stringify(working)} vs ${JSON.stringify(idle)}`)
  check('POL-01 ended: the placeholder sweep resumes', await until('sweep back', async () => (await textareaAnimations(page)).includes('scanner-placeholder')))
  await shot(page, 'dark-ended')

  // ---------- light ----------
  await setTheme(page, 'Light')
  await page.getByRole('button', { name: 'New conversation' }).click()
  await messageBox(page).waitFor()
  const lightIdle = await sweepFrames(page, 'light-idle')
  check('POL-01 light idle: the red pass crosses the placeholder', lightIdle.red >= 1 && lightIdle.plain >= 1, `red ${lightIdle.red}, plain ${lightIdle.plain}`)
  const lightContrast = await placeholderContrast(page)
  check('POL-01 light: the placeholder stays WCAG AA along the whole sweep', lightContrast >= 4.5, lightContrast.toFixed(2))
  await shot(page, 'light-idle')
  await startWork(page)
  await until('working', () => isWorkingCard(page))
  await sleep(200)
  const l1 = await edgeStrip(page)
  await sleep(350)
  const l2 = await edgeStrip(page)
  check('POL-01 light working: the scanner moves', !l1.equals(l2))
  const lightEdge = await redness(page, l2)
  const lightRows = lightEdge.rows.filter((v) => v > 100).length / lightEdge.dpr
  check('POL-01 light: a thin line (at most 2 px)', lightEdge.strong > 10 && lightRows <= 2.5, `${lightRows} px tall`)
  check('POL-01 light: no glow below the edge', Math.max(...rowsBelow(lightEdge, 3)) < 20, `max ${Math.max(...rowsBelow(lightEdge, 3))}`)
  await shot(page, 'light-working')
  await page.setViewportSize({ width: 700, height: 760 })
  await sleep(200)
  await shot(page, 'light-working-narrow')
  await page.setViewportSize({ width: 1280, height: 800 })
  await until('turn end', async () => !(await isWorkingCard(page)), 30_000)
  await shot(page, 'light-ended')

  // ---------- reduce motion (dark) ----------
  await setTheme(page, 'Dark')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: 'New conversation' }).click()
  await messageBox(page).waitFor()
  check('POL-01 reduce motion idle: no placeholder sweep', (await textareaAnimations(page)).length === 0)
  check('POL-01 reduce motion idle: the placeholder is plain text', await messageBox(page).evaluate((el) => {
    const s = getComputedStyle(el, '::placeholder')
    return s.backgroundImage === 'none' && s.color !== 'rgba(0, 0, 0, 0)'
  }))
  await shot(page, 'reduced-idle')
  await startWork(page)
  await until('working', () => isWorkingCard(page))
  await sleep(200)
  const r = await pseudo(page, '::after')
  check('POL-01 reduce motion working: a line with no animation', r.content !== 'none' && r.animation === 'none', JSON.stringify(r))
  check('POL-01 reduce motion working: no glow', (await pseudo(page, '::before')).content === 'none')
  const r1 = await edgeStrip(page)
  await sleep(500)
  const r2 = await edgeStrip(page)
  check('POL-01 reduce motion working: the line is still', r1.equals(r2))
  check('POL-01 reduce motion working: the still line is red', (await redness(page, r2)).strong > 10)
  await shot(page, 'reduced-working')
  await until('turn end', async () => !(await isWorkingCard(page)), 30_000)
  check('POL-01 reduce motion ended: the line goes', (await pseudo(page, '::after')).content === 'none')
  await shot(page, 'reduced-ended')
  await page.emulateMedia({ reducedMotion: null })
} catch (err) {
  check('proof ran to the end', false, err instanceof Error ? err.message.split('\n')[0] : String(err))
  await shot(page, 'failure').catch(() => undefined)
} finally {
  await app.close()
}
finish('proof:scanner')
