// build/icon.svg → build/dock/rest.png and frame-0…23.png (512px): the Dock icon while agents work.
// Lumen: the gold moon goes once round its orbit, passing behind the light for the far half, in
// DOCK_FRAMES steps (electron/dock-activity.ts plays them every FRAME_MS, one orbit in 2.4 s). The
// night tile reads in both appearances, so there is one set. Rendered once and committed.
// Run: tsx scripts/make-dock-frames.ts
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { DOCK_FRAMES } from '../electron/dock-activity.ts'

const buildDir = fileURLToPath(new URL('../build', import.meta.url))
const outDir = join(buildDir, 'dock')
const svg = readFileSync(join(buildDir, 'icon.svg'), 'utf8')
const MOON = /<g id="moon" transform="translate\(([-\d.]+) ([-\d.]+)\)">([\s\S]*?)<\/g>/
const BACK = '<g id="moon-back"></g>'
const RX = 290
const RY = 104

const found = MOON.exec(svg)
if (!found) throw new Error('build/icon.svg has no #moon group')
const [, x0, y0, moonBody] = found
// The resting angle is where the icon draws the moon; every frame is measured from it.
const start = Math.atan2(Number(y0) / RY, Number(x0) / RX)

/** The icon with the moon at `angle` on the orbit: in front of the light, or behind it on the far side. */
function withMoon(angle: number): string {
  const x = (RX * Math.cos(angle)).toFixed(1)
  const y = RY * Math.sin(angle)
  const moon = `<g id="moon" transform="translate(${x} ${y.toFixed(1)})">${moonBody}</g>`
  const front = svg.replace(MOON, y < 0 ? '' : moon)
  return y < 0 ? front.replace(BACK, `<g id="moon-back">${moon}</g>`) : front
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 512, height: 512 } })
const render = async (source: string, file: string): Promise<void> => {
  await page.setContent(`<html><body style="margin:0;background:transparent">${source.replace('width="1024" height="1024"', 'width="512" height="512"')}</body></html>`)
  await page.locator('svg').screenshot({ path: file, omitBackground: true })
}
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
await render(svg, join(outDir, 'rest.png'))
for (let i = 0; i < DOCK_FRAMES; i++) await render(withMoon(start + (2 * Math.PI * i) / DOCK_FRAMES), join(outDir, `frame-${i}.png`))
await browser.close()
console.log(`[make-dock-frames] build/dock/: rest.png + ${DOCK_FRAMES} frames`)
