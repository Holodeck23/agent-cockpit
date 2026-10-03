// Deterministic landing-page checks. No agents, app state, or downloads are invoked.
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const pageFile = fileURLToPath(new URL('./index.html', import.meta.url))
// The page must advertise the version being released (package.json), not a hard-coded one.
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const escaped = version.replace(/\./g, '\\.')
const downloadHref = new RegExp(`releases/download/v${escaped}/Cockpit-${escaped}-arm64\\.dmg$`)
// Over HTTP a swapped screenshot takes a moment to arrive; wait for it (bounded) before judging it.
const shotLoaded = page => page.locator('#product-shot').evaluate(img => img.complete && img.naturalWidth > 0 ? true
  : new Promise(resolve => { img.addEventListener('load', () => resolve(img.naturalWidth > 0), { once: true }); img.addEventListener('error', () => resolve(false), { once: true }); setTimeout(() => resolve(img.complete && img.naturalWidth > 0), 10000) }))
const evidence = process.argv[2] ? resolve(process.argv[2]) : undefined
if (evidence) await mkdir(evidence, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results = []
try {
  const targets = [{ label: 'offline file', url: pathToFileURL(pageFile).href, offline: true }];
  if (process.env.LANDING_URL) targets.push({ label: 'HTTP', url: process.env.LANDING_URL, offline: false });
  for (const target of targets) for (const width of [360, 390, 768, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, offline: target.offline, reducedMotion: 'reduce' })
    const page = await context.newPage()
    const errors = []
    const network = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()) })
    const response = await page.goto(target.url)
    if (!target.offline) assert.equal(response.status(), 200)
    await page.evaluate(() => document.fonts.ready)
    assert.equal(await page.locator('h1').count(), 1)
    assert.ok((await page.locator('.release-chip').innerText()).includes(`v${version}`))
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow at ${width}`)
    if (evidence) await page.screenshot({ path: join(evidence, `landing-${target.offline ? 'file' : 'http'}-${width}.png`), fullPage: true })
    await page.getByRole('link', { name: 'Try the flow' }).click()
    assert.equal(await page.evaluate(() => location.hash), '#preview')
    assert.equal(await page.locator('#sample-site').isVisible(), false)
    await page.getByRole('button', { name: 'Resume and show me the app' }).click()
    assert.equal(await page.getByRole('button', { name: 'Allow', exact: false }).evaluate(el => el === document.activeElement), true)
    await page.getByRole('button', { name: 'Allow', exact: false }).click()
    assert.match(await page.locator('#messages').innerText(), /Dev server running/)
    assert.equal(await page.locator('#sample-site').isVisible(), true)
    assert.equal(await page.locator('#sample-plus').evaluate(el => el === document.activeElement), true, 'startup moves keyboard focus to the usable result')
    await page.getByRole('button', { name: 'Add a focus session', exact: true }).click()
    assert.equal(await page.locator('#sample-count').innerText(), '4')
    await page.getByRole('button', { name: 'Remove a focus session', exact: true }).click()
    assert.equal(await page.locator('#sample-count').innerText(), '3')
    for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Remove a focus session', exact: true }).click()
    assert.equal(await page.locator('#sample-count').innerText(), '0', 'counter cannot go negative')
    if (evidence) await page.locator('#preview').screenshot({ path: join(evidence, `interaction-${target.offline ? 'file' : 'http'}-${width}.png`) })
    await page.locator('[data-scene="1"]').click()
    await page.getByRole('button', { name: 'Switch to Codex' }).click()
    assert.match(await page.locator('#messages').innerText(), /Switched to Codex/)
    await page.locator('[data-scene="2"]').click()
    assert.match(await page.locator('#thread-title').innerText(), /mobile layout/)
    await page.locator('[data-scene="0"]').click()
    assert.match(await page.locator('#messages').innerText(), /Dev server running/, 'state persists between scenes')
    assert.equal(await page.locator('#sample-count').innerText(), '0', 'preview state persists between scenes')
    // Follow visible navigation; save must be explicit, and output must use saved state.
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    assert.equal(await page.locator('#save-notes').isEnabled(), false)
    const initialNotes = await page.locator('#sample-notes').inputValue()
    const note = 'Check mobile spacing. <img src=x onerror=alert(1)>'
    await page.getByLabel('Edit the sample project notes').fill(note)
    assert.match(await page.locator('#notes-status').innerText(), /Unsaved/)
    await page.getByRole('button', { name: 'Workflows', exact: true }).click()
    await page.getByRole('button', { name: 'Run sample workflow', exact: true }).click()
    assert.equal(await page.locator('#workflow-notes').innerText(), initialNotes, 'workflow excludes unsaved edits')
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    assert.equal(await page.locator('#sample-notes').inputValue(), note, 'unsaved draft survives navigation')
    await page.getByRole('button', { name: 'Save sample notes', exact: true }).press('Enter')
    assert.match(await page.locator('#notes-status').innerText(), /^Saved/)
    await page.getByRole('button', { name: 'Workflows', exact: true }).click()
    await page.getByRole('button', { name: 'Run sample again', exact: true }).click()
    assert.equal(await page.locator('#workflow-notes').innerText(), note)
    assert.equal(await page.locator('#workflow-notes img').count(), 0, 'notes are rendered as text')
    await page.getByRole('button', { name: 'Conversations', exact: true }).click()
    assert.match(await page.locator('#messages').innerText(), /Dev server running/)
    await page.getByRole('button', { name: 'Reset preview' }).click()
    assert.equal(await page.locator('#sample-site').isVisible(), false)
    assert.equal(await page.locator('#sample-count').innerText(), '3')
    assert.equal(await page.locator('#sample-notes').inputValue(), initialNotes)
    assert.equal(await page.locator('#workflow-result').isVisible(), false)
    await page.getByRole('button', { name: 'Resume and show me the app' }).press('Enter')
    await page.getByRole('button', { name: 'Deny', exact: true }).click()
    assert.match(await page.locator('#messages').innerText(), /Command denied/)
    assert.equal(await page.locator('#sample-site').isVisible(), false, 'denying cannot open the app')
    if (width > 1050) {
      await page.locator('[data-thread="1"]').click()
      assert.equal(await page.locator('[data-scene="1"]').getAttribute('aria-pressed'), 'true')
    }
    await page.getByRole('button', { name: 'Saved workflows', exact: true }).click()
    assert.equal(await shotLoaded(page), true)
    await page.getByRole('button', { name: 'Enlarge product screenshot' }).click()
    assert.equal(await page.getByRole('dialog').isVisible(), true)
    await page.keyboard.press('Escape')
    assert.equal(await page.getByRole('dialog').isVisible(), false)
    assert.equal(await page.locator('#enlarge').evaluate(el => el === document.activeElement), true, 'closing screenshot returns focus')
    await page.getByRole('button', { name: 'Files & documents', exact: true }).click()
    assert.equal(await shotLoaded(page), true)
    for (const name of ['Recent work', 'Inspected preview']) {
      await page.getByRole('button', { name, exact: true }).click()
      assert.equal(await shotLoaded(page), true)
    }
    await page.getByText('What should I expect from the prerelease?', { exact: true }).click()
    assert.equal(await page.locator('details[open]').count(), 1)
    assert.match(await page.locator('details[open]').innerText(), /passed same-Mac acceptance on a second account/)
    await page.getByRole('link', { name: 'Get the Mac prerelease' }).click()
    assert.equal(await page.evaluate(() => location.hash), '#release')
    assert.match(await page.locator('#download').getAttribute('href'), downloadHref)
    if (target.offline) assert.deepEqual(network, [], 'offline page must make zero external requests')
    assert.deepEqual(errors, [], 'no JavaScript exceptions')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no overflow after interactions')
    results.push(`${target.label} ${width}px: resume/allow/deny, working counter, handoff, state persistence, explicit save, workflow reads saved notes safely, reset, gallery, dialog Escape, FAQ and release CTA`)
    await context.close()
  }
  const fallback = await browser.newContext({ viewport: { width: 390, height: 900 }, offline: true, javaScriptEnabled: false })
  const fallbackPage = await fallback.newPage()
  await fallbackPage.goto(pathToFileURL(pageFile).href)
  assert.equal(await fallbackPage.locator('h1').isVisible(), true)
  assert.equal(await fallbackPage.locator('.no-js').isVisible(), true)
  assert.equal(await fallbackPage.locator('.preview-wrap').isVisible(), false, 'no inert workspace without JavaScript')
  assert.match(await fallbackPage.locator('#download').getAttribute('href'), downloadHref)
  await fallback.close()
  results.push('JavaScript disabled: readable page, screenshot and release link; simulation controls hidden')
  console.log(results.map(result => 'PASS ' + result).join('\n'))
} finally {
  await browser.close()
}
