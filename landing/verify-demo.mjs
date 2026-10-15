// Drive the actual UI through visitor controls. No providers, downloads or app server.
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
const file = fileURLToPath(new URL('./index.html', import.meta.url))
const demoFile = fileURLToPath(new URL('./demo.html', import.meta.url))
const { version } = JSON.parse(await readFile(new URL('./release.json', import.meta.url), 'utf8'))
const featureGroups = JSON.parse(await readFile(new URL('./features.json', import.meta.url), 'utf8'))
const featureCount = featureGroups.reduce((count, group) => count + group.items.length, 0)
const installCommand = 'curl -fsSL https://raw.githubusercontent.com/Holodeck23/agent-cockpit/main/install.sh | sh'
const dmg = version => `https://github.com/Holodeck23/agent-cockpit/releases/download/v${version}/Cockpit-${version}-arm64.dmg`
const evidence = process.argv[2] && resolve(process.argv[2])
if (evidence) await mkdir(evidence, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
// Local proof can run separately before deployment; avoid repeating it in hosted-only checks.
if (process.env.LANDING_ONLY_HTTP && !process.env.LANDING_URL) throw new Error('LANDING_ONLY_HTTP requires LANDING_URL')
const targets = process.env.LANDING_ONLY_HTTP ? [] : [{ name: 'file', url: pathToFileURL(file).href, offline: true }]
if (process.env.LANDING_URL) targets.push({ name: 'http', url: process.env.LANDING_URL, offline: false })
try {
  for (const target of targets) for (const width of [360, 390, 768, 1280, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, offline: target.offline, reducedMotion: 'reduce' })
    const page = await context.newPage(); page.setDefaultTimeout(10000)
    const errors = [], requests = [], demoRequests = []
    page.on('pageerror', e => errors.push(e.message))
    page.on('request', r => {
      if (!/^https?:/.test(r.url())) return
      requests.push(r.url())
      if (r.frame().parentFrame()) demoRequests.push(r.url())
    })
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    const app = page.frameLocator('#demo-frame')
    const button = name => app.getByRole('button', { name, exact: true })
    const section = name => app.getByRole('tab', { name, exact: true }).click()
    const shot = async name => { if (evidence) await page.locator('#demo-container').screenshot({ path: join(evidence, `${target.name}-${width}-${name}.png`) }) }
    const noOverflow = async () => {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'page overflow')
      // The demo lives on its own page; the landing page carries no frame to check.
      if (!(await page.locator('#demo-frame').count())) return
      assert.equal(await app.locator('html').evaluate(el => el.scrollWidth > innerWidth), false, 'demo overflow')
      assert.equal(await app.locator('.app > .subnav, .app > .workspace').evaluateAll(elements => elements.some(el => el.getBoundingClientRect().width > innerWidth + 1)), false, 'demo panes fit without clipping')
    }
    assert.equal(await page.locator('h1').count(), 1)
    assert.ok((await page.locator('.hero-meta').innerText()).includes(`v${version}`))
    assert.ok(await page.locator('.hero-sub').evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 19))
    // Every download carries the Apple mark, and the install command sits beside it.
    assert.equal(await page.locator('#download svg.apple-mark').count(), 1, 'Apple mark beside the hero download')
    const started = page.locator('.get-started')
    await started.scrollIntoViewIfNeeded()
    assert.equal(await started.locator('a[href$=".dmg"] svg.apple-mark').count(), 1, 'Apple mark on the get-started download')
    assert.ok((await started.locator('.platform-note').innerText()).includes('coming soon'))
    assert.equal((await started.locator('#cli-command').innerText()).trim(), installCommand)
    assert.equal(await started.locator('.cli-code').evaluate(el => el.scrollWidth > el.clientWidth + 1 ? getComputedStyle(el).overflowX : 'auto'), 'auto', 'long command scrolls inside its own pill')
    await started.getByRole('button', { name: 'Copy the install command' }).click()
    await page.waitForFunction(() => document.getElementById('copy-cli').dataset.copied === 'true')
    assert.equal(await started.getByRole('link', { name: 'Read the docs' }).count(), 1)
    // No section eyebrows survive inside the page body.
    assert.equal(await page.locator('main .eyebrow').count(), 0, 'section mini-titles removed')
    await page.locator('#product-shot').scrollIntoViewIfNeeded()
    await page.waitForFunction(() => { const img = document.getElementById('product-shot'); return img.complete && img.naturalWidth > 0 })
    // Each showcase holds a looping muted clip over a real capture, and holds still
    // under reduced motion (this context asks for reduce).
    const showcases = page.locator('.showcase-video')
    assert.equal(await showcases.count(), 3)
    assert.deepEqual(await showcases.evaluateAll(videos => videos.map(video => ({
      loop: video.loop, muted: video.muted,
      inline: video.hasAttribute('playsinline'),
      poster: video.poster.startsWith('data:image/png;base64,') && video.poster.length > 1000,
      still: !video.hasAttribute('autoplay') && video.paused,
    }))), Array(3).fill({ loop: true, muted: true, inline: true, poster: true, still: true }))
    await page.getByRole('button', { name: 'Enlarge product screenshot' }).click(); assert.equal(await page.getByRole('dialog').isVisible(), true)
    await page.keyboard.press('Escape'); assert.equal(await page.getByRole('dialog').isVisible(), false)
    // Curated six, with the shipped directory behind a disclosure rather than on load.
    assert.equal(await page.locator('.top-feature').count(), 6)
    assert.equal(await page.locator('.feature-group').first().isVisible(), false, 'full directory stays closed on load')
    await page.locator('#features').scrollIntoViewIfNeeded()
    const directory = page.locator('#features details')
    await directory.locator('summary').click()
    assert.equal(await directory.locator('.feature-group').count(), featureGroups.length)
    assert.equal(await directory.locator('li').count(), featureCount)
    await noOverflow()
    await directory.locator('summary').click()
    await page.getByText('What should I expect from the prerelease?', { exact: true }).click(); assert.equal(await page.locator('details[open]').count(), 1)
    assert.deepEqual(await page.locator('a[href$=".dmg"]').evaluateAll(links => links.map(link => link.href)), Array(3).fill(dmg(version)), 'every download link points at this release')
    await noOverflow()
    if (evidence) await page.screenshot({ path: join(evidence, `${target.name}-${width}-landing.png`), fullPage: true })
    // The landing page hands off to the demo page; nothing of the demo ships with it.
    assert.equal(await page.locator('#cockpit-demo, #demo-frame').count(), 0, 'demo payload stays off the landing page')
    await page.getByRole('link', { name: 'Try it in your browser' }).click()
    await page.waitForURL(/demo\.html/)
    assert.equal(await page.locator('h1').count(), 1)
    await button('Allow').waitFor(); await noOverflow(); await shot('approval')
    assert.ok(await app.locator('.bubble.user').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 16))
    await button('Allow').click()
    await app.locator('.preview-pane').waitFor({ state: 'attached' })
    const previewTab = app.getByRole('tab', { name: 'Preview', exact: true })
    if (await previewTab.isVisible()) await previewTab.click()
    const sample = app.frameLocator('.preview-pane iframe')
    await sample.locator('[data-plant="basil"]').getByRole('button', { name: 'Mark watered' }).click()
    assert.equal(await sample.locator('#progress-label').innerText(), '1 of 3 watered')
    await page.getByText('You tried the change.', { exact: true }).waitFor()
    await sample.getByRole('button', { name: 'Needs water' }).click()
    assert.equal(await sample.locator('[data-plant="basil"]').isVisible(), false)
    await sample.getByRole('button', { name: 'All plants' }).click()
    assert.equal(await sample.locator('[data-plant="basil"]').isVisible(), true)
    assert.equal(await sample.locator('html').evaluate(el => el.scrollWidth > innerWidth), false, 'sample app overflow')
    assert.ok(await sample.locator('.plant p').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 14), 'sample app text too small')
    await noOverflow(); await shot('preview'); await button('Close preview').click()
    await section('Files'); await button('notes.md').click(); await button('Source').click()
    const contents = app.getByLabel('File contents', { exact: true })
    const original = await contents.inputValue()
    const note = '# Readable by design\nMake the text bigger. <img src=x onerror=alert(1)>'
    await contents.fill(note)
    async function runWorkflow() {
      await section('Workflows')
      await app.getByRole('button', { name: /Review before sharing/ }).click()
      await button('Save and run').click()
      await app.getByText('Sample review (fixed, no model call):', { exact: false }).waitFor()
    }
    await runWorkflow()
    assert.ok((await app.locator('.transcript').innerText()).includes(original.trim()), 'workflow reads saved notes, not draft')
    assert.equal((await app.locator('.transcript').innerText()).includes(note), false)
    await section('Files'); await contents.waitFor()
    assert.equal(await contents.inputValue(), note, 'draft survives navigation')
    await button('Save').press('Enter'); await page.getByText('Your next step is saved.', { exact: true }).waitFor(); await shot('files')
    await runWorkflow()
    assert.ok((await app.locator('.transcript').innerText()).includes(note))
    assert.equal(await app.locator('.transcript img').count(), 0, 'sample input stays text')
    await shot('workflow-result')
    await button('Agent settings').click(); await app.getByRole('radio', { name: 'Codex', exact: true }).click(); await button('Switch…').click()
    await button('Start handoff').click()
    await app.getByText(/Handed over from Claude Code to Codex/).waitFor()
    assert.match(await button('Agent settings').innerText(), /Codex/)
    assert.ok((await app.locator('.transcript').innerText()).includes(note), 'handoff preserves conversation'); await shot('handoff')
    await page.getByRole('button', { name: 'Reset demo', exact: true }).click()
    await button('Deny').click(); await app.getByText(/Startup denied/).waitFor()
    assert.equal(await app.locator('.preview-pane').count(), 0)
    await app.getByLabel('Message', { exact: true }).fill('start the app'); await button('Send').click(); await button('Allow').waitFor()
    await section('Files'); await button('notes.md').click(); await button('Source').click()
    assert.equal(await contents.inputValue(), original, 'reset clears saved notes and drafts')
    await page.locator('[data-demo-action="recovery"]').click(); await button('Open a project').click()
    await app.getByLabel('Recovery agent', { exact: true }).selectOption('codex'); await shot('recovery')
    await button('Resume and show me the app').click(); await button('Allow').waitFor()
    assert.match(await app.locator('.approval').innerText(), /Codex wants to use Start a process/)
    await button('Deny').click()
    await page.getByRole('button', { name: 'Expand ↗', exact: true }).click()
    assert.equal(await page.locator('#expand-demo').getAttribute('aria-expanded'), 'true')
    await app.getByLabel('Message', { exact: true }).press('Escape')
    await page.waitForFunction(() => document.getElementById('expand-demo').getAttribute('aria-expanded') === 'false')
    await noOverflow(); assert.deepEqual(errors, [])
    assert.deepEqual(demoRequests, [], 'no network calls from demo')
    if (target.offline) assert.deepEqual(requests, [], 'offline page makes no network calls')
    if (evidence) await page.screenshot({ path: join(evidence, `${target.name}-${width}-demo.png`), fullPage: true })
    console.log(`PASS ${target.name} ${width}px: approval/denial/retry, garden preview, draft/save/workflow, handoff, reset, recovery, expand/Escape, hero action area, showcases, top features/FAQ, readable type, zero API calls`)
    await context.close()
  }
  const fallback = await browser.newContext({ javaScriptEnabled: false, offline: true, viewport: { width: 390, height: 900 } })
  const page = await fallback.newPage()
  // Without JavaScript the landing page still reads and still downloads.
  await page.goto(pathToFileURL(file).href)
  assert.equal(await page.locator('#download').isVisible(), true)
  assert.equal(await page.locator('#product-shot').isVisible(), true)
  assert.equal(await page.locator('.top-feature').count(), 6)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'landing overflow without JS')
  // The demo page says so rather than showing an empty frame.
  await page.goto(pathToFileURL(demoFile).href)
  assert.equal(await page.locator('.no-js').isVisible(), true); assert.equal(await page.locator('.demo-container').isVisible(), false)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'demo page overflow without JS')
  console.log('PASS JavaScript disabled: landing reads and downloads, demo page explains itself')
  await fallback.close()
} finally { await browser.close() }
