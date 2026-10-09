// Packaged proof for D12, the scanner signature (acceptance POL-01): KITT's lamp row in the composer.
// Ten lamps, a constant-speed sweep with a tail behind it, the tail drawn into the end lamp at each
// reversal. Motion is checked by pausing every scanner animation and seeking to exact points of the
// 3.2 s cycle, so the frames are deterministic; each frame is read twice, from the lamps' computed
// brightness and from the rendered pixels. Also: idle and working, light, reduce motion, layout.
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(label: string, test: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await test().catch(() => false)) return true; await sleep(150) }
  console.log(`  (timed out waiting for ${label})`)
  return false
}

const CYCLE = 3200
const LAMPS = 10
const LIT = 0.04 // a lamp counts as lit above this brightness (the model's faintest tail lamp is ~0.05)

/** Pauses every scanner animation at `frac` of the cycle (1 ms past, so no frame sits on a keyframe edge). */
const seek = (page: Page, frac: number): Promise<void> => page.evaluate(([f, cycle]) => {
  for (const a of document.getAnimations()) {
    if (a instanceof CSSAnimation && a.animationName.startsWith('scanner-')) { a.pause(); a.currentTime = (f as number) * (cycle as number) + 1 }
  }
}, [frac, CYCLE] as const)
/** Each lamp's own brightness right now: its cut layer times the brighter of its two passes. */
// (No named helpers inside evaluate callbacks: tsx would wrap them in __name, which the page does not have.)
const lampLevels = (page: Page): Promise<number[]> => page.evaluate(() => [...document.querySelectorAll('.scanner-lamp')].map((lamp) =>
  parseFloat(getComputedStyle(lamp).opacity) * Math.max(parseFloat(getComputedStyle(lamp, '::before').opacity), parseFloat(getComputedStyle(lamp, '::after').opacity))))
const scannerAnimations = (page: Page): Promise<number> => page.evaluate(() => document.getAnimations().filter((a) => a instanceof CSSAnimation && a.animationName.startsWith('scanner-') && a.playState === 'running').length)

/** The rendered strip: mean red of each lamp's centre columns, decoded in the page (no image library here). */
async function pixelLevels(page: Page, png: Buffer, channel: 'red' | 'redness' = 'red'): Promise<number[]> {
  const levels = await page.evaluate(async ([b64, lamps, redness]) => {
    const bytes = Uint8Array.from(atob(b64 as string), (c) => c.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
    const cell = width / (lamps as number)
    const span = Math.round(cell * 0.2)
    return Array.from({ length: lamps as number }, (_, k) => {
      let sum = 0
      let n = 0
      for (let y = Math.round(height * 0.25); y < Math.round(height * 0.75); y++) {
        for (let x = Math.round(cell * (k + 0.5)) - span; x <= Math.round(cell * (k + 0.5)) + span; x++) {
          const i = (y * width + x) * 4
          sum += redness ? data[i]! - Math.max(data[i + 1]!, data[i + 2]!) : data[i]!
          n++
        }
      }
      return sum / n
    })
  }, [png.toString('base64'), LAMPS, channel === 'redness'] as const)
  // Relative to the darkest lamp, so the recess and the glass over it do not count as light.
  const floor = Math.min(...levels)
  return levels.map((v) => v - floor)
}
const lit = (levels: readonly number[], floor = LIT): number[] => levels.flatMap((v, k) => (v >= floor ? [k] : []))
const argmax = (levels: readonly number[]): number => levels.indexOf(Math.max(...levels))
const same = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i])

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

// The frames of one cycle worth looking at: the head's lamp and the lit lamps, from the model in
// styles/scanner.css (a lamp step is 5% of the cycle; the contraction is 45–50% and 95–100%).
interface Frame { readonly at: number; readonly head: number; readonly lit: readonly number[]; readonly note: string }
const FRAMES: readonly Frame[] = [
  { at: 0.20, head: 4, lit: [1, 2, 3, 4], note: 'sweeping right, tail on the left' },
  { at: 0.40, head: 8, lit: [5, 6, 7, 8], note: 'approaching the right end' },
  { at: 0.45, head: 9, lit: [6, 7, 8, 9], note: 'head at the right end, full tail' },
  { at: 0.475, head: 9, lit: [7, 8, 9], note: 'contracting: farthest lamp out' },
  { at: 0.4875, head: 9, lit: [8, 9], note: 'contracting' },
  { at: 0.50, head: 9, lit: [9], note: 'all light in the end lamp' },
  { at: 0.55, head: 8, lit: [8, 9], note: 'reversed: new tail begins on the right' },
  { at: 0.60, head: 7, lit: [7, 8, 9], note: 'new tail extending' },
  { at: 0.65, head: 6, lit: [6, 7, 8, 9], note: 'full tail again' },
  { at: 0.70, head: 5, lit: [5, 6, 7, 8], note: 'sweeping left, tail on the right' },
  { at: 0.90, head: 1, lit: [1, 2, 3, 4], note: 'approaching the left end' },
  { at: 0.95, head: 0, lit: [0, 1, 2, 3], note: 'head at the left end, full tail' },
  { at: 0.975, head: 0, lit: [0, 1, 2], note: 'contracting' },
  { at: 0.9875, head: 0, lit: [0, 1], note: 'contracting' },
  { at: 0.0, head: 0, lit: [0], note: 'all light in the end lamp' },
  { at: 0.05, head: 1, lit: [0, 1], note: 'reversed: new tail begins on the left' },
  { at: 0.10, head: 2, lit: [0, 1, 2], note: 'new tail extending' },
  { at: 0.15, head: 3, lit: [0, 1, 2, 3], note: 'full tail again' },
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
  check('POL-01 the scanner is part of the composer card, ten lamps', await page.locator('.composer-card > .scanner > .scanner-lamp').count() === LAMPS)
  const card = await box(page, '.composer-card')
  const strip = await box(page, '.scanner')
  check('POL-01 a 300 px strip, centred in the card', Math.abs(strip.width - 300) < 0.5 && Math.abs((strip.x + strip.width / 2) - (card.x + card.width / 2)) < 1, `${strip.width} wide`)
  const controlsBottom = await page.locator('.composer-foot').evaluate((foot) => Math.max(...[...foot.children].map((c) => c.getBoundingClientRect().bottom)))
  check('POL-01 a 6 px recess inside the card\'s bottom padding, clear of every control',
    strip.height === 6 && strip.y + strip.height <= card.y + card.height && strip.y >= controlsBottom - 0.5, `controls end ${controlsBottom}, strip ${strip.y}-${strip.y + strip.height}`)
  const noLayout = await page.evaluate(() => {
    const cardEl = document.querySelector('.composer-card')!
    const before = JSON.stringify(cardEl.getBoundingClientRect())
    const strip = document.querySelector('.scanner') as HTMLElement
    strip.style.display = 'none'
    const after = JSON.stringify(cardEl.getBoundingClientRect())
    strip.style.display = ''
    return before === after
  })
  check('POL-01 the composer is the same size with and without the scanner', noLayout)
  check('POL-01 the scanner takes no pointer events and nothing sits under it',
    await page.evaluate(() => {
      const strip = document.querySelector('.scanner')!
      const r = strip.getBoundingClientRect()
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return getComputedStyle(strip).pointerEvents === 'none'
        && [...strip.querySelectorAll('.scanner-lamp')].every((l) => getComputedStyle(l).pointerEvents === 'none' && getComputedStyle(l, '::before').pointerEvents === 'none')
        && !!hit && !strip.contains(hit)
    }))
  check('POL-01 idle: the placeholder sweep is retired', (await messageBox(page).evaluate((el) => el.getAnimations().length)) === 0)
  const idleTiming = await page.evaluate(() => {
    const s = getComputedStyle(document.querySelector('.scanner-lamp:nth-child(4)')!, '::before')
    return { name: s.animationName, duration: s.animationDuration, delay: s.animationDelay, strip: getComputedStyle(document.querySelector('.scanner')!).opacity }
  })
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
  const counts: Record<string, number> = {}
  for (const frame of FRAMES) {
    await seek(page, frame.at)
    const levels = await lampLevels(page)
    const png = await scanner.screenshot()
    rendered.push(png)
    const pixels = await pixelLevels(page, png)
    const label = `${(frame.at * 100).toFixed(2)}%`
    check(`POL-01 ${label} (${frame.note}): the head is lamp ${frame.head}`, argmax(levels) === frame.head && argmax(pixels) === frame.head, `lamps ${argmax(levels)}, pixels ${argmax(pixels)}`)
    check(`POL-01 ${label}: lit lamps are ${JSON.stringify(frame.lit)}`, same(lit(levels), frame.lit), JSON.stringify(levels.map((v) => +v.toFixed(2))))
    // The rendered strip agrees: lamps clearly lit (over a quarter of the head) show in the pixels,
    // lamps clearly out (under 7% of it) do not. The faintest tail lamp is in between and is not asked.
    const top = Math.max(...levels)
    const seen = lit(pixels.map((v) => v / Math.max(...pixels)), 0.1)
    check(`POL-01 ${label}: the rendered strip shows the same tail`,
      levels.every((v, k) => (v / top >= 0.25 ? seen.includes(k) : v / top < 0.07 ? !seen.includes(k) : true)), `seen ${JSON.stringify(seen)}`)
    counts[frame.at.toFixed(4)] = lit(levels).length
  }
  // Constant speed: the head is on lamp i at i × 5% going right and 95% − i × 5% going left.
  let steady = true
  for (let i = 0; i < LAMPS; i++) {
    await seek(page, i * 0.05)
    const a = argmax(await lampLevels(page))
    await seek(page, 0.95 - i * 0.05)
    const b = argmax(await lampLevels(page))
    if (a !== i || b !== i) { steady = false; console.log(`  (lamp ${i}: right ${a}, left ${b})`) }
  }
  check('POL-01 the bright point moves one lamp every 160 ms, both ways (constant speed)', steady)
  // The tail is drawn in, then grows again: 4 lamps lit → 3 → 2 → 1, then 2 → 3 → 4; same at the left end.
  const seq = (...ats: number[]) => ats.map((at) => counts[at.toFixed(4)]!)
  const rightIn = seq(0.45, 0.475, 0.4875, 0.50)
  const rightOut = seq(0.50, 0.55, 0.60, 0.65)
  const leftIn = seq(0.95, 0.975, 0.9875, 0.0)
  const leftOut = seq(0.0, 0.05, 0.10, 0.15)
  const shrinks = (c: number[]) => c.every((v, i) => i === 0 || v < c[i - 1]!)
  const grows = (c: number[]) => c.every((v, i) => i === 0 || v > c[i - 1]!)
  check('POL-01 right end: the lit region shortens into the end lamp, then grows behind the returning head', shrinks(rightIn) && rightIn.at(-1) === 1 && grows(rightOut), `${rightIn} then ${rightOut}`)
  check('POL-01 left end: the same, mirrored', shrinks(leftIn) && leftIn.at(-1) === 1 && grows(leftOut), `${leftIn} then ${leftOut}`)
  // No flicker or jump: sample the whole cycle every 20 ms, no lamp moves more than half its range in one sample.
  let worst = 0
  let previous: number[] | undefined
  const first = (await (async () => { await seek(page, 0); return lampLevels(page) })())
  for (let ms = 0; ms <= CYCLE; ms += 20) {
    await seek(page, (ms - 1) / CYCLE)
    const levels = await lampLevels(page)
    if (previous) worst = Math.max(worst, ...levels.map((v, k) => Math.abs(v - previous![k]!)))
    previous = levels
  }
  check('POL-01 no lamp jumps between 20 ms samples through a whole cycle', worst <= 0.5, `largest step ${worst.toFixed(2)}`)
  await seek(page, 0.99999)
  const seam = await lampLevels(page)
  check('POL-01 the cycle repeats without a seam', seam.every((v, k) => Math.abs(v - first[k]!) < 0.08), `${seam.map((v) => v.toFixed(2))} vs ${first.map((v) => v.toFixed(2))}`)

  // A filmstrip of every frame above, enlarged, for a person to read.
  const sheet = await page.evaluate(async ([frames, labels]) => {
    const bitmaps = await Promise.all((frames as string[]).map(async (b64) => createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' }))))
    const scale = 2
    const rowH = bitmaps[0]!.height * scale + 8
    const canvas = new OffscreenCanvas(bitmaps[0]!.width * scale + 330, rowH * bitmaps.length)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#111'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.imageSmoothingEnabled = false
    ctx.font = '22px sans-serif'
    ctx.fillStyle = '#ccc'
    bitmaps.forEach((b, i) => {
      ctx.drawImage(b, 0, i * rowH + 4, b.width * scale, b.height * scale)
      ctx.fillText((labels as string[])[i]!, b.width * scale + 12, i * rowH + 4 + b.height * scale * 0.8)
    })
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    const buf = new Uint8Array(await blob.arrayBuffer())
    let s = ''
    for (const byte of buf) s += String.fromCharCode(byte)
    return btoa(s)
  }, [rendered.map((b) => b.toString('base64')), FRAMES.map((f) => `${(f.at * 100).toFixed(2)}%  ${f.note}`)] as const)
  writeFileSync(join(PROOF_DIR, 'scanner-filmstrip.png'), Buffer.from(sheet, 'base64'))
  await page.screenshot({ path: join(PROOF_DIR, 'scanner-dark-idle.png') })

  // ---------- working: brighter, never faster ----------
  await startWork(page)
  check('POL-01 working: the composer is marked working', await until('working', () => isWorkingCard(page)))
  await sleep(600) // the brightness change is a 400 ms fade
  const workingTiming = await page.evaluate(() => {
    const s = getComputedStyle(document.querySelector('.scanner-lamp:nth-child(4)')!, '::before')
    return { name: s.animationName, duration: s.animationDuration, delay: s.animationDelay, strip: parseFloat(getComputedStyle(document.querySelector('.scanner')!).opacity) }
  })
  check('POL-01 working: the same timing, name and delays as idle', workingTiming.name === idleTiming.name && workingTiming.duration === idleTiming.duration && workingTiming.delay === idleTiming.delay)
  check('POL-01 working: brighter than idle', workingTiming.strip > parseFloat(idleTiming.strip) && workingTiming.strip === 1, `${idleTiming.strip} → ${workingTiming.strip}`)
  check('POL-01 working: still ten lamps and the same lamp count animating', await scanner.locator('.scanner-lamp').count() === LAMPS && (await scannerAnimations(page)) >= LAMPS)
  const w1 = await scanner.screenshot()
  await sleep(500)
  const w2 = await scanner.screenshot()
  check('POL-01 working: the scanner is moving', !w1.equals(w2))
  await page.screenshot({ path: join(PROOF_DIR, 'scanner-dark-working.png') })
  await page.setViewportSize({ width: 480, height: 760 })
  await sleep(250)
  const narrowCard = await box(page, '.composer-card')
  const narrow = await box(page, '.scanner')
  check('POL-01 narrow window: the strip shrinks to fit inside the card corners', narrow.width <= narrowCard.width - 28 + 0.5 && narrow.x >= narrowCard.x + 14 - 0.5 && narrow.width > 0, `${narrow.width} in ${narrowCard.width}`)
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
    const el = document.querySelector('.scanner')!
    const probe = document.createElement('span')
    el.appendChild(probe)
    probe.style.color = 'var(--scanner-glow)'
    const glow = getComputedStyle(probe).color
    probe.style.color = 'var(--scanner-hot)'
    const hot = getComputedStyle(probe).color
    probe.remove()
    return { glow, hot }
  })
  check('POL-01 light: no bloom and no white-hot centre', /(^rgba\(.*, 0\)$|transparent)/.test(lightInk.glow) && /(^rgba\(.*, 0\)$|transparent)/.test(lightInk.hot), JSON.stringify(lightInk))
  await seek(page, 0.2)
  const lightA = await scanner.screenshot()
  await seek(page, 0.3)
  const lightB = await scanner.screenshot()
  const lightPixels = await pixelLevels(page, lightA, 'redness')
  check('POL-01 light: the lamps still sweep', !lightA.equals(lightB) && argmax(lightPixels) === 4, `head ${argmax(lightPixels)}`)
  await page.screenshot({ path: join(PROOF_DIR, 'scanner-light-idle.png') })

  // ---------- reduce motion ----------
  await setTheme(page, 'Dark')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await newConversation(page)
  check('POL-01 reduce motion: no scanner animation runs', (await scannerAnimations(page)) === 0)
  const still1 = await scanner.screenshot()
  await sleep(700)
  const still2 = await scanner.screenshot()
  const stillPixels = await pixelLevels(page, still2)
  check('POL-01 reduce motion: a still accent, the two centre lamps lit', still1.equals(still2) && same(lit(stillPixels.map((v) => v / Math.max(...stillPixels)), 0.3), [4, 5]), JSON.stringify(stillPixels.map((v) => Math.round(v))))
  await page.screenshot({ path: join(PROOF_DIR, 'scanner-reduced.png') })
  await page.emulateMedia({ reducedMotion: null })
} catch (err) {
  check('proof ran to the end', false, err instanceof Error ? err.message.split('\n')[0] : String(err))
  await page.screenshot({ path: join(PROOF_DIR, 'scanner-failure.png') }).catch(() => undefined)
} finally {
  await app.close()
}
finish('proof:scanner')
