// build/background.png (+ @2x) for the DMG window: the drag hint, and the first-launch
// steps (near the top: Finder's path and status bars cover the bottom), because an unnotarized app's "Not Opened" dialog offers only Done and Move to Trash.
// electron-builder picks the pair up from build/ by name.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const buildDir = fileURLToPath(new URL('../build', import.meta.url))
const WIDTH = 540
const HEIGHT = 400

// Lumen: moonpaper with a faint lumen glow where the app icon sits, the title in Fraunces, and the
// way to Applications drawn as a dotted arc with the gold moon at its end.
// Inlined: a page set with setContent cannot load file:// fonts.
const fraunces = `data:font/woff2;base64,${readFileSync(join(fileURLToPath(new URL('..', import.meta.url)), 'node_modules/@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2')).toString('base64')}`
const html = `<html><head><style>@font-face { font-family: Fraunces; src: url('${fraunces}') format('woff2'); font-weight: 100 900; }</style></head>
<body style="margin:0;width:${WIDTH}px;height:${HEIGHT}px;background:radial-gradient(220px 180px at 130px 230px, #5b4fd024, transparent 70%), #f5f3ee;
  font-family:-apple-system,system-ui,sans-serif;color:#1e1c28;position:relative;overflow:hidden">
  <div style="position:absolute;top:18px;width:100%;text-align:center;font:400 21px/1.2 Fraunces;font-variation-settings:'SOFT' 100,'opsz' 48;letter-spacing:-0.01em">
    Drag Cockpit to Applications</div>
  <svg style="position:absolute;left:0;top:0" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <path d="M206 236 Q270 196 334 236" fill="none" stroke="#7d7a8b" stroke-width="2" stroke-linecap="round" stroke-dasharray="1 7"/>
    <circle cx="340" cy="240" r="5" fill="#d9a441"/>
  </svg>
  <div style="position:absolute;left:28px;right:28px;top:58px;padding:12px 14px;border-radius:12px;
    background:#fcfbf8;border:1px solid #e4e0d7;box-shadow:0 8px 24px -14px #1e1c2840;font-size:12px;line-height:1.5;color:#3a3746">
    <b style="color:#1e1c28">First launch:</b> macOS says <i>&ldquo;Cockpit&rdquo; Not Opened</i>. Choose <b>Done</b>, then open
    <b>System Settings &rarr; Privacy &amp; Security</b>, scroll to Security and choose <b>Open Anyway</b>.
  </div>
</body></html>`

const browser = await chromium.launch({ channel: 'chrome', headless: true })
for (const [scale, name] of [[1, 'background.png'], [2, 'background@2x.png']] as const) {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: scale })
  await page.setContent(html)
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: join(buildDir, name) })
  await page.close()
}
await browser.close()
console.log('[make-dmg-background] build/background.png, build/background@2x.png')
