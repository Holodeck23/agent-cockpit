// Renders an SVG icon to PNGs with headless Chrome: tsx scripts/render-icon.ts <svg> <out-192.png> <out-512.png>
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
const [svgPath, ...outs] = process.argv.slice(2)
const svg = readFileSync(svgPath!, 'utf8')
const browser = await chromium.launch({ channel: 'chrome' })
for (const out of outs) {
  const size = Number(/-(\d+)\.png$/.exec(out)![1])
  const page = await browser.newPage({ viewport: { width: size, height: size } })
  await page.setContent(`<html><body style="margin:0">${svg.replace('width="1024" height="1024"', `width="${size}" height="${size}"`)}</body></html>`)
  await page.screenshot({ path: out, omitBackground: true })
}
await browser.close()
