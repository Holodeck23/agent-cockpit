// build/icon.svg and build/icon-maskable.svg → web/public/icons/: the phone's home-screen icons.
// icon-192/512 are the tile with its margin ("any"); maskable-192/512 and the 180px Apple touch
// icon are full bleed, for launchers that cut their own shape. Run: tsx scripts/make-pwa-icons.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = join(root, 'web/public/icons')
const ICONS: ReadonlyArray<[source: string, size: number, name: string]> = [
  ['build/icon.svg', 192, 'icon-192.png'],
  ['build/icon.svg', 512, 'icon-512.png'],
  ['build/icon-maskable.svg', 192, 'maskable-192.png'],
  ['build/icon-maskable.svg', 512, 'maskable-512.png'],
  ['build/icon-maskable.svg', 180, 'apple-touch-icon.png'],
]

const browser = await chromium.launch({ channel: 'chrome', headless: true })
for (const [source, size, name] of ICONS) {
  const page = await browser.newPage({ viewport: { width: size, height: size } })
  const svg = readFileSync(join(root, source), 'utf8').replace('width="1024" height="1024"', `width="${size}" height="${size}"`)
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`)
  await page.locator('svg').screenshot({ path: join(out, name), omitBackground: true })
  await page.close()
}
await browser.close()
console.log(`[make-pwa-icons] web/public/icons/: ${ICONS.map(([, , name]) => name).join(', ')}`)
