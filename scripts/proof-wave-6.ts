// Packaged gate for parity wave 6 (attachments + images). Stand-in agents speak the image shapes
// recorded from Claude 2.1.289 and Codex 0.147 (scripts/fixtures/wave6-agent), no provider usage.
// Usage: npm run package:proof, then COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:wave-6
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { createImageStore } from '../server/threads/images.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { apiPost, openProject, setTheme } from './lib/ui.ts'

const { check, finish } = checker()
const root = mkdtempSync(join(tmpdir(), 'cockpit-wave6-proof-'))
const project = join(root, 'app')
mkdirSync(project)
writeFileSync(join(project, 'notes.txt'), 'alpha\nbeta\n')
const store = createThreadStore(join(root, 'state'))
const images = createImageStore(store.root)
mkdirSync(PROOF_DIR, { recursive: true })
const ICON = readFileSync(join(ROOT, 'build/icon-1024.png'))

// Foundation: a conversation that already holds an image the agent showed, stored the way the
// manager stores one (bytes in the state folder, a small event in the log).
const now = new Date().toISOString()
const seeded = store.create({ id: '6a6a6a6a-0000-4000-8000-000000000006', title: 'Seeded image conversation', projectPath: project,
  settings: threadSettingsSchema.parse({}), sessionId: '6a6a6a6a-0000-4000-8000-000000000007', sessionStarted: false, completed: false, createdAt: now, updatedAt: now })
const icon = images.save(seeded.id, ICON)
store.append(seeded.id, { kind: 'user_text', text: 'Show me the app icon' })
store.append(seeded.id, { kind: 'image', file: icon.file, mediaType: icon.mediaType, from: 'agent', name: 'icon-1024.png' })
store.append(seeded.id, { kind: 'assistant_text', messageId: 'm1', text: 'That is the icon.' })

const app = await launchPackagedApp({ COCKPIT_HOME: store.root, COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/wave6-agent') })
const shot = (page: Page, name: string) => page.screenshot({ path: join(PROOF_DIR, `wave6-${name}.png`) })
/** Polls from Node (an async waitForFunction predicate is always truthy). */
async function until(label: string, test: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await test().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 150)) }
  console.log(`  (timed out waiting for ${label})`)
  return false
}
/** True once every image in `scope` has loaded real pixels. */
const loaded = (page: Page, selector: string) => page.locator(selector).evaluateAll((imgs) =>
  imgs.length > 0 && imgs.every((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0))
const status = (page: Page, path: string) => page.evaluate(async (p) => (await fetch(p)).status, path)

try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await openProject(page, project, 'App')

  // Foundation: a stored image shows as a thumbnail, opens whole, and is served only by its own name.
  await page.evaluate((id) => { location.search = `?thread=${id}` }, seeded.id)
  const thumb = page.locator('.image-item .conversation-image')
  check('foundation: the stored image shows in the conversation', await until('thumbnail', async () => (await thumb.count()) === 1 && await loaded(page, '.image-item .conversation-image img')))
  await shot(page, 'foundation-thumbnail')
  await thumb.click()
  const viewer = page.locator('dialog.image-viewer[open]')
  check('foundation: clicking it shows the whole image', await until('viewer', async () => (await viewer.count()) === 1 && (await viewer.locator('p').textContent()) === 'icon-1024.png'))
  await shot(page, 'foundation-viewer')
  await page.keyboard.press('Escape')
  check('foundation: Escape closes the viewer', await until('closed', async () => (await viewer.count()) === 0))
  const base = `/api/threads/${seeded.id}/images/`
  check('foundation: the image is served by its own name', await status(page, `${base}${icon.file}`) === 200)
  check('foundation: any other name is not served', (await Promise.all([icon.file.replace('.png', '.svg'), 'icon.png', `..%2F..%2Fmeta.json`].map((f) => status(page, `${base}${f}`)))).every((s) => s === 404))

  // I2: an image sent with a message reaches each agent the way it takes images, and shows under
  // your message. The stand-ins report what arrived (scripts/fixtures/wave6-agent).
  const sendImage = async (agent: 'claude' | 'codex' | 'antigravity', text: string): Promise<string> => {
    const created = await apiPost(page, '/api/threads', { projectPath: project, text, settings: { agent }, images: [{ data: ICON.toString('base64'), name: 'icon-1024.png' }] }) as { data: { id: string } }
    await page.evaluate((id) => { location.search = `?thread=${id}` }, created.data.id)
    return created.data.id
  }
  const reply = (text: string) => page.locator('.bubble.agent').filter({ hasText: text })
  const bytes = ICON.length
  await sendImage('claude', 'I2 Claude: what is this?')
  check('I2 Claude gets the image as a base64 block before the text', await until('claude reply', async () =>
    (await reply(`Got 1 image: image/png, ${bytes} bytes, real PNG. Text after the images.`).count()) === 1))
  check('I2 your image shows under your message', await until('your thumbnail', async () =>
    (await page.locator('.bubble.user .conversation-image').count()) === 1 && await loaded(page, '.bubble.user .conversation-image img')))
  await shot(page, 'i2-claude')
  await sendImage('codex', 'I2 Codex: what is this?')
  check('I2 Codex opens the stored file from a localImage item', await until('codex reply', async () =>
    (await reply(`Got 1 local image: ${bytes} bytes, real PNG.`).count()) === 1))
  await sendImage('antigravity', 'I2 Antigravity: what is this?')
  check('I2 Antigravity opens the stored file inside its added folder', await until('agy reply', async () =>
    (await reply(`Opened 1 image in the workspace: ${bytes} bytes, real PNG.`).count()) === 1))
  await shot(page, 'i2-antigravity')
  const refused = await page.evaluate(async (p) => (await fetch('/api/threads', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectPath: p, text: 'svg', images: [{ data: btoa('<svg xmlns="http://www.w3.org/2000/svg"/>') }] }) })).status, project)
  check('I2 an SVG (or anything not PNG/JPEG/GIF/WebP) is refused', refused === 400)

  await setTheme(page, 'Dark')
  await shot(page, 'thread-dark')
  await setTheme(page, 'Light')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(980, 640))
  await page.waitForTimeout(400)
  await shot(page, 'thread-narrow')
  const fits = await page.evaluate(() => {
    const pane = document.querySelector('.thread')!
    return pane.scrollWidth <= pane.clientWidth
  })
  check('narrow: the conversation with images fits the window', fits)
} finally {
  await app.close()
}
finish('PROOF WAVE 6')
