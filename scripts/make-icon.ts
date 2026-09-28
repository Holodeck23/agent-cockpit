// build/icon.svg → build/icon.icns. Renders the SVG in headless Chrome at 1024px,
// then uses the macOS tools sips (resize) and iconutil (pack).
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const buildDir = fileURLToPath(new URL('../build', import.meta.url))
const master = join(buildDir, 'icon-1024.png')
const iconset = join(buildDir, 'icon.iconset')

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } })
await page.setContent(`<html><body style="margin:0;background:transparent">${readFileSync(join(buildDir, 'icon.svg'), 'utf8')}</body></html>`)
await page.locator('svg').screenshot({ path: master, omitBackground: true })
await browser.close()

rmSync(iconset, { recursive: true, force: true })
mkdirSync(iconset)
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const px = size * scale
    const name = scale === 1 ? `icon_${size}x${size}.png` : `icon_${size}x${size}@2x.png`
    execFileSync('sips', ['-z', String(px), String(px), master, '--out', join(iconset, name)], { stdio: 'ignore' })
  }
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(buildDir, 'icon.icns')])
rmSync(iconset, { recursive: true, force: true })
console.log('[make-icon] build/icon.icns')
