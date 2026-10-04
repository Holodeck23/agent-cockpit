// Packaged gate for parity wave 4 (files, documents, workflows). Seeded projects and files,
// no agent runs, no network. Moving to the Trash is stubbed in main to a plain delete of the
// temporary file, so a proof run never fills the real Trash.
// Usage: npm run package:proof, then COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:wave-4
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { documentsDir, markDocument } from '../server/files/documents.ts'
import { createThreadStore } from '../server/threads/store.ts'
import { threadSettingsSchema } from '../server/threads/types.ts'
import { createWorkflowStore } from '../server/workflows/store.ts'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { apiPost, openProject, setTheme } from './lib/ui.ts'

const { check, finish } = checker()
const root = mkdtempSync(join(tmpdir(), 'cockpit-wave4-proof-'))
const project = join(root, 'app')
const other = join(root, 'other')
mkdirSync(join(project, 'src', 'components'), { recursive: true })
mkdirSync(other)
writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1\n')
writeFileSync(join(project, 'src', 'b.ts'), 'export const b = 2\n')
writeFileSync(join(project, 'src', 'c.ts'), 'export const c = 3\n')
writeFileSync(join(project, 'src', 'components', 'x.ts'), 'export const x = 0\n')
writeFileSync(join(project, 'README.md'), '# App\n')
writeFileSync(join(project, 'find.txt'), 'apple banana apple\nApple pie\n')
writeFileSync(join(project, 'src', 'long.ts'), Array.from({ length: 200 }, (_, i) => `export const value${i} = "text ${i}" // line ${i + 1}`).join('\n') + '\n')
writeFileSync(join(other, 'notes.txt'), 'other\n')

const store = createThreadStore(join(root, 'state'))
const docs = documentsDir(store.root, project)
writeFileSync(join(docs, 'launch-plan.md'), '# Launch\n\nShip the beta on Friday.\n')
writeFileSync(join(docs, 'old-pricing.md'), 'The beta pricing we dropped.\n')
writeFileSync(join(docs, 'groceries.txt'), 'milk\n')
markDocument(store.root, project, 'old-pricing.md', { archived: true })
createWorkflowStore(store.root).save({ projectPath: project, name: 'review', title: 'Review changes', prompt: 'Review the diff for risky changes.' })
{
  // A sent message that asked about lines 3-5 of long.ts (F10's clip and peek).
  const ts = '2026-10-04T09:00:00.000Z'
  const meta = store.create({ id: randomUUID(), title: 'Lines question', projectPath: project, settings: threadSettingsSchema.parse({}), sessionId: randomUUID(), sessionStarted: false, completed: false, createdAt: ts, updatedAt: ts })
  store.append(meta.id, { kind: 'user_text', text: '@file:src%2Flong.ts#L3-L5 Why these?' }, ts)
  store.append(meta.id, { kind: 'result', ok: true }, ts)
}
const app = await launchPackagedApp({ COCKPIT_HOME: store.root, COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/wave1-agent') })
const shot = (page: Page, name: string) => page.screenshot({ path: join(PROOF_DIR, `wave4-${name}.png`) })
async function until(label: string, test: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await test().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 150)) }
  console.log(`  (timed out waiting for ${label})`)
  return false
}

try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await app.evaluate(({ shell }) => {
    const fs = (process as unknown as { mainModule: { require(id: string): typeof import('node:fs') } }).mainModule.require('node:fs')
    shell.trashItem = async (path: string) => { fs.rmSync(path) }
  })
  await apiPost(page, '/api/projects', { path: other, pinned: false, name: 'Other' })
  await openProject(page, project, 'App')

  // F1: remove a project from its row in the Projects menu.
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  const menu = page.getByRole('menu', { name: 'Projects' })
  const otherRow = menu.locator('.project-row').filter({ hasText: 'Other' })
  await otherRow.hover()
  await otherRow.getByRole('button', { name: 'Remove Other from Cockpit' }).click()
  const confirm = menu.getByRole('alertdialog', { name: 'Remove Other from Cockpit' })
  check('F1 the row asks before removing', await confirm.isVisible())
  await shot(page, 'f1-remove-confirm')
  await confirm.getByRole('button', { name: 'Remove', exact: true }).click()
  check('F1 the project leaves the menu', await until('gone', async () => (await menu.locator('.project-row').filter({ hasText: 'Other' }).count()) === 0))
  check('F1 the folder is untouched and you stay in the open project', existsSync(join(other, 'notes.txt'))
    && (await page.getByRole('tab', { selected: true }).first().innerText()).includes('App'))
  await page.keyboard.press('Escape')

  // F4: Home, Back, Forward and Up in Files.
  await page.getByRole('tablist', { name: 'Sections' }).getByRole('tab', { name: /^Files/ }).click()
  const explorer = page.getByRole('navigation', { name: 'Project files' })
  const where = explorer.locator('.file-path')
  const nav = (name: string) => explorer.getByRole('group', { name: 'Folder navigation' }).getByRole('button', { name, exact: true })
  check('F4 Back, Forward, Home and Up start disabled at the top', await nav('Back').isDisabled() && await nav('Forward').isDisabled() && await nav('Home').isDisabled() && await nav('Up').isDisabled())
  await explorer.locator('.file-row').filter({ hasText: /^src/ }).click()
  await explorer.locator('.file-row').filter({ hasText: /^components/ }).click()
  check('F4 folders open inside each other', await until('components', async () => (await where.innerText()) === 'src/components'))
  await nav('Back').click()
  check('F4 Back returns to the previous folder', await until('back', async () => (await where.innerText()) === 'src'))
  await nav('Forward').click()
  check('F4 Forward goes there again', await until('forward', async () => (await where.innerText()) === 'src/components'))
  await nav('Up').click()
  check('F4 Up opens the enclosing folder', await until('up', async () => (await where.innerText()) === 'src'))
  await nav('Home').click()
  check('F4 Home goes to the project top', await until('home', async () => (await where.innerText()) === '/'))
  await nav('Back').click()
  check('F4 Back works after Home', await until('back again', async () => (await where.innerText()) === 'src'))

  // F2: rename with the name and extension apart.
  // By the name's own element: a pinned row's text also holds the pin icon's title.
  const row = (name: string) => explorer.locator('.file-row-wrap').filter({ has: page.locator('.file-row > span:first-of-type').getByText(name, { exact: true }) })
  await row('b.ts').getByRole('button', { name: 'More for b.ts' }).click()
  await page.getByRole('menuitem', { name: 'Rename…' }).click()
  const stem = explorer.getByRole('textbox', { name: 'New name for b.ts' })
  const ext = explorer.getByRole('textbox', { name: 'Extension for b.ts' })
  check('F2 the name and extension are separate fields', (await stem.inputValue()) === 'b' && (await ext.inputValue()) === 'ts')
  check('F2 the name is selected, ready to type over', await stem.evaluate((el: HTMLInputElement) => el.selectionStart === 0 && el.selectionEnd === 1 && document.activeElement === el))
  const [stemBox, extBox] = [await stem.boundingBox(), await ext.boundingBox()]
  check('F2 the name field takes the room and the extension sits right after it', !!stemBox && !!extBox && stemBox.width > extBox.width * 2 && extBox.x - (stemBox.x + stemBox.width) < 24,
    `${stemBox?.width} / ${extBox?.width}, gap ${extBox && stemBox ? extBox.x - (stemBox.x + stemBox.width) : '?'}`)
  await shot(page, 'f2-rename')
  await stem.fill('beta')
  await ext.fill('.md')
  await ext.press('Enter')
  check('F2 renaming joins them, a typed dot included', await until('renamed', async () => existsSync(join(project, 'src', 'beta.md')) && !existsSync(join(project, 'src', 'b.ts'))))
  check('F2 the list shows the new name', await until('row', async () => (await row('beta.md').count()) === 1))

  // F3: moving the open file to the Trash shows the next one in the folder.
  await explorer.locator('.file-row', { hasText: /^a\.ts$/ }).click()
  const activeTab = page.getByRole('tablist', { name: 'Open files' }).getByRole('tab', { selected: true })
  await until('a.ts open', async () => (await activeTab.innerText()).startsWith('a.ts'))
  await row('a.ts').getByRole('button', { name: 'More for a.ts' }).click()
  await page.getByRole('menuitem', { name: 'Move to Trash…' }).click()
  await row('a.ts').getByRole('alertdialog').getByRole('button', { name: 'Move to Trash' }).click()
  check('F3 the file is gone', await until('trashed', async () => !existsSync(join(project, 'src', 'a.ts'))))
  check('F3 the next file in the folder is shown', await until('next', async () => (await activeTab.innerText()).startsWith('beta.md')), await activeTab.innerText().catch(() => ''))
  await shot(page, 'f3-next-file')

  // F7: hide the explorer for more room; it stays hidden after a reload.
  const editor = page.locator('.file-editor')
  const wide = (await editor.boundingBox())?.width ?? 0
  await page.getByRole('button', { name: 'Hide files' }).click()
  check('F7 hiding the explorer gives the editor the width', await until('hidden', async () => !(await explorer.isVisible()) && ((await editor.boundingBox())?.width ?? 0) > wide + 150))
  await shot(page, 'f7-hidden')
  await page.reload()
  await page.getByRole('tablist', { name: 'Sections' }).getByRole('tab', { name: /^Files/ }).click()
  check('F7 it stays hidden after a reload', await until('still hidden', async () => (await page.getByRole('button', { name: 'Show files' }).isVisible()) && !(await explorer.isVisible())))
  await page.getByRole('button', { name: 'Show files' }).click()
  check('F7 Show files brings it back', await until('shown', async () => explorer.isVisible()))
  // F5: search your documents, the archive included, by name or by a word inside.
  await page.getByRole('tab', { name: 'Your documents' }).click()
  const docList = page.getByRole('navigation', { name: 'Your documents' })
  check('F5 an archived document is not in the current list', await until('list', async () => (await docList.locator('.file-row', { hasText: 'launch-plan.md' }).count()) === 1)
    && (await docList.locator('.file-row', { hasText: 'old-pricing.md' }).count()) === 0)
  await docList.getByRole('searchbox', { name: 'Search documents' }).fill('beta')
  const hit = (name: string) => docList.locator('.file-row', { hasText: name })
  check('F5 searching finds current and archived documents by a word inside', await until('hits', async () => (await hit('launch-plan.md').count()) === 1 && (await hit('old-pricing.md').count()) === 1 && (await hit('groceries.txt').count()) === 0))
  check('F5 an archived match says so and shows the matching line', (await hit('old-pricing.md').locator('.doc-archived-tag').innerText()) === 'Archived'
    && (await hit('launch-plan.md').locator('.doc-excerpt').innerText()) === 'Ship the beta on Friday.')
  check('F5 while searching, the Current/Archived switch and New file step aside', !(await docList.getByRole('tab', { name: /^Archived/ }).isVisible()))
  check('F5 the Archived tag is a small label, not a stretched bar', ((await hit('old-pricing.md').locator('.doc-archived-tag').boundingBox())?.width ?? 999) < 90)
  await shot(page, 'f5-search')
  await hit('old-pricing.md').click()
  check('F5 a match opens like any document', await until('opened', async () => (await activeTab.innerText()).startsWith('old-pricing.md')))
  await docList.getByRole('searchbox', { name: 'Search documents' }).fill('')
  check('F5 clearing the search returns to the list', await until('cleared', async () => (await hit('old-pricing.md').count()) === 0 && (await hit('groceries.txt').count()) === 1))
  await page.getByRole('tab', { name: 'Project files' }).click()

  // F6: pin a project file and a document; both reopen from the navigation in any section.
  const sections = page.getByRole('tablist', { name: 'Sections' })
  const pinsNav = page.getByRole('group', { name: 'Pinned files' })
  if (await nav('Home').isEnabled()) await nav('Home').click()
  await until('top', async () => (await where.innerText()) === '/')
  await row('README.md').getByRole('button', { name: 'More for README.md' }).click()
  await page.getByRole('menuitem', { name: 'Pin to navigation' }).click()
  check('F6 a pinned project file appears in the navigation', await until('pin', async () => (await pinsNav.getByRole('button', { name: 'README.md' }).count()) === 1))
  check('F6 its row shows the pin', await until('row pin', async () => (await row('README.md').locator('.file-pin').count()) === 1))
  await page.getByRole('tab', { name: 'Your documents' }).click()
  await docList.locator('.file-row-wrap').filter({ hasText: 'launch-plan.md' }).getByRole('button', { name: 'More for launch-plan.md' }).click()
  await page.getByRole('menuitem', { name: 'Pin to navigation' }).click()
  check('F6 a pinned document appears there too, after the files', await until('doc pin', async () => (await pinsNav.getByRole('button').allInnerTexts()).join('|') === 'README.md|launch-plan.md'),
    (await pinsNav.getByRole('button').allInnerTexts().catch(() => [])).join('|'))
  await sections.getByRole('tab', { name: /^Workflows/ }).click()
  await pinsNav.getByRole('button', { name: 'launch-plan.md' }).click()
  check('F6 a document pin reopens it in Your documents from another section', await until('doc reopened', async () => (await activeTab.innerText()).startsWith('launch-plan.md')
    && (await page.getByRole('tab', { name: 'Your documents' }).getAttribute('aria-selected')) === 'true'))
  await sections.getByRole('tab', { name: /^Conversations/ }).click()
  await pinsNav.getByRole('button', { name: 'README.md' }).click()
  check('F6 a file pin reopens it in Project files', await until('file reopened', async () => (await activeTab.innerText()).startsWith('README.md')
    && (await page.getByRole('tab', { name: 'Project files' }).getAttribute('aria-selected')) === 'true'))
  await shot(page, 'f6-pins')
  await row('README.md').getByRole('button', { name: 'More for README.md' }).click()
  await page.getByRole('menuitem', { name: 'Rename…' }).click()
  await explorer.getByRole('textbox', { name: 'New name for README.md' }).fill('GUIDE')
  await explorer.getByRole('textbox', { name: 'New name for README.md' }).press('Enter')
  check('F6 a renamed pinned file keeps its pin under the new name', await until('renamed pin', async () => (await pinsNav.getByRole('button').allInnerTexts()).join('|') === 'GUIDE.md|launch-plan.md'),
    (await pinsNav.getByRole('button').allInnerTexts().catch(() => [])).join('|'))

  // F11: syntax colours in the code editor, under a textarea that still does the typing.
  await explorer.locator('.file-row').filter({ hasText: /^src/ }).first().click()
  await explorer.locator('.file-row', { hasText: /^long\.ts$/ }).click()
  const layer = page.locator('.file-highlight')
  const area = page.getByRole('textbox', { name: 'File contents' })
  check('F11 a TypeScript file is coloured', await until('colours', async () => (await layer.locator('.hljs-keyword').first().innerText()) === 'export'
    && (await layer.locator('.hljs-string').count()) > 0 && (await layer.locator('.hljs-comment').count()) > 0))
  const metrics = await page.evaluate(() => {
    const a = getComputedStyle(document.querySelector('.file-code .file-text')!)
    const h = getComputedStyle(document.querySelector('.file-highlight')!)
    const keys = ['fontFamily', 'fontSize', 'lineHeight', 'paddingLeft', 'paddingTop', 'borderLeftWidth', 'borderTopWidth', 'tabSize', 'letterSpacing'] as const
    return { diff: keys.filter((k) => a[k] !== h[k]).map((k) => `${k}: ${a[k]} vs ${h[k]}`).join('; '), textColor: a.color }
  })
  check('F11 the coloured layer matches the textarea\'s font, line height and padding', metrics.diff === '', metrics.diff)
  check('F11 only the coloured layer shows the text', metrics.textColor === 'rgba(0, 0, 0, 0)', metrics.textColor)
  await area.evaluate((el: HTMLTextAreaElement) => { el.scrollTop = 900; el.dispatchEvent(new Event('scroll')) })
  check('F11 the colours scroll with the text', await until('scroll', async () => Math.abs((await layer.evaluate((el) => el.scrollTop)) - (await area.evaluate((el) => el.scrollTop))) < 1))
  await area.click()
  await page.keyboard.press('Meta+ArrowUp')
  await page.keyboard.type('const typed = 42\n')
  check('F11 typing re-colours the new text', await until('typed', async () => (await layer.innerText()).startsWith('const typed = 42')
    && (await layer.locator('.hljs-number', { hasText: '42' }).count()) === 1))
  check('F11 the layer holds exactly the editor text', await until('same text', async () => (await layer.evaluate((el) => el.textContent)) === `${await area.inputValue()}\n`))
  await shot(page, 'f11-colours-light')
  await setTheme(page, 'Dark')
  await shot(page, 'f11-colours-dark')
  await setTheme(page, 'Light')
  // Leave long.ts unchanged and closed.
  await page.getByRole('button', { name: 'Close long.ts' }).click()
  await page.getByRole('button', { name: 'Discard changes' }).click()

  // F10: select lines to start a conversation about them.
  await explorer.locator('.file-row', { hasText: /^long\.ts$/ }).click()
  await until('long.ts', async () => (await activeTab.innerText()).startsWith('long.ts'))
  await area.click()
  await page.keyboard.press('Meta+ArrowUp')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('Shift+ArrowDown')
  const ask = page.getByRole('button', { name: 'Ask about lines 3–5' })
  check('F10 selecting lines offers to ask about them', await until('ask', async () => ask.isVisible()))
  await shot(page, 'f10-ask')
  await ask.click()
  const composer = page.getByRole('textbox', { name: 'Message' })
  check('F10 the draft gets a reference to just those lines', await until('draft', async () => (await composer.inputValue()).includes('@file:src%2Flong.ts#L3-L5')), await composer.inputValue().catch(() => ''))
  check('F10 its chip names the lines', await until('chip', async () => (await page.locator('.reference-chip', { hasText: 'long.ts:3-5' }).count()) >= 1))
  await shot(page, 'f10-draft')
  await composer.fill('')
  await page.locator('.card').filter({ hasText: 'Lines question' }).click()
  await page.getByRole('heading', { level: 1, name: 'Lines question' }).waitFor()
  const clip = page.locator('.message-clips [title="src/long.ts:3-5"]')
  check('F10 a sent range shows as path:lines', (await clip.innerText()) === 'long.ts:3-5')
  await clip.hover()
  // Scoped to this clip's own peek: another peek panel can still be closing (the wave-3 flake).
  const linesPeek = page.locator('.peek', { has: page.locator('[title="src/long.ts:3-5"]') }).locator('.peek-panel')
  check('F10 its peek shows only those lines', await until('peek', async () => (await linesPeek.locator('.peek-text').innerText()) === [3, 4, 5].map((n) => `export const value${n - 1} = "text ${n - 1}" // line ${n}`).join('\n')),
    `panels open: ${await page.locator('.peek-panel').count()}; text: ${JSON.stringify(await linesPeek.locator('.peek-text').innerText().catch(() => ''))}`)
  await linesPeek.getByRole('button', { name: 'Open in Files' }).click()
  const selection = () => area.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd))
  check('F10 Open in Files selects those lines', await until('selected', async () => (await selection()).startsWith('export const value2') && (await selection()).endsWith('// line 5')),
    await selection().catch(() => ''))
  await page.getByRole('button', { name: 'Close long.ts' }).click()
  // Files opened afresh from the conversation, so the explorer may already be at the top.
  if (await nav('Home').isEnabled()) await nav('Home').click()

  // F9: find and replace in the Source view (any text file) and the Document view (Markdown).
  const painted = (name: string) => page.evaluate((n) => CSS.highlights.get(n)?.size ?? 0, name)
  await explorer.locator('.file-row', { hasText: /^find\.txt$/ }).click()
  await until('find.txt', async () => (await activeTab.innerText()).startsWith('find.txt'))
  await area.click()
  await page.keyboard.press('Meta+f')
  const bar = page.getByRole('search', { name: 'Find in file' })
  const findBox = bar.getByRole('searchbox', { name: 'Find' })
  check('F9 ⌘F opens find with the cursor in it', await until('bar', async () => findBox.evaluate((el) => el === document.activeElement)))
  await findBox.fill('apple')
  const counter = bar.locator('.find-count')
  check('F9 matches are counted, case ignored', await until('count', async () => (await counter.innerText()) === '1 of 3'), await counter.innerText())
  check('F9 every match is painted', await until('painted', async () => (await painted('cockpit-editor-find')) === 3 && (await painted('cockpit-editor-find-current')) === 1))
  await bar.getByRole('button', { name: 'Match case' }).click()
  check('F9 Match case narrows it', await until('case', async () => (await counter.innerText()) === '1 of 2'))
  await bar.getByRole('button', { name: 'Match case' }).click()
  await findBox.press('Enter')
  check('F9 Enter steps to the next match', await until('next', async () => (await counter.innerText()) === '2 of 3'))
  await findBox.press('Shift+Enter')
  await shot(page, 'f9-find-source')
  await page.keyboard.press('Meta+Alt+f')
  const withBox = bar.getByRole('textbox', { name: 'Replace with' })
  check('F9 ⌥⌘F shows Replace', await until('replace row', async () => withBox.isVisible()))
  await withBox.fill('pear')
  await bar.getByRole('button', { name: 'Replace', exact: true }).click()
  check('F9 Replace changes only the current match', await until('one', async () => (await area.inputValue()) === 'pear banana apple\nApple pie\n'), await area.inputValue())
  check('F9 and the count follows', await until('count 2', async () => (await counter.innerText()) === '1 of 2'), await counter.innerText())
  await bar.getByRole('button', { name: 'Replace all' }).click()
  check('F9 Replace all changes the rest', await until('all', async () => (await area.inputValue()) === 'pear banana pear\npear pie\n'), await area.inputValue())
  check('F9 then nothing is left to find', await until('none', async () => (await counter.innerText()) === 'No matches'))
  await shot(page, 'f9-replaced-source')
  await findBox.press('Escape')
  check('F9 Esc closes the bar and clears the paint', await until('closed', async () => (await bar.count()) === 0 && (await painted('cockpit-editor-find')) === 0))
  await page.keyboard.press('Meta+z')
  check('F9 ⌘Z undoes Replace all in one step', await until('undo', async () => (await area.inputValue()) === 'pear banana apple\nApple pie\n'), await area.inputValue())
  await page.getByRole('button', { name: 'Close find.txt' }).click()
  await page.getByRole('button', { name: 'Discard changes' }).click()

  await page.getByRole('tab', { name: 'Your documents' }).click()
  await docList.locator('.file-row', { hasText: 'launch-plan.md' }).click()
  await page.getByRole('button', { name: 'Document', exact: true }).click()
  const doc = page.locator('.doc-surface .ProseMirror')
  await doc.waitFor()
  await doc.click()
  await page.keyboard.press('Meta+Alt+f')
  check('F9 the Document view finds too', await until('doc bar', async () => (await bar.isVisible())))
  await findBox.fill('beta')
  check('F9 a document match is counted and painted', await until('doc count', async () => (await counter.innerText()) === '1 of 1' && (await painted('cockpit-editor-find')) === 1))
  await shot(page, 'f9-find-document')
  await withBox.fill('release')
  await bar.getByRole('button', { name: 'Replace all' }).click()
  check('F9 Replace all edits the document', await until('doc replaced', async () => (await doc.innerText()).includes('Ship the release on Friday.')))
  await findBox.press('Escape')
  await doc.click()
  await page.keyboard.press('Meta+z')
  check('F9 ⌘Z undoes it in the document', await until('doc undo', async () => (await doc.innerText()).includes('Ship the beta on Friday.')), await doc.innerText())
  // Switching to Source straight after typing keeps what was typed (the listener had not reported it yet).
  await doc.click()
  await page.keyboard.press('Meta+ArrowDown')
  await page.keyboard.type(' Typed last.')
  await page.getByRole('button', { name: 'Source', exact: true }).click()
  check('F9/F12 typing then switching to Source at once loses nothing', await until('flushed', async () => (await area.inputValue()).includes('Typed last.')), JSON.stringify(await area.inputValue().catch(() => '')))
  await page.getByRole('button', { name: 'Document', exact: true }).click()
  await page.getByRole('button', { name: 'Close launch-plan.md' }).click()
  if (await page.getByRole('button', { name: 'Discard changes' }).isVisible().catch(() => false)) await page.getByRole('button', { name: 'Discard changes' }).click()
  await page.getByRole('tab', { name: 'Project files' }).click()

  // F12: workflows as cards in a new conversation; instructions as a document with @ and find.
  const sectionTab = (name: RegExp) => page.getByRole('tablist', { name: 'Sections' }).getByRole('tab', { name })
  await sectionTab(/^Conversations/).click()
  await page.getByRole('button', { name: 'New conversation' }).click()
  // With conversations already here, a new conversation first offers to pick up recent work.
  const fresh = page.getByRole('button', { name: 'Start fresh' })
  await fresh.waitFor({ timeout: 4000 }).then(() => fresh.click(), () => undefined)
  const cards = page.getByRole('region', { name: 'Start with a workflow' })
  check('F12 the project\'s workflows show as cards', await until('cards', async () => (await cards.locator('.workflow-card', { hasText: 'Review changes' }).count()) === 1))
  await composer.fill('Before merging,')
  await cards.locator('.workflow-card', { hasText: 'Review changes' }).click()
  check('F12 a card adds the workflow to what you typed, without running it', await until('card draft', async () => (await composer.inputValue()) === 'Before merging, @workflow:review '),
    JSON.stringify(await composer.inputValue()))
  await shot(page, 'f12-cards')
  await composer.fill('')
  await sectionTab(/^Workflows/).click()
  await page.getByRole('button', { name: 'New workflow' }).click()
  const body = page.locator('.workflow-doc .ProseMirror')
  check('F12 a new workflow puts the cursor in its instructions', await until('focus', async () => body.evaluate((el) => el.contains(document.activeElement))))
  await page.keyboard.type('Then run @rev')
  const atList = page.getByRole('dialog', { name: 'Files and workflows for @' })
  check('F12 typing @ in the document lists workflows', await until('at list', async () => (await atList.getByText('Review changes').count()) > 0))
  await shot(page, 'f12-at-document')
  await page.keyboard.press('Enter')
  check('F12 picking one writes its reference', await until('picked', async () => (await body.innerText()).includes('Then run @workflow:review')), await body.innerText())
  await page.keyboard.press('Meta+f')
  check('F12 ⌘F finds in the instructions too', await until('wf find', async () => bar.isVisible()))
  await findBox.press('Escape')
  await page.getByRole('group', { name: 'Instructions view' }).getByRole('button', { name: 'Source' }).click()
  const source = page.getByRole('textbox', { name: 'Instructions' })
  check('F12 Source shows the same instructions as text', await until('source', async () => (await source.inputValue()).trim() === 'Then run @workflow:review'), JSON.stringify(await source.inputValue().catch(() => '')))
  await source.press('End')
  await source.pressSequentially(' and @long')
  check('F12 the @ list works in Source as well', await until('source at', async () => (await atList.getByText('src/long.ts').count()) > 0))
  await source.press('Enter')
  check('F12 and adds a file reference', await until('file ref', async () => (await source.inputValue()).includes('@file:src%2Flong.ts')), await source.inputValue())
  await page.getByRole('textbox', { name: 'Reference name' }).fill('chain')
  await page.getByRole('button', { name: 'Save workflow' }).click()
  check('F12 the workflow saves with those instructions', await until('saved', async () => (await page.locator('.workflow-list').getByText('chain').count()) > 0))
  await page.getByRole('group', { name: 'Instructions view' }).getByRole('button', { name: 'Document' }).click()
  await shot(page, 'f12-workflow-document')

  // F13: the Design workshop leads the gallery's featured workflows.
  await page.locator('.workflow-gallery-link').click()
  const featuredRow = page.getByRole('region', { name: 'Featured' })
  check('F13 Design workshop is the first featured workflow', await until('featured', async () => (await featuredRow.locator('.gallery-card').first().innerText()).includes('Design workshop')),
    (await featuredRow.innerText().catch(() => '')).slice(0, 120))
  await shot(page, 'f13-gallery')

  // P1 (decision 2): a project setting lets agents manage workflows; off by default.
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await page.getByRole('menuitem', { name: /settings…$/ }).click()
  const settings = page.getByRole('dialog', { name: 'App' })
  const allow = settings.getByRole('checkbox', { name: /Let agents manage workflows/ })
  check('P1 agents managing workflows is off by default', !(await allow.isChecked()))
  await allow.check()
  await shot(page, 'p1-setting')
  await settings.locator('.button-primary').click()
  const stored = async () => ((await page.evaluate(async () => (await (await fetch('/api/projects')).json()).data)) as Array<{ name: string; agentWorkflows?: boolean }>).find((p) => p.name === 'App')?.agentWorkflows
  check('P1 the setting is saved on the project', await until('saved setting', async () => (await stored()) === true))
  await settings.getByRole('button', { name: 'Done' }).click()

  await sectionTab(/^Files/).click()
  await setTheme(page, 'Dark')
  await shot(page, 'files-dark')
  await setTheme(page, 'Light')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(980, 640))
  await page.waitForTimeout(400)
  check('F4 the folder buttons fit the narrow explorer', await explorer.locator('.file-location').evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
  await shot(page, 'files-narrow')
} finally {
  await app.close()
}
finish('PROOF WAVE 4')
