// Phase B gates, run against the PACKAGED app (npm run package first).
//   tsx scripts/proof-b.ts b1   project tab bar, sub-nav, Projects menu, dark mode
//   tsx scripts/proof-b.ts b2   conversation list: filters + counts, search, unread, show completed
//   tsx scripts/proof-b.ts b3   thread + composer: empty state, steps, approvals, picker, stop, dark
// Real Haiku threads supply the live states: two working, one waiting on an approval.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR } from './lib/launch-app.ts'
import { apiPost, chooseAgent, headStatus, messageBox, setTheme } from './lib/ui.ts'

mkdirSync(PROOF_DIR, { recursive: true })
const { check, finish } = checker()
const mode = process.argv[2] ?? 'b1'

const ESSAY = 'Write a 3000 word essay on the history of coffee. Plain text, no tools.'
const APPROVAL = 'Use the Write tool to create notes.txt containing hello. Do not ask questions.'

function folder(name: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'cockpit-b-')), name)
  mkdirSync(dir)
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`)
  return dir
}

async function startThread(page: Page, projectPath: string, text: string): Promise<void> {
  await apiPost(page, '/api/threads', { projectPath, text, settings: { model: 'haiku', permissionMode: 'manual' } })
}

interface Summary {
  status: string
  meta: { id: string; title: string; projectPath: string }
}

async function threads(page: Page): Promise<Summary[]> {
  return page.evaluate(async () => ((await (await fetch('/api/threads')).json()) as { data: Summary[] }).data)
}

/** Polls from Node: page.waitForFunction does not await an async predicate (a Promise is truthy). */
async function waitUntil(page: Page, what: string, test: (all: Summary[]) => boolean, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!test(await threads(page))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await page.waitForTimeout(500)
  }
}

async function waitForStatuses(page: Page, want: { working: number; needs: number }): Promise<void> {
  await waitUntil(page, `${want.working} working + ${want.needs} needs you`, (all) =>
    all.filter((t) => t.status === 'working').length >= want.working && all.filter((t) => t.status === 'needs_input').length >= want.needs,
  )
}

/** The whole window including the native traffic lights (needs Screen Recording permission). */
async function captureWindow(app: Awaited<ReturnType<typeof launchPackagedApp>>, file: string): Promise<boolean> {
  try {
    const sourceId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getMediaSourceId() ?? '')
    const windowId = sourceId.split(':')[1]
    if (!windowId) return false
    execFileSync('screencapture', ['-x', '-o', `-l${windowId}`, file], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

const sprout = folder('sprout')
const bakery = folder('bakery-website')
const studio = folder('studio-portfolio')

const app = await launchPackagedApp()
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')

for (const [path, name] of [
  [bakery, 'Bakery website'],
  [studio, 'Studio portfolio'],
  [sprout, 'Sprout'],
] as const) {
  await apiPost(page, '/api/projects', { path, name, pinned: true })
}
await startThread(page, bakery, APPROVAL)
await startThread(page, bakery, ESSAY)
await startThread(page, studio, ESSAY)
await apiPost(page, '/api/projects', { path: sprout })
await page.evaluate((path) => localStorage.setItem('cockpit:active-project', path), sprout)
await page.reload()
await waitForStatuses(page, { working: 2, needs: 1 })


async function b1(): Promise<void> {
  const tabs = page.getByRole('tablist', { name: 'Projects' }).getByRole('tab')
  await page.getByRole('tab', { name: /Bakery website/ }).getByLabel('1 need you').waitFor({ timeout: 15_000 })
  const tabNames = await tabs.locator('.tab-name').allTextContents()
  check('three pinned project tabs, alphabetical', tabNames.join(' | ') === 'Bakery website | Sprout | Studio portfolio', tabNames.join(' | '))
  check('Sprout is the active tab', (await page.getByRole('tab', { selected: true, name: /Sprout/ }).count()) === 1)
  check('Bakery tab shows 1 working + 1 needs you', (await page.getByRole('tab', { name: /Bakery website/ }).getByLabel('1 working').count()) === 1)
  check('Studio tab shows 1 working', (await page.getByRole('tab', { name: /Studio portfolio/ }).getByLabel('1 working').count()) === 1)
  const tabbarBg = await page.locator('.tabbar').evaluate((el) => getComputedStyle(el).backgroundColor)
  check('tab bar uses the topbar token (light)', tabbarBg === 'rgb(229, 229, 223)', tabbarBg)
  const dragRegion = await page.locator('.tabbar').evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))
  check('tab bar drags the window', dragRegion === 'drag', dragRegion)
  await page.screenshot({ path: join(PROOF_DIR, 'phase-B1-chrome.png') })
  const fullWindow = await captureWindow(app, join(PROOF_DIR, 'phase-B1-window.png'))
  console.log(fullWindow ? 'window capture with traffic lights: docs/proof/phase-B1-window.png' : 'window capture skipped (no Screen Recording permission)')

  await page.getByRole('button', { name: 'Projects' }).click()
  const menuItems = await page.getByRole('menu', { name: 'Projects' }).getByRole('menuitem').allTextContents()
  check('Projects menu offers Open folder…, project settings and all three projects',
    menuItems.length === 5 && menuItems[0]?.includes('Open folder') === true && menuItems[1]?.includes('settings') === true,
    `${menuItems.length} items`)
  await page.screenshot({ path: join(PROOF_DIR, 'phase-B1-projects-menu.png') })
  await page.keyboard.press('Escape')

  await page.getByRole('tab', { name: /Bakery website/ }).click()
  check('switching tabs filters conversations to that project', (await page.locator('.card').count()) === 2)
  check('sub-nav shows the working count', (await page.locator('.subnav').getByLabel('1 working').count()) === 1)

  await setTheme(page, 'Dark')
  const dark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)
  const darkBg = await page.locator('.tabbar').evaluate((el) => getComputedStyle(el).backgroundColor)
  check('dark toggle switches tokens and native chrome', dark && darkBg === 'rgb(23, 23, 23)', `native dark=${dark}, tabbar ${darkBg}`)
  await page.getByRole('tab', { name: /Sprout/ }).click()
  await page.screenshot({ path: join(PROOF_DIR, 'phase-B1-dark.png') })
  await page.getByRole('tab', { name: 'Files' }).click()
  check('Files section shows its placeholder', await page.getByRole('heading', { name: 'Files' }).isVisible())
  await setTheme(page, 'System')
}

async function b2(): Promise<void> {
  // Two more finished threads in Bakery: one to search for, one to mark completed.
  await startThread(page, bakery, 'List three prime numbers, one per line.')
  await startThread(page, bakery, 'Name two colours of the rainbow, comma separated.')
  await page.getByRole('tab', { name: /Bakery website/ }).click()
  await waitUntil(page, 'two finished Bakery threads', (all) => all.filter((t) => t.meta.projectPath === bakery && t.status === 'done').length >= 2)
  const count = async (label: string): Promise<string> =>
    (await page.getByRole('tablist', { name: 'Filter conversations' }).getByRole('tab', { name: new RegExp(`^${label}`) }).locator('.filter-count').textContent()) ?? ''
  check('filter counts: All 4 · Needs you 1 · Working 1', `${await count('All')}/${await count('Needs you')}/${await count('Working')}` === '4/1/1',
    `${await count('All')}/${await count('Needs you')}/${await count('Working')}`)
  const unreadBefore = Number(await count('Unread'))
  check('conversations finished in the background count as unread', unreadBefore >= 2, String(unreadBefore))

  const cards = page.locator('.card')
  await cards.filter({ hasText: 'prime numbers' }).click()
  const unreadAfter = Number(await count('Unread'))
  check('opening a conversation marks it read', unreadAfter === unreadBefore - 1, `${unreadBefore} -> ${unreadAfter}`)
  await cards.filter({ hasText: 'essay' }).click()
  check('working card shows the Working pill', (await page.locator('.card.selected .pill-working').count()) === 1)
  check('needs-you card shows its pill', (await page.locator('.card .pill-needs_input').count()) === 1)
  check('cards show agent and day', (await page.locator('.card.selected .card-meta').textContent()) === 'Claude Code · Today')
  await page.screenshot({ path: join(PROOF_DIR, 'phase-B2-list.png') })

  await page.getByRole('searchbox', { name: 'Search conversations' }).fill('prime')
  check('search narrows to matching conversations', (await cards.count()) === 1 && (await count('All')) === '1')
  await page.getByRole('searchbox', { name: 'Search conversations' }).fill('')

  const colours = (await threads(page)).find((t) => t.meta.projectPath === bakery && t.meta.title.startsWith('Name two colours'))?.meta.id
  if (colours) await apiPost(page, `/api/threads/${colours}/completed`, { completed: true })
  await page.reload()
  await page.getByLabel('Show completed').uncheck()
  check('hiding completed drops it from list and counts', (await count('All')) === '3' && (await cards.count()) === 3, await count('All'))
  check('footer counts what is listed', (await page.locator('.list-foot span').first().textContent()) === '3 conversations')
  await page.getByLabel('Show completed').check()

  await page.getByRole('tablist', { name: 'Filter conversations' }).getByRole('tab', { name: /^Needs you/ }).click()
  check('Needs you tab lists only that conversation', (await cards.count()) === 1)
  await page.getByRole('tablist', { name: 'Filter conversations' }).getByRole('tab', { name: /^All/ }).click()
  await cards.filter({ hasText: 'essay' }).click()

  await setTheme(page, 'Dark')
  await page.screenshot({ path: join(PROOF_DIR, 'phase-B2-dark.png') })
  await setTheme(page, 'System')

  await page.getByRole('tab', { name: /Sprout/ }).click()
  check('empty project shows the empty state', await page.getByText('No conversations yet').isVisible())
  const overflow = await page.locator('.filters').evaluate((el) => el.scrollWidth - el.clientWidth)
  check('all four filter tabs fit without scrolling', overflow <= 0, `${overflow}px over`)
  await page.screenshot({ path: join(PROOF_DIR, 'phase-B2-empty.png') })
}

async function b3(): Promise<void> {
  const READ = 'Use the Read tool on README.md, then reply with only its first line.'
  await startThread(page, bakery, READ)
  await waitUntil(page, 'the Read thread to finish', (all) => all.some((t) => t.meta.title.startsWith('Use the Read tool') && t.status === 'done'))

  // Empty state in Sprout (the active project at setup).
  check('empty state asks what you are working on', await page.getByRole('heading', { name: 'What are you working on?' }).isVisible())
  check('three suggestion cards', (await page.locator('.suggestion').count()) === 3)
  check('composer placeholder for a new conversation', (await messageBox(page).getAttribute('placeholder')) === 'Describe what you want…')
  await chooseAgent(page, { model: 'haiku' })
  check('agent picker shows agent, model and effort', (await page.locator('.picker-button').textContent()) === 'Claude CodeHaiku · Default effort')
  await page.screenshot({ path: join(PROOF_DIR, 'phase-B3-empty.png') })

  // A finished turn with a tool call, in Bakery.
  await page.getByRole('tab', { name: /Bakery website/ }).click()
  await page.locator('.card').filter({ hasText: 'Read tool' }).click()
  const step = (await page.locator('.step').first().textContent()) ?? ''
  check('tool call collapses into a timed activity line', /^Reading README\.md· \d:\d\d$/.test(step), step)
  const authors = await page.locator('.author-name').allTextContents()
  check('author rows for you and the agent', authors.includes('You') && authors.includes('Claude Code'), authors.join(', '))
  check('header status reads Ready', (await headStatus(page).textContent()) === 'Ready')
  await page.getByRole('button', { name: 'More' }).click()
  check('the conversation menu shows the transcript path', /\/threads\/[0-9a-f-]+\/messages\.md$/.test((await page.locator('.menu-path').textContent()) ?? ''))
  await page.keyboard.press('Escape')

  // A running turn.
  await page.locator('.card').filter({ hasText: 'essay' }).click()
  await page.getByRole('heading', { level: 1, name: /3000 word essay/ }).waitFor()
  const working = await headStatus(page).filter({ hasText: 'Working' }).waitFor({ timeout: 10_000 }).then(() => true, () => false)
  check('header status reads Working', working, (await headStatus(page).textContent()) ?? '')
  const essayId = (await threads(page)).find((t) => t.meta.title.includes('3000 word essay') && t.meta.projectPath === bakery)?.meta.id ?? ''
  await page.locator('.bubble.streaming').waitFor({ timeout: 30_000 })
  const shown = (await page.locator('.bubble.streaming').textContent()) ?? ''
  const serverStart = await page.evaluate(async (id) => ((await (await fetch(`/api/threads/${id}/events`)).json()) as { data: { streaming: string } }).data.streaming.slice(0, 40), essayId)
  check('opening mid-turn shows the whole message so far, not a fragment', shown.length > 40 && shown.startsWith(serverStart), shown.slice(0, 40))
  check('follow-up placeholder while running', (await messageBox(page).getAttribute('placeholder')) === 'Add to the current turn…')
  await page.getByRole('button', { name: 'Agent settings' }).click()
  const locked = page.getByRole('dialog', { name: 'Agent settings' })
  check('agent switch is locked mid-turn', (await locked.getByRole('button', { name: /^(Switch|Apply)$/ }).isDisabled()) && (await locked.textContent())?.includes('Stop the current turn before switching.') === true)
  await page.keyboard.press('Escape')
  await page.screenshot({ path: join(PROOF_DIR, 'phase-B3-working.png') })

  // An approval, answered inline.
  await page.locator('.card').filter({ hasText: 'Use the Write tool' }).click()
  const card = page.locator('.approval.open')
  await card.waitFor({ timeout: 15_000 })
  check('approval card names agent and tool', ((await card.locator('.approval-title').textContent()) ?? '') === 'Claude Code wants to use Write')
  await page.screenshot({ path: join(PROOF_DIR, 'phase-B3-approval.png') })
  await card.getByRole('button', { name: 'Allow', exact: true }).click()
  await headStatus(page).filter({ hasText: /Ready|Error/ }).waitFor({ timeout: 90_000 })
  const notes = join(bakery, 'notes.txt')
  check('allowing it let the agent write the file', existsSync(notes) && readFileSync(notes, 'utf8').includes('hello'))
  check('answered approval folds into a decision line', (await page.locator('details.decisions summary', { hasText: '1 decision · Allowed' }).count()) === 1
    && (await page.locator('details.decisions li', { hasText: 'Write' }).count()) === 1)

  // Dark mode on the running turn.
  await setTheme(page, 'Dark')
  await page.locator('.card').filter({ hasText: 'essay' }).click()
  await page.screenshot({ path: join(PROOF_DIR, 'phase-B3-dark.png') })
  await setTheme(page, 'System')

  // Stop.
  await page.getByRole('button', { name: 'Stop' }).click()
  await page.locator('.note', { hasText: 'Stopped' }).waitFor({ timeout: 30_000 })
  check('Stop ends the turn with a Stopped note', (await headStatus(page).textContent()) !== 'Working')

  // A suggestion only fills the message box (a stray click must never start a run); Enter sends it.
  await page.getByRole('tab', { name: /Sprout/ }).click()
  await page.locator('.suggestion').first().click()
  const message = messageBox(page)
  // The prefill lands on the next render; wait for it rather than reading once.
  await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.value === 'Explain how this project is put together', undefined, { timeout: 5_000 }).catch(() => undefined)
  check('suggestion fills the message box', (await message.inputValue()) === 'Explain how this project is put together', JSON.stringify(await message.inputValue()))
  check('suggestion alone starts nothing', (await page.locator('.card').count()) === 0)
  check('message box has focus after a suggestion', await message.evaluate((el) => el === document.activeElement))
  await page.keyboard.press('Enter')
  await page.getByRole('heading', { level: 1, name: 'Explain how this project is put together' }).waitFor({ timeout: 15_000 })
  check('Enter then started a conversation in Sprout', (await page.locator('.card').count()) === 1)
}

if (mode === 'b1') await b1()
else if (mode === 'b2') await b2()
else if (mode === 'b3') await b3()
else throw new Error(`unknown mode ${mode}`)

await app.close()
finish(`PHASE ${mode.toUpperCase()}`)
