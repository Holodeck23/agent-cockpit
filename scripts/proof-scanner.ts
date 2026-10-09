// Packaged proof for D12, the scanner signature (acceptance POL-01): KITT's lamp row in the composer.
// 73 small lamps across the composer's full inside width, a constant-speed sweep with a tail behind
// it (red, then amber toward its far end), the tail drawn into the end lamp at each reversal.
// Motion is checked by pausing every scanner animation and seeking to exact points of the 3.2 s
// cycle, so the frames are deterministic. Each frame is read from the lamps' computed brightness and
// compared, lamp by lamp, with web/src/scanner-model.ts (the same arithmetic in plain numbers), and
// again from the rendered pixels. Also: idle and working, light, reduce motion, layout.
// Stand-in agent only (scripts/fixtures/wave65-agent: "work" holds a turn for 12 s), no provider usage.
// Usage: npm run package:proof, then COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:scanner
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { LAMPS, STEP, levels as modelLevels } from '../web/src/scanner-model.ts'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { messageBox, openProject, setTheme } from './lib/ui.ts'

const { check, finish } = checker()
const root = mkdtempSync(join(tmpdir(), 'cockpit-scanner-proof-'))
const project = join(root, 'app')
mkdirSync(project)
mkdirSync(PROOF_DIR, { recursive: true })
const app = await launchPackagedApp({ COCKPIT_HOME: join(root, 'state'), COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/wave65-agent') })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(label: string, test: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await test().catch(() => false)) return true; await sleep(150) }
  console.log(`  (timed out waiting for ${label})`)
  return false
}

const CYCLE = 3200
const LIT = 0.05 // a lamp counts as lit above this brightness

/** Pauses every scanner animation at `percent` of the cycle (1 ms past, so no frame sits on a keyframe edge). */
const seek = (page: Page, percent: number): Promise<void> => page.evaluate(([p, cycle]) => {
  for (const a of document.getAnimations()) {
    if (a instanceof CSSAnimation && a.animationName.startsWith('scanner-')) { a.pause(); a.currentTime = ((p as number) / 100) * (cycle as number) + 1 }
  }
}, [percent, CYCLE] as const)
interface Drawn { readonly red: number[]; readonly amber: number[] }
/** What each lamp is drawing right now: the brighter of its two rows' red light, and the same for amber. */
// (No named helpers inside evaluate callbacks: tsx would wrap them in __name, which the page does not have.)
const drawn = (page: Page): Promise<Drawn> => page.evaluate(() => {
  const rows = [...document.querySelectorAll('.scanner-row')].map((row) => [...row.children])
  const count = rows[0]!.length
  const red: number[] = []
  const amber: number[] = []
  for (let k = 0; k < count; k++) {
    red.push(Math.max(...rows.map((r) => parseFloat(getComputedStyle(r[k]!).opacity) * parseFloat(getComputedStyle(r[k]!, '::before').opacity))))
    amber.push(Math.max(...rows.map((r) => parseFloat(getComputedStyle(r[k]!).opacity) * parseFloat(getComputedStyle(r[k]!, '::after').opacity))))
  }
  return { red, amber }
})
const scannerAnimations = (page: Page): Promise<number> => page.evaluate(() => document.getAnimations().filter((a) => a instanceof CSSAnimation && a.animationName.startsWith('scanner-') && a.playState === 'running').length)

/** The rendered strip: how red each pixel column is (red minus green, relative to the dimmest column), decoded in the page. */
async function columns(page: Page, png: Buffer): Promise<number[]> {
  const cols = await page.evaluate(async ([b64]) => {
    const bytes = Uint8Array.from(atob(b64 as string), (c) => c.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
    return Array.from({ length: width }, (_, x) => {
      let sum = 0
      let n = 0
      for (let y = Math.round(height * 0.25); y < Math.round(height * 0.75); y++) { sum += data[(y * width + x) * 4]! - data[(y * width + x) * 4 + 1]!; n++ }
      return sum / n
    })
  }, [png.toString('base64')] as const)
  const floor = Math.min(...cols)
  return cols.map((v) => v - floor)
}
const argmax = (v: readonly number[]): number => v.indexOf(Math.max(...v))
const lit = (v: readonly number[], floor = LIT): number => v.filter((x) => x >= floor).length

const box = async (page: Page, selector: string) => (await page.locator(selector).boundingBox())!
const startWork = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'New conversation' }).click()
  const fresh = page.getByRole('button', { name: 'Start fresh', exact: true })
  if (await fresh.waitFor({ timeout: 3000 }).then(() => true, () => false)) await fresh.click()
  await messageBox(page).fill('work')
  await messageBox(page).press('Enter')
  await page.locator('.thread-head h1').waitFor()
}
const newConversation = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'New conversation' }).click()
  const fresh = page.getByRole('button', { name: 'Start fresh', exact: true })
  if (await fresh.waitFor({ timeout: 3000 }).then(() => true, () => false)) await fresh.click()
  await messageBox(page).waitFor()
}
const isWorkingCard = (page: Page) => page.locator('.composer-card').evaluate((el) => el.classList.contains('working'))

const FRAMES: readonly { readonly at: number; readonly note: string }[] = [
  { at: 20, note: 'sweeping right, tail on the left' },
  { at: 40, note: 'approaching the right end' },
  { at: 45, note: 'head at the right end, full tail' },
  { at: 46, note: 'contracting' },
  { at: 47, note: 'contracting' },
  { at: 48, note: 'contracting' },
  { at: 49, note: 'contracting' },
  { at: 50, note: 'all light in the end lamp' },
  { at: 52, note: 'reversed: new tail begins on the right' },
  { at: 55, note: 'new tail extending' },
  { at: 60, note: 'full tail again' },
  { at: 70, note: 'sweeping left, tail on the right' },
  { at: 90, note: 'approaching the left end' },
  { at: 95, note: 'head at the left end, full tail' },
  { at: 96, note: 'contracting' },
  { at: 97, note: 'contracting' },
  { at: 98, note: 'contracting' },
  { at: 99, note: 'contracting' },
  { at: 0, note: 'all light in the end lamp' },
  { at: 2, note: 'reversed: new tail begins on the left' },
  { at: 5, note: 'new tail extending' },
  { at: 10, note: 'full tail again' },
]

const page = await app.firstWindow()
try {
  page.setDefaultTimeout(15_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await openProject(page, project, 'Scanner')
  await setTheme(page, 'Dark')

  // ---------- structure, layout, idle ----------
  await newConversation(page)
  const scanner = page.locator('.composer-card .scanner')
  check('POL-01 two rows of lamps, 73 each, inside the composer card', await page.locator('.composer-card > .scanner > .scanner-row').count() === 2
    && await page.locator('.scanner-row:first-child > .scanner-lamp').count() === LAMPS && await page.locator('.scanner-row:last-child > .scanner-lamp').count() === LAMPS)
  const card = await box(page, '.composer-card')
  const strip = await box(page, '.scanner')
  check('POL-01 the scanner is as wide as the composer\'s inside (less the corner radius each side)',
    Math.abs(strip.width - (card.width - 2 - 28)) < 1.5 && Math.abs((strip.x + strip.width / 2) - (card.x + card.width / 2)) < 1, `${strip.width} in ${card.width}`)
  const controlsBottom = await page.locator('.composer-foot').evaluate((foot) => Math.max(...[...foot.children].map((c) => c.getBoundingClientRect().bottom)))
  check('POL-01 a 6 px recess inside the card\'s bottom padding, clear of every control',
    strip.height === 6 && strip.y + strip.height <= card.y + card.height && strip.y >= controlsBottom - 0.5, `controls end ${controlsBottom}, strip ${strip.y}-${strip.y + strip.height}`)
  const noLayout = await page.evaluate(() => {
    const cardEl = document.querySelector('.composer-card')!
    const before = JSON.stringify(cardEl.getBoundingClientRect())
    const el = document.querySelector('.scanner') as HTMLElement
    el.style.display = 'none'
    const after = JSON.stringify(cardEl.getBoundingClientRect())
    el.style.display = ''
    return before === after
  })
  check('POL-01 the composer is the same size with and without the scanner', noLayout)
  check('POL-01 the scanner takes no pointer events and nothing sits under it',
    await page.evaluate(() => {
      const el = document.querySelector('.scanner')!
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return getComputedStyle(el).pointerEvents === 'none'
        && [...el.querySelectorAll('.scanner-row, .scanner-lamp')].every((l) => getComputedStyle(l).pointerEvents === 'none' && getComputedStyle(l, '::before').pointerEvents === 'none')
        && !!hit && !el.contains(hit)
    }))
  check('POL-01 idle: the placeholder sweep is retired', (await messageBox(page).evaluate((el) => el.getAnimations().length)) === 0)
  const timing = (p: Page) => p.evaluate(() => {
    const s = getComputedStyle(document.querySelector('.scanner-row:first-child .scanner-lamp:nth-child(30)')!, '::before')
    return { name: s.animationName, duration: s.animationDuration, delay: s.animationDelay, strip: parseFloat(getComputedStyle(document.querySelector('.scanner')!).opacity) }
  })
  const idleTiming = await timing(page)
  check('POL-01 idle: the lamps run a 3.2 s cycle', idleTiming.duration === '3.2s' && idleTiming.name === 'scanner-flash', JSON.stringify(idleTiming))
  check('POL-01 idle: the scanner is running, not paused', (await scannerAnimations(page)) >= LAMPS)
  await sleep(400)
  const startedA = await page.evaluate(() => document.getAnimations().find((a) => a instanceof CSSAnimation && a.animationName === 'scanner-flash')?.startTime ?? -1)
  await messageBox(page).fill('typing does not touch the scanner')
  await messageBox(page).press('Backspace')
  const startedB = await page.evaluate(() => document.getAnimations().find((a) => a instanceof CSSAnimation && a.animationName === 'scanner-flash')?.startTime ?? -2)
  check('POL-01 typing in the composer leaves the scanner running (no restart)', startedA === startedB, `${startedA} vs ${startedB}`)
  await messageBox(page).fill('')

  // ---------- motion, frame by frame ----------
  const rendered: Buffer[] = []
  const litAt: Record<number, number> = {}
  let worstDrift = 0
  for (const frame of FRAMES) {
    await seek(page, frame.at)
    const now = await drawn(page)
    const expected = modelLevels(frame.at + 1 / 32) // the seek is 1 ms past the frame
    const drift = Math.max(...now.red.map((v, k) => Math.abs(v - expected[k]!)))
    worstDrift = Math.max(worstDrift, drift)
    const png = await scanner.screenshot()
    rendered.push(png)
    const cols = await columns(page, png)
    const label = `${frame.at}%`
    const head = argmax(expected)
    check(`POL-01 ${label} (${frame.note}): the page draws what the model says`, drift <= 0.06 && argmax(now.red) === head, `head ${argmax(now.red)} vs ${head}, worst lamp off by ${drift.toFixed(3)}`)
    // The pixels agree with the head's position, to within two lamps.
    const lampWidth = cols.length / LAMPS
    check(`POL-01 ${label}: the brightest pixels sit on the head`, Math.abs(argmax(cols) / lampWidth - (head + 0.5)) <= 2.5, `column ${argmax(cols)} of ${cols.length}`)
    litAt[frame.at] = lit(now.red)
  }
  check('POL-01 no frame is further than 0.06 from the model', worstDrift <= 0.06, worstDrift.toFixed(3))

  // The tail is on the trailing side: going right it is to the left of the head, going left to the right.
  for (const [at, side] of [[20, 'left'], [70, 'right']] as const) {
    await seek(page, at)
    const now = await drawn(page)
    const head = argmax(now.red)
    const behind = side === 'left' ? now.red.slice(0, head) : now.red.slice(head + 1)
    const ahead = side === 'left' ? now.red.slice(head + 1) : now.red.slice(0, head)
    check(`POL-01 ${at}%: the tail is on the ${side}; ahead of the head only its 40 ms lead-in`, lit(behind) >= 10 && lit(ahead) <= 2, `${lit(behind)} lamps behind, ${lit(ahead)} ahead`)
  }
  // Colour: red at the head, amber toward the far end of the tail.
  await seek(page, 20)
  const colour = await drawn(page)
  const head20 = argmax(colour.red)
  const far = colour.amber.findIndex((v) => v >= 0.3)
  check('POL-01 the head is red, the far end of the tail goes amber',
    colour.amber[head20]! < 0.05 && far >= 0 && far < head20 - 6 && colour.red[far]! < colour.red[head20]! * 0.35, `head ${head20}, amber from lamp ${far}`)

  // Constant speed: the head is on lamp i at i × 0.625% going right and 95% − i × 0.625% going left.
  let steady = true
  for (let i = 0; i < LAMPS; i++) {
    await seek(page, i * STEP)
    const a = argmax((await drawn(page)).red)
    await seek(page, 95 - i * STEP)
    const b = argmax((await drawn(page)).red)
    // (The end lamp burns at 1.0 against the head's 0.9, so it outshines the next lamp for one step after a reversal.)
    if ((i !== 1 && a !== i) || (i !== LAMPS - 2 && b !== i)) { steady = false; console.log(`  (lamp ${i}: right ${a}, left ${b})`) }
  }
  check('POL-01 the bright point moves one lamp every 20 ms, both ways (constant speed)', steady)
  // The tail is drawn in, then grows again, at each end.
  const run = (...ats: number[]) => ats.map((at) => litAt[at]!)
  const rightIn = run(45, 46, 47, 48, 49, 50)
  const leftIn = run(95, 96, 97, 98, 99, 0)
  const shrinks = (c: number[]) => c.every((v, i) => i === 0 || v < c[i - 1]!)
  const grows = (c: number[]) => c.every((v, i) => i === 0 || v > c[i - 1]!)
  check('POL-01 right end: the lit region shortens into the end lamp, then grows behind the returning head',
    shrinks(rightIn.slice(0, 5)) && rightIn.at(-1)! <= 2 && grows(run(50, 52, 55, 60)), `${rightIn} then ${run(50, 52, 55, 60)}`)
  check('POL-01 left end: the same, mirrored', shrinks(leftIn.slice(0, 5)) && leftIn.at(-1)! <= 2 && grows(run(0, 2, 5, 10)), `${leftIn} then ${run(0, 2, 5, 10)}`)
  // No flicker or jump: sample the whole cycle every 20 ms; no lamp moves more than half its range in one sample.
  let worst = 0
  let previous: number[] | undefined
  await seek(page, 0)
  const first = (await drawn(page)).red
  for (let ms = 0; ms <= CYCLE; ms += 20) {
    await seek(page, ((ms - 1) / CYCLE) * 100)
    const now = (await drawn(page)).red
    if (previous) worst = Math.max(worst, ...now.map((v, k) => Math.abs(v - previous![k]!)))
    previous = now
  }
  check('POL-01 no lamp jumps between 20 ms samples through a whole cycle', worst <= 0.5, `largest step ${worst.toFixed(2)}`)
  await seek(page, 99.999)
  const seam = (await drawn(page)).red
  check('POL-01 the cycle repeats without a seam', seam.every((v, k) => Math.abs(v - first[k]!) < 0.08))

  // A filmstrip of the frames above, enlarged, for a person to read.
  const sheet = await page.evaluate(async ([frames, labels]) => {
    const bitmaps = await Promise.all((frames as string[]).map(async (b64) => createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' }))))
    const rowH = bitmaps[0]!.height + 14
    const canvas = new OffscreenCanvas(bitmaps[0]!.width + 380, rowH * bitmaps.length)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#111'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.font = '20px sans-serif'
    ctx.fillStyle = '#ccc'
    bitmaps.forEach((b, i) => {
      ctx.drawImage(b, 0, i * rowH + 7)
      ctx.fillText((labels as string[])[i]!, b.width + 12, i * rowH + 7 + b.height * 0.8)
    })
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    const buf = new Uint8Array(await blob.arrayBuffer())
    let s = ''
    for (const byte of buf) s += String.fromCharCode(byte)
    return btoa(s)
  }, [rendered.map((b) => b.toString('base64')), FRAMES.map((f) => `${f.at}%  ${f.note}`)] as const)
  writeFileSync(join(PROOF_DIR, 'scanner-filmstrip.png'), Buffer.from(sheet, 'base64'))
  await page.screenshot({ path: join(PROOF_DIR, 'scanner-dark-idle.png') })

  // ---------- working: brighter, never faster ----------
  await startWork(page)
  check('POL-01 working: the composer is marked working', await until('working', () => isWorkingCard(page)))
  await sleep(600) // the brightness change is a 400 ms fade
  const workingTiming = await timing(page)
  check('POL-01 working: the same timing, name and delays as idle', workingTiming.name === idleTiming.name && workingTiming.duration === idleTiming.duration && workingTiming.delay === idleTiming.delay)
  check('POL-01 working: brighter than idle', workingTiming.strip > idleTiming.strip && workingTiming.strip === 1, `${idleTiming.strip} → ${workingTiming.strip}`)
  check('POL-01 working: the same lamps animating', (await scannerAnimations(page)) >= LAMPS)
  const w1 = await scanner.screenshot()
  await sleep(500)
  const w2 = await scanner.screenshot()
  check('POL-01 working: the scanner is moving', !w1.equals(w2))
  await page.screenshot({ path: join(PROOF_DIR, 'scanner-dark-working.png') })
  await page.setViewportSize({ width: 480, height: 760 })
  await sleep(250)
  const narrowCard = await box(page, '.composer-card')
  const narrow = await box(page, '.scanner')
  check('POL-01 narrow window: the strip follows the composer\'s width', Math.abs(narrow.width - (narrowCard.width - 2 - 28)) < 1.5 && narrow.width > 150, `${narrow.width} in ${narrowCard.width}`)
  check('POL-01 narrow window: nothing overflows sideways', await page.locator('.composer-foot').evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
  await page.screenshot({ path: join(PROOF_DIR, 'scanner-dark-narrow.png') })
  await page.setViewportSize({ width: 1280, height: 800 })
  check('POL-01 ended: the turn ends and the scanner stays, back to idle brightness', await until('turn end', async () => !(await isWorkingCard(page)), 30_000))
  await sleep(600)
  check('POL-01 ended: idle brightness again, and still running', parseFloat(await scanner.evaluate((el) => getComputedStyle(el).opacity)) < 1 && (await scannerAnimations(page)) >= LAMPS)

  // ---------- light: flat lamps, no glow ----------
  await setTheme(page, 'Light')
  await newConversation(page)
  const lightInk = await page.evaluate(() => {
    const probe = document.createElement('span')
    document.querySelector('.scanner')!.appendChild(probe)
    probe.style.color = 'var(--scanner-glow)'
    const glow = getComputedStyle(probe).color
    probe.style.color = 'var(--scanner-hot)'
    const hot = getComputedStyle(probe).color
    probe.style.color = 'var(--scanner-warm-glow)'
    const warmGlow = getComputedStyle(probe).color
    probe.remove()
    return { glow, hot, warmGlow }
  })
  const clear = (c: string) => /(^rgba\(.*, 0\)$|transparent)/.test(c)
  check('POL-01 light: no bloom and no hot core', clear(lightInk.glow) && clear(lightInk.hot) && clear(lightInk.warmGlow), JSON.stringify(lightInk))
  await seek(page, 20)
  const lightA = await scanner.screenshot()
  await seek(page, 30)
  const lightB = await scanner.screenshot()
  check('POL-01 light: the lamps still sweep', !lightA.equals(lightB))
  await page.screenshot({ path: join(PROOF_DIR, 'scanner-light-idle.png') })

  // ---------- reduce motion ----------
  await setTheme(page, 'Dark')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await newConversation(page)
  check('POL-01 reduce motion: no scanner animation runs', (await scannerAnimations(page)) === 0)
  const still1 = await scanner.screenshot()
  await sleep(700)
  const still2 = await scanner.screenshot()
  const stillCols = await columns(page, still2)
  const mid = stillCols.length / 2
  check('POL-01 reduce motion: a still accent in the middle of the row, nothing at the ends',
    still1.equals(still2) && Math.max(...stillCols.slice(mid - 20, mid + 20)) > 20 && Math.max(...stillCols.slice(0, 40)) < 8 && Math.max(...stillCols.slice(-40)) < 8)
  await page.screenshot({ path: join(PROOF_DIR, 'scanner-reduced.png') })
  await page.emulateMedia({ reducedMotion: null })
} catch (err) {
  check('proof ran to the end', false, err instanceof Error ? err.message.split('\n')[0] : String(err))
  await page.screenshot({ path: join(PROOF_DIR, 'scanner-failure.png') }).catch(() => undefined)
} finally {
  await app.close()
}
finish('proof:scanner')
