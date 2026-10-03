// Deterministic landing-page checks. No agents, app state, or downloads are invoked.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const pageFile = fileURLToPath(new URL('./index.html', import.meta.url))
const evidence = process.argv[2] ? resolve(process.argv[2]) : undefined
if (evidence) await mkdir(evidence, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results = []
try {
  for (const width of [390, 768, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, offline: true, reducedMotion: 'reduce' })
    const page = await context.newPage()
    const errors = []
    const network = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()) })
    await page.goto(pathToFileURL(pageFile).href)
    await page.evaluate(() => document.fonts.ready)
    assert.equal(await page.getByRole('heading', { name: /Your agents\.\s*One cockpit\./ }).count(), 1)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow at ${width}`)
    if (evidence) await page.screenshot({ path: join(evidence, `landing-${width}.png`), fullPage: true })
    await page.getByRole('button', { name: 'Allow', exact: false }).click()
    assert.match(await page.locator('#messages').innerText(), /Dev server running/)
    await page.locator('[data-scene="1"]').click()
    await page.getByRole('button', { name: 'Switch to Codex' }).click()
    assert.match(await page.locator('#messages').innerText(), /Switched to Codex/)
    await page.locator('[data-scene="2"]').click()
    assert.match(await page.locator('#thread-title').innerText(), /mobile layout/)
    await page.locator('[data-scene="0"]').click()
    assert.match(await page.locator('#messages').innerText(), /Dev server running/, 'state persists between scenes')
    await page.getByRole('button', { name: 'Reset preview' }).click()
    await page.getByRole('button', { name: 'Deny', exact: true }).click()
    assert.match(await page.locator('#messages').innerText(), /Command denied/)
    if (width >= 768) {
      await page.locator('[data-thread="1"]').click()
      assert.equal(await page.locator('[data-scene="1"]').getAttribute('aria-pressed'), 'true')
    }
    await page.getByRole('button', { name: 'Saved workflows', exact: true }).click()
    assert.equal(await page.locator('#product-shot').evaluate(img => img.complete && img.naturalWidth > 0), true)
    await page.getByRole('button', { name: 'Enlarge product screenshot' }).click()
    assert.equal(await page.getByRole('dialog').isVisible(), true)
    await page.keyboard.press('Escape')
    assert.equal(await page.getByRole('dialog').isVisible(), false)
    await page.getByRole('button', { name: 'Files & documents', exact: true }).click()
    assert.equal(await page.locator('#product-shot').evaluate(img => img.complete && img.naturalWidth > 0), true)
    for (const name of ['Recent work', 'Inspected preview']) {
      await page.getByRole('button', { name, exact: true }).click()
      assert.equal(await page.locator('#product-shot').evaluate(img => img.complete && img.naturalWidth > 0), true)
    }
    await page.getByText('What should I expect from the prerelease?', { exact: true }).click()
    assert.equal(await page.locator('details[open]').count(), 1)
    assert.match(await page.locator('details[open]').innerText(), /passed same-Mac acceptance on a second account/)
    await page.getByRole('link', { name: 'Get the Mac prerelease' }).click()
    assert.equal(await page.evaluate(() => location.hash), '#release')
    assert.match(await page.locator('#download').getAttribute('href'), /releases\/download\/v0\.1\.3\/Cockpit-0\.1\.3-arm64\.dmg$/)
    assert.deepEqual(network, [], 'offline page must make zero external requests')
    assert.deepEqual(errors, [], 'no JavaScript exceptions')
    results.push(`${width}px: no overflow; allow/deny/reset, handoff, scene persistence, gallery, dialog Escape, FAQ, release CTA; zero external requests or JS errors`)
    await context.close()
  }
  // Read-only hosted preview check: same static file, no backend required.
  if (process.env.LANDING_URL) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    const response = await page.goto(process.env.LANDING_URL)
    assert.equal(response.status(), 200)
    assert.match(await page.locator('#download').getAttribute('href'), /releases\/download\/v0\.1\.3\/Cockpit-0\.1\.3-arm64\.dmg$/)
    assert.match(await page.locator('.release-chip').innerText(), /v0\.1\.3/)
    await page.getByRole('button', { name: 'Recent work', exact: true }).click()
    assert.equal(await page.locator('#product-shot').evaluate(img => img.complete && img.naturalWidth > 0), true)
    await page.getByRole('button', { name: 'Allow', exact: false }).click()
    assert.match(await page.locator('#messages').innerText(), /Dev server running/)
    if (evidence) await page.screenshot({ path: join(evidence, 'landing-hosted-preview.png') })
    await context.close()
    results.push('HTTP preview: 200, v0.1.3 download, recovery screenshot and approval interaction passed')
  }
  console.log(results.map(result => 'PASS ' + result).join('\n'))
} finally {
  await browser.close()
}
