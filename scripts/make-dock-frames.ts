// build/icon.svg → build/dock/rest.png and frame-0…7.png (512px): the Dock icon while agents work.
// The three bars rise and fall out of step, like the live bars in the app. Rendered once and
// committed; electron/dock-activity.ts plays them. Run: tsx scripts/make-dock-frames.ts
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const buildDir = fileURLToPath(new URL('../build', import.meta.url))
const outDir = join(buildDir, 'dock')
const svg = readFileSync(join(buildDir, 'icon.svg'), 'utf8')
const BARS = /<g fill="#fff">[\s\S]*?<\/g>/
const BOTTOM = 696
const X = [304, 464, 624]
export const FRAMES = 8

/** Bar heights for frame `i` of FRAMES: each between 170 and 400, a third of a cycle apart. */
function heights(i: number): number[] {
  return X.map((_, bar) => Math.round(170 + 230 * (0.5 + 0.5 * Math.sin((2 * Math.PI * i) / FRAMES + (bar * 2 * Math.PI) / 3))))
}
const withBars = (h: readonly number[]): string =>
  svg.replace(BARS, `<g fill="#fff">${X.map((x, n) => `<rect x="${x}" y="${BOTTOM - h[n]!}" width="96" height="${h[n]}" rx="48"/>`).join('')}</g>`)

mkdirSync(outDir, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 512, height: 512 } })
const render = async (source: string, file: string): Promise<void> => {
  await page.setContent(`<html><body style="margin:0;background:transparent">${source.replace('width="1024" height="1024"', 'width="512" height="512"')}</body></html>`)
  await page.locator('svg').screenshot({ path: join(outDir, file), omitBackground: true })
}
await render(svg, 'rest.png')
for (let i = 0; i < FRAMES; i++) await render(withBars(heights(i)), `frame-${i}.png`)
await browser.close()
console.log(`[make-dock-frames] build/dock/rest.png + ${FRAMES} frames`)
