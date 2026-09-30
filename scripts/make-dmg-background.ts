// build/background.png (+ @2x) for the DMG window: the drag hint, and the first-launch
// steps (near the top: Finder's path and status bars cover the bottom), because an unnotarized app's "Not Opened" dialog offers only Done and Move to Trash.
// electron-builder picks the pair up from build/ by name.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const buildDir = fileURLToPath(new URL('../build', import.meta.url))
const WIDTH = 540
const HEIGHT = 400

const html = `<html><body style="margin:0;width:${WIDTH}px;height:${HEIGHT}px;background:#f5f5f2;
  font-family:-apple-system,system-ui,sans-serif;color:#1d1d1f;position:relative">
  <div style="position:absolute;top:22px;width:100%;text-align:center;font-size:15px;font-weight:600">
    Drag Cockpit to Applications</div>
  <div style="position:absolute;top:208px;left:215px;width:110px;text-align:center;font-size:34px;color:#8a8a85">&rarr;</div>
  <div style="position:absolute;left:28px;right:28px;top:56px;padding:12px 14px;border-radius:10px;
    background:#fff;border:1px solid #deded8;font-size:12px;line-height:1.5">
    <b>First launch:</b> macOS says <i>&ldquo;Cockpit&rdquo; Not Opened</i>. Choose <b>Done</b>, then open
    <b>System Settings &rarr; Privacy &amp; Security</b>, scroll to Security and choose <b>Open Anyway</b>.
  </div>
</body></html>`

const browser = await chromium.launch({ channel: 'chrome', headless: true })
for (const [scale, name] of [[1, 'background.png'], [2, 'background@2x.png']] as const) {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: scale })
  await page.setContent(html)
  await page.screenshot({ path: join(buildDir, name) })
  await page.close()
}
await browser.close()
console.log('[make-dmg-background] build/background.png, build/background@2x.png')
