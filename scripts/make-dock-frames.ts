// build/icon.svg → build/dock/rest.png and frame-0…7.png (512px): the Dock icon while agents work,
// plus build/dock/dark/ for the dark appearance (a graphite tile with blue bars).
// The three bars rise and fall out of step, like the live bars in the app. Rendered once and
// committed; electron/dock-activity.ts plays them. Run: tsx scripts/make-dock-frames.ts
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const buildDir = fileURLToPath(new URL('../build', import.meta.url))
const outDir = join(buildDir, 'dock')
const svg = readFileSync(join(buildDir, 'icon.svg'), 'utf8')
const BARS = /<g fill="[^"]+">[\s\S]*?<\/g>/
const BOTTOM = 696
const X = [304, 464, 624]
export const FRAMES = 8

/** Bar heights for frame `i` of FRAMES: each between 170 and 400, a third of a cycle apart. */
function heights(i: number): number[] {
  return X.map((_, bar) => Math.round(170 + 230 * (0.5 + 0.5 * Math.sin((2 * Math.PI * i) / FRAMES + (bar * 2 * Math.PI) / 3))))
}
// The dark look keeps the shape and swaps the colours: the tile goes graphite, the bars take the blue.
const LOOKS = [
  { dir: outDir, svg, bars: '#fff' },
  { dir: join(outDir, 'dark'), svg: svg.replace('#3d8cff', '#3b3f47').replace('#2066d6', '#1d1f24'), bars: '#4c95ff' },
]
const withBars = (source: string, fill: string, h: readonly number[]): string =>
  source.replace(BARS, `<g fill="${fill}">${X.map((x, n) => `<rect x="${x}" y="${BOTTOM - h[n]!}" width="96" height="${h[n]}" rx="48"/>`).join('')}</g>`)

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 512, height: 512 } })
const render = async (source: string, file: string): Promise<void> => {
  await page.setContent(`<html><body style="margin:0;background:transparent">${source.replace('width="1024" height="1024"', 'width="512" height="512"')}</body></html>`)
  await page.locator('svg').screenshot({ path: file, omitBackground: true })
}
for (const look of LOOKS) {
  mkdirSync(look.dir, { recursive: true })
  await render(withBars(look.svg, look.bars, [248, 400, 320]), join(look.dir, 'rest.png'))
  for (let i = 0; i < FRAMES; i++) await render(withBars(look.svg, look.bars, heights(i)), join(look.dir, `frame-${i}.png`))
}
await browser.close()
console.log(`[make-dock-frames] build/dock/ and build/dock/dark/: rest.png + ${FRAMES} frames each`)
