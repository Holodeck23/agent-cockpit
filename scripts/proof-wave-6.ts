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
import { apiPost, messageBox, openProject, setTheme } from './lib/ui.ts'

const { check, finish } = checker()
const root = mkdtempSync(join(tmpdir(), 'cockpit-wave6-proof-'))
const project = join(root, 'app')
mkdirSync(project)
writeFileSync(join(project, 'notes.txt'), 'alpha\nbeta\n')
const store = createThreadStore(join(root, 'state'))
const images = createImageStore(store.root)
mkdirSync(PROOF_DIR, { recursive: true })
const ICON = readFileSync(join(ROOT, 'build/icon-1024.png'))
const BACKGROUND = readFileSync(join(ROOT, 'build/background.png'))

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
const btoaNode = (text: string): string => Buffer.from(text).toString('base64')
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

  // I1: drop and paste into the composer. Images become chips that go with the message; a
  // file the page has no path for (as in a browser) is left out with a note. (Finder paths for
  // files and folders come from Electron's webUtils and are covered by tests/composer-drop.test.ts:
  // a synthetic drop has no path to give.)
  const fileEvent = (kind: 'drop' | 'paste', selector: string, files: Array<{ name: string; type: string; data: string }>) => page.evaluate(([k, sel, list]) => {
    const transfer = new DataTransfer()
    for (const f of list) transfer.items.add(new File([Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0))], f.name, { type: f.type }))
    const target = document.querySelector(sel)!
    if (k === 'drop') {
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }))
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    } else target.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
  }, [kind, selector, files] as const)
  await page.getByRole('button', { name: 'New conversation' }).click()
  await fileEvent('drop', '.composer-card', [{ name: 'icon-1024.png', type: 'image/png', data: ICON.toString('base64') }])
  const chips = page.locator('.image-chip')
  check('I1 a dropped image becomes a chip in the composer', await until('drop chip', async () => (await chips.count()) === 1 && (await chips.first().textContent())?.includes('icon-1024.png') === true))
  await fileEvent('paste', 'textarea[aria-label="Message"]', [{ name: 'background.png', type: 'image/png', data: BACKGROUND.toString('base64') }])
  check('I1 a pasted image becomes a chip too', await until('paste chip', async () => (await chips.count()) === 2))
  await fileEvent('drop', '.composer-card', [{ name: 'spec.pdf', type: 'application/pdf', data: btoaNode('%PDF-1.4') }])
  check('I1 a file with no path is left out, and the composer says why', await until('note', async () =>
    (await page.getByRole('status').filter({ hasText: 'spec.pdf: only images can be added here' }).count()) === 1))
  await messageBox(page).fill('I1 which one did you get?')
  await shot(page, 'i1-chips')
  await chips.filter({ hasText: 'background.png' }).getByRole('button', { name: 'Remove background.png' }).click()
  check('I1 a chip can be removed before sending', (await chips.count()) === 1)
  await messageBox(page).press('Enter')
  check('I1 the image goes with the message to the agent', await until('i1 reply', async () =>
    (await reply(`Got 1 image: image/png, ${bytes} bytes, real PNG. Text after the images.`).count()) === 1))
  check('I1 the sent image shows under the message and the chips are gone', await until('sent', async () =>
    (await page.locator('.bubble.user .conversation-image').count()) === 1 && (await chips.count()) === 0))
  await shot(page, 'i1-sent')

  // G4: images the agent produces show in the conversation, stored as files, never in the log.
  const agentImages = page.locator('.image-item.from-agent .conversation-image')
  const openNew = async (agent: 'claude' | 'codex', text: string, title?: string): Promise<string> => {
    const created = await apiPost(page, '/api/threads', { projectPath: project, text, settings: { agent }, ...(title ? { title } : {}) }) as { data: { id: string } }
    await page.evaluate((id) => { location.search = `?thread=${id}` }, created.data.id)
    return created.data.id
  }
  const claudeShow = await openNew('claude', 'show')
  check('G4 an image in a Claude tool result shows in the conversation', await until('claude image', async () =>
    (await agentImages.count()) === 1 && await loaded(page, '.image-item.from-agent img') && (await reply('Here it is.').count()) === 1))
  await shot(page, 'g4-claude')
  const LONG = 'G4 Codex shows and draws the Cockpit icon, with a title long enough to prove the narrow window still fits'
  const codexShow = await openNew('codex', 'show', LONG)
  check('G4 an image Codex looked at (imageView) shows', await until('codex view', async () =>
    (await agentImages.count()) === 1 && (await agentImages.first().getAttribute('title')) === 'icon-1024.png'))
  await messageBox(page).fill('draw')
  await messageBox(page).press('Enter')
  check('G4 an image Codex made (imageGeneration) shows, named by its prompt', await until('codex draw', async () =>
    (await agentImages.count()) === 2 && (await agentImages.nth(1).getAttribute('title')) === 'The Cockpit icon' && await loaded(page, '.image-item.from-agent img')))
  await shot(page, 'g4-codex')
  const logs = [claudeShow, codexShow].map((id) => readFileSync(join(store.root, 'threads', id, 'events.jsonl'), 'utf8'))
  check('G4 the event log holds the image as a file name, never its bytes', logs.every((log) => log.includes('"kind":"image"') && !log.includes('iVBORw0KGgo')))

  await setTheme(page, 'Dark')
  await shot(page, 'thread-dark')
  await setTheme(page, 'Light')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(980, 640))
  await page.waitForTimeout(400)
  await shot(page, 'thread-narrow')
  // On the longest title (wave 5's overflow showed only there).
  const fits = await page.evaluate(() => {
    const pane = document.querySelector('.thread')!
    const menu = [...pane.querySelectorAll('.thread-head button')].at(-1)!.getBoundingClientRect()
    return pane.scrollWidth <= pane.clientWidth && menu.right <= window.innerWidth
  })
  check('narrow: a long title and its images fit the window', fits)
} finally {
  await app.close()
}
finish('PROOF WAVE 6')
