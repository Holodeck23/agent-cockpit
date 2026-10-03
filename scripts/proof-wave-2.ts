// Packaged gate for parity wave 2 (composer, agent picker, app chrome, tint). Stand-in agent,
// no provider usage, no network: the release feed, dialogs and browser opens are stubbed in main.
// Usage: npm run package:proof, then COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:wave-2
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import type { NormalizedEvent } from '../server/agents/types.ts'
import { HELP } from '../server/help-links.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'
import { createWorkflowStore } from '../server/workflows/store.ts'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { apiPost, headStatus, messageBox, openProject, setTheme } from './lib/ui.ts'

const { check, finish } = checker()
const root = mkdtempSync(join(tmpdir(), 'cockpit-wave2-proof-'))
const zeta = join(root, 'zeta')
const alpha = join(root, 'alpha')
for (const dir of [zeta, alpha]) mkdirSync(dir)
writeFileSync(join(alpha, 'notes.md'), '# Notes\n')
writeFileSync(join(alpha, 'README.md'), '# Alpha\n')
const store = createThreadStore(join(root, 'state'))
createWorkflowStore(store.root).save({ projectPath: alpha, name: 'review', prompt: 'Review the diff for risky changes.' })
mkdirSync(PROOF_DIR, { recursive: true })

// A conversation whose agent hit a network failure (D8).
const ts = new Date().toISOString()
const offline = store.create({ id: randomUUID(), title: 'Offline turn', projectPath: alpha, settings: threadSettingsSchema.parse({}), sessionId: randomUUID(), sessionStarted: false, completed: false, createdAt: ts, updatedAt: ts })
for (const event of [{ kind: 'user_text', text: 'Hello' }, { kind: 'error', message: 'connect ECONNREFUSED 127.0.0.1:443' }] as NormalizedEvent[]) store.append(offline.id, event, ts)

const env = { COCKPIT_HOME: store.root, COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/wave1-agent') }
let app: ElectronApplication = await launchPackagedApp(env)
const shot = (page: Page, name: string) => page.screenshot({ path: join(PROOF_DIR, `wave2-${name}.png`) })
/** Polls from Node (an async waitForFunction predicate is always truthy). */
async function until(label: string, test: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await test().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 150)) }
  console.log(`  (timed out waiting for ${label})`)
  return false
}
/** Clicks an item of the app menu (by top-level label) from the main process. */
const clickMenu = (menu: string, item: string) => app.evaluate(({ Menu }, [m, i]) => {
  Menu.getApplicationMenu()!.items.find((x) => x.label === m)!.submenu!.items.find((x) => x.label === i)!.click()
}, [menu, item] as const)
const opened = () => app.evaluate(() => (globalThis as unknown as { proofOpened: string[] }).proofOpened)

try {
  let page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  const version = await app.evaluate(({ app: a }) => a.getVersion())
  // Browser opens and the release feed never leave the Mac during the proof.
  const feed = [{ tag_name: `v${version}`, name: `Cockpit v${version}`, draft: false, prerelease: true, assets: [],
    body: `# Cockpit v${version}\n\nIntro with \`code\`.\n\n## What changed\n- **Faster** list\n- See [the guide](https://evil.example/x)\n\n<img src=x onerror=alert(1)>` }]
  await app.evaluate(({ shell }, body) => {
    const g = globalThis as unknown as { proofOpened: string[]; proofFeed: string }
    g.proofOpened = []
    g.proofFeed = body
    shell.openExternal = async (url: string) => { g.proofOpened.push(url) }
    globalThis.fetch = async () => new Response(g.proofFeed, { status: 200 })
  }, JSON.stringify(feed))

  // D3: tabs in the order they were pinned (Zeta first, though Alpha sorts first by name).
  await openProject(page, zeta, 'Zeta')
  await openProject(page, alpha, 'Alpha')
  const tabNames = () => page.locator('.tabs .tab-name').allInnerTexts()
  check('D3 tabs follow pin order, not the alphabet', JSON.stringify(await tabNames()) === '["Zeta","Alpha"]', (await tabNames()).join(', '))

  // D2: ⌘1–9 projects, ⌥⌘1–5 sections.
  const selectedTab = () => page.getByRole('tablist', { name: 'Projects' }).getByRole('tab', { selected: true }).innerText()
  await page.keyboard.press('Meta+1')
  check('D2 ⌘1 opens the first tab', await until('Zeta selected', async () => (await selectedTab()).includes('Zeta')))
  await page.keyboard.press('Meta+2')
  check('D2 ⌘2 opens the second', await until('Alpha selected', async () => (await selectedTab()).includes('Alpha')))
  const section = (name: string) => page.getByRole('tablist', { name: 'Sections' }).getByRole('tab', { name: new RegExp(`^${name}`) })
  await page.keyboard.press('Meta+Alt+2')
  check('D2 ⌥⌘2 opens Files', await until('Files', async () => (await section('Files').getAttribute('aria-selected')) === 'true'))
  await page.keyboard.press('Meta+Alt+1')
  check('D2 ⌥⌘1 returns to Conversations', await until('Conversations', async () => (await section('Conversations').getAttribute('aria-selected')) === 'true'))
  check('D2 tooltips name the shortcuts', (await page.locator('.tab-main').first().getAttribute('title'))?.endsWith('(⌘1)') === true
    && (await section('Files').getAttribute('title')) === 'Files (⌥⌘2)')

  // C6: typing @ lists files and workflows inline.
  await page.getByRole('button', { name: 'New conversation' }).click()
  const box = messageBox(page)
  const mention = page.getByRole('dialog', { name: 'Files and workflows for @' })
  await box.click()
  await box.pressSequentially('Read @note')
  check('C6 @ opens the inline list with matching files', await until('notes.md listed', async () => (await mention.getByRole('option', { name: /notes\.md/ }).count()) === 1))
  await shot(page, 'c6-mention')
  await box.press('Enter')
  check('C6 Enter swaps the @word for the reference', await until('token', async () => (await box.inputValue()) === 'Read @file:notes.md '), await box.inputValue())
  check('C6 the list closes and the reference shows as a chip', !(await mention.isVisible()) && (await page.locator('.reference-chip').filter({ hasText: 'notes.md' }).count()) === 1)
  await box.pressSequentially('then @rev')
  await mention.getByRole('option', { name: /review/ }).waitFor()
  await box.press('Tab')
  check('C6 Tab adds a workflow', await until('workflow token', async () => (await box.inputValue()).endsWith('then @workflow:review '), 3000), await box.inputValue())
  await box.pressSequentially('mail a@b')
  check('C6 a mail address stays quiet', !(await mention.isVisible()))
  await box.pressSequentially(' @')
  await mention.waitFor()
  await box.press('Escape')
  check('C6 Esc hides the list and keeps typing in the message', !(await mention.isVisible()) && await box.evaluate((el) => el === document.activeElement))

  // C7 + C5: the + picker stays open while adding, Esc goes back to the message.
  await box.fill('')
  await page.getByRole('button', { name: 'Add context' }).click()
  const context = page.getByRole('dialog', { name: 'Add context' })
  await context.getByRole('textbox', { name: 'Search files and workflows' }).fill('README')
  await context.getByRole('option', { name: /README\.md/ }).waitFor()
  await context.getByRole('textbox', { name: 'Search files and workflows' }).press('Enter')
  check('C7 the + picker stays open after adding a file', await until('token added', async () => (await box.inputValue()).includes('@file:README.md')) && await context.isVisible())
  await page.keyboard.press('Escape')
  check('C5 Esc returns focus to the message', await until('focus', async () => box.evaluate((el) => el === document.activeElement)))
  await box.fill('')

  // C2, P2, C3, C4, C5, C8: the agent picker.
  const picker = page.getByRole('dialog', { name: 'Agent settings' })
  const agentRadio = (name: string) => picker.getByRole('radiogroup', { name: 'Agent' }).getByRole('radio', { name: new RegExp(`^${name}`) })
  await page.getByRole('button', { name: 'Agent settings' }).click()
  await agentRadio('Codex').click()
  await picker.getByLabel('Model').fill('gpt-proof')
  await agentRadio('Claude Code').click()
  await agentRadio('Codex').click()
  check('C2 each agent remembers its own settings', (await picker.getByLabel('Model').inputValue()) === 'gpt-proof')
  await agentRadio('Antigravity').click()
  const permissions = picker.getByLabel('Permissions')
  check('P2 Antigravity defaults to Bypass', (await permissions.inputValue()) === 'bypassPermissions')
  check('P2 Antigravity offers only Bypass, Configured and Plan', (await permissions.locator('option').count()) === 3, (await permissions.locator('option').allInnerTexts()).join(', '))
  const panel = await picker.boundingBox()
  const windowHeight = await page.evaluate(() => window.innerHeight)
  check('C8 the open panel fits in the window', !!panel && panel.y >= 0 && panel.y + panel.height <= windowHeight, `${JSON.stringify(panel)} in ${windowHeight}`)
  check('C8 every agent button fits its label', await picker.getByRole('radio').evaluateAll((els) => els.every((el) => el.scrollWidth <= el.clientWidth + 1)))
  await picker.getByRole('button', { name: /preset/ }).click()
  await picker.getByRole('textbox', { name: 'Preset name' }).fill('Plan only')
  await permissions.selectOption('plan')
  await picker.getByRole('button', { name: 'Save', exact: true }).click()
  const chip = picker.getByRole('group', { name: 'Presets' }).getByRole('button', { name: 'Plan only', exact: true })
  check('C3 a preset is saved and shown as a chip', await until('chip', async () => (await chip.count()) === 1))
  check('C3 saving keeps the panel open and never reloads the page', await picker.isVisible() && !page.url().includes('?'), page.url())
  await shot(page, 'c3-presets')
  await agentRadio('Claude Code').click()
  await chip.click()
  check('C3 one click on the chip applies the preset', (await agentRadio('Antigravity').getAttribute('aria-checked')) === 'true' && (await permissions.inputValue()) === 'plan')
  await picker.getByRole('checkbox', { name: 'Close after choosing an agent' }).check()
  await agentRadio('Claude Code').click()
  check('C4 choosing an agent closes the panel when asked to', await until('panel closed', async () => !(await picker.isVisible())))
  check('C5 and focus is back in the message', await until('focus', async () => box.evaluate((el) => el === document.activeElement)))

  // C1: one-click effort in a conversation keeps the session and says so quietly.
  await box.fill('hello')
  await box.press('Enter')
  await page.getByRole('heading', { level: 1, name: 'hello' }).waitFor()
  await headStatus(page).filter({ hasText: 'Ready' }).waitFor()
  await page.getByRole('button', { name: /^Effort:/ }).click()
  await page.getByRole('menu', { name: 'Effort' }).getByRole('menuitemradio', { name: 'High', exact: true }).click()
  check('C1 the effort button applies at once, as a quiet note', await until('note', async () => (await page.locator('.note').filter({ hasText: /high effort.*Applies from your next message/ }).count()) === 1))
  check('C1 and shows the new effort', await until('label', async () => (await page.getByRole('button', { name: 'Effort: High' }).count()) === 1),
    String(await page.getByRole('button', { name: /^Effort:/ }).getAttribute('aria-label')))

  // D8: a network failure in a conversation links to the guide's network section.
  await page.locator('.card').filter({ hasText: 'Offline turn' }).click()
  await page.getByRole('heading', { level: 1, name: 'Offline turn' }).waitFor()
  const link = page.locator('.note-error').getByRole('link', { name: 'Network troubleshooting' })
  check('D8 a connection error links to network troubleshooting', (await link.getAttribute('href')) === HELP.network)

  // E1: the project's tint on the send button, the Complete control and badges.
  await apiPost(page, '/api/projects', { path: alpha, color: 'pink' })
  await page.reload()
  await page.locator('.card').filter({ hasText: 'Offline turn' }).click()
  await page.getByRole('heading', { level: 1, name: 'Offline turn' }).waitFor()
  const sendFill = () => page.getByRole('button', { name: 'Send' }).evaluate((el) => getComputedStyle(el).backgroundColor)
  await messageBox(page).fill('x')
  check('E1 the send button takes the project tint', (await sendFill()) === 'rgb(181, 50, 112)', await sendFill())
  const newFill = await page.getByRole('button', { name: 'New conversation' }).evaluate((el) => getComputedStyle(el).backgroundColor)
  check('E1 so does the new-conversation button', newFill === 'rgb(181, 50, 112)', newFill)
  await page.getByRole('button', { name: 'Mark complete' }).click()
  const completeColor = () => page.locator('.head-action[aria-pressed="true"]').evaluate((el) => getComputedStyle(el).color)
  check('E1 the Complete control takes the tint', await until('tinted', async () => (await completeColor()) === 'rgb(181, 50, 112)'), await completeColor())
  await shot(page, 'e1-tint-light')
  await setTheme(page, 'Dark')
  check('E1 the fill keeps white text readable in dark', (await sendFill()) === 'rgb(181, 50, 112)')
  await shot(page, 'e1-tint-dark')

  // D6: the Dock icon follows the theme.
  const dockIsDark = () => app.evaluate(({ app: a, nativeImage }) => {
    const g = globalThis as unknown as { proofDock?: Electron.NativeImage[] }
    const last = g.proofDock?.at(-1)
    const dark = nativeImage.createFromPath(`${a.getAppPath()}/dist-electron/dock/dark/rest.png`)
    const light = nativeImage.createFromPath(`${a.getAppPath()}/dist-electron/dock/rest.png`)
    return last ? (last.toPNG().equals(dark.toPNG()) ? 'dark' : last.toPNG().equals(light.toPNG()) ? 'light' : 'other') : 'none'
  })
  await app.evaluate(({ app: a }) => {
    const g = globalThis as unknown as { proofDock: Electron.NativeImage[] }
    g.proofDock = []
    const original = a.dock!.setIcon.bind(a.dock)
    a.dock!.setIcon = (image: Electron.NativeImage) => { g.proofDock.push(image); original(image) }
  })
  await setTheme(page, 'Light')
  check('D6 Light shows the light Dock icon', await until('light icon', async () => (await dockIsDark()) === 'light'), await dockIsDark())
  await setTheme(page, 'Dark')
  check('D6 Dark shows the dark Dock icon', await until('dark icon', async () => (await dockIsDark()) === 'dark'), await dockIsDark())
  await setTheme(page, 'Light')

  // D7: room for the window buttons follows full screen and zoom.
  const clearance = () => page.locator('.tabbar').evaluate((el) => getComputedStyle(el).paddingLeft)
  check('D7 84 points clear for the window buttons', (await clearance()) === '84px', await clearance())
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; w.isFullScreen = () => true; w.emit('enter-full-screen') })
  check('D7 full screen drops to the normal edge', await until('16px', async () => (await clearance()) === '16px'), await clearance())
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; w.isFullScreen = () => false; w.emit('leave-full-screen') })
  check('D7 leaving full screen brings the room back', await until('84px', async () => (await clearance()) === '84px'), await clearance())
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1.25))
  check('D7 zoomed in, the clearance keeps the same physical width', await until('67px', async () => (await clearance()) === '67px'), await clearance())
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1))
  await until('zoom reset', async () => (await clearance()) === '84px')

  // D4: Help menu.
  await clickMenu('Help', 'Release Notes')
  const notes = page.getByRole('dialog', { name: 'Release Notes' })
  check('D4 Help → Release Notes opens in the app', await until('notes', async () => (await notes.getByText('Faster').count()) > 0))
  const notesBody = notes.locator('.release-notes-body')
  check('D4 notes keep their structure', (await notesBody.locator('h4').innerText()) === 'What changed' && (await notesBody.locator('li strong').innerText()) === 'Faster')
  check('D4 notes never render links or HTML from the feed', (await notesBody.locator('a, img').count()) === 0 && (await notesBody.getByText('See the guide').count()) > 0)
  await shot(page, 'd4-release-notes')
  await notes.getByRole('button', { name: 'Done' }).click()
  await clickMenu('Help', 'Troubleshooting')
  await clickMenu('Help', 'Report a Problem…')
  const urls = await opened()
  check('D4 Troubleshooting opens the guide', urls.includes(HELP.troubleshooting), urls.join(' '))
  const issue = urls.find((u) => u.startsWith('https://github.com/Holodeck23/agent-cockpit/issues/new?'))
  check('D4 Report a Problem opens a GitHub issue with the version and nothing private', !!issue && new URL(issue).searchParams.get('body')!.includes(`Cockpit ${version}`) && !issue.includes(encodeURIComponent(root)))

  // D8: a failed update check offers network troubleshooting.
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { proofDialog: string[] }
    globalThis.fetch = async () => { throw new TypeError('fetch failed') }
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { buttons: string[] }
      g.proofDialog = options.buttons
      return { response: options.buttons.indexOf('Troubleshooting'), checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  })
  await clickMenu('Cockpit', 'Check for Updates…')
  check('D8 a failed update check offers Troubleshooting', await until('help opened', async () => (await opened()).includes(HELP.network)),
    String(await app.evaluate(() => (globalThis as unknown as { proofDialog?: string[] }).proofDialog)))

  // D9: New project… names and places a folder in the native Save panel.
  const made = join(root, 'Made here')
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as unknown as typeof dialog.showSaveDialog
  }, made)
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await page.getByRole('menuitem', { name: 'New project…' }).click()
  check('D9 the folder is created and opened as the active tab', await until('new tab', async () => (await selectedTab()).includes('Made here')) && existsSync(made))
  writeFileSync(join(made, 'keep.txt'), 'x')
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await page.getByRole('menuitem', { name: 'New project…' }).click()
  check('D9 a folder that already has files is left alone, with a message', await until('error toast', async () => (await page.locator('.toast').filter({ hasText: 'already has files' }).count()) === 1))
  await page.locator('.toast').getByRole('button', { name: 'Dismiss' }).click()

  // D5: after an update, one quiet "Updated to" with the notes a click away.
  await app.evaluate((_e, body) => { globalThis.fetch = async () => new Response(body, { status: 200 }) }, JSON.stringify(feed))
  await page.evaluate(() => localStorage.setItem('cockpit:last-version', '0.0.1'))
  await page.reload()
  const toast = page.locator('.update-toast')
  check('D5 the first launch after an update says so', await until('toast', async () => (await toast.innerText()).includes(`Updated to Cockpit ${version}`)))
  await shot(page, 'd5-updated')
  await toast.getByRole('button', { name: 'What’s new' }).click()
  check('D5 What’s new opens this version’s notes', await until('notes', async () => (await page.getByRole('dialog', { name: `Updated to Cockpit ${version}` }).getByText('Faster').count()) > 0))
  await page.keyboard.press('Escape')
  await page.reload()
  await page.getByRole('tab', { selected: true }).first().waitFor()
  check('D5 and only once', (await toast.count()) === 0)

  // Narrow window and dark screenshots for the record.
  await setTheme(page, 'Dark')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(980, 640))
  await shot(page, 'narrow-dark')
  await setTheme(page, 'Light')

  // D1: the window reopens where it was left.
  const placed = { x: 120, y: 90, width: 1200, height: 780 }
  await app.evaluate(({ BrowserWindow }, b) => BrowserWindow.getAllWindows()[0]!.setBounds(b), placed)
  await new Promise((r) => setTimeout(r, 300))
  await app.close()
  app = await launchPackagedApp(env)
  page = await app.firstWindow()
  await page.getByRole('tab', { selected: true }).first().waitFor()
  const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds())
  check('D1 the window reopens at its last size and place', JSON.stringify(bounds) === JSON.stringify(placed), JSON.stringify(bounds))
} finally {
  await app.close()
}
finish('PROOF WAVE 2')
