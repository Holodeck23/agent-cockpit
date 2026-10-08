// Packaged proof for Report a bug / Send feedback (the toolbar button, top right, as in Enjoy).
// Cockpit has no service of its own: the dialog fills in a new GitHub issue and hands it to the
// browser. Only that hand-off is stubbed (shell.openExternal in the main process records the link
// instead of opening it); the button, dialog, IPC and the link Cockpit builds are the app's own.
// Usage: npm run package:proof, then COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:feedback
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR } from './lib/launch-app.ts'
import { openProject, setTheme } from './lib/ui.ts'

const { check, finish } = checker()
const root = mkdtempSync(join(tmpdir(), 'cockpit-feedback-proof-'))
const project = join(root, 'garden')
mkdirSync(project)
writeFileSync(join(project, 'README.md'), '# garden\n')
mkdirSync(PROOF_DIR, { recursive: true })
const shot = (page: Page, name: string) => page.screenshot({ path: join(PROOF_DIR, `feedback-${name}.png`) })

async function until<T>(label: string, read: () => Promise<T | undefined | false>, ms = 10_000): Promise<T | undefined> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await read().catch(() => undefined)
    if (value) return value
    await new Promise((r) => setTimeout(r, 150))
  }
  console.log(`  (timed out waiting for ${label})`)
  return undefined
}
const opened = (app: ElectronApplication): Promise<string[]> => app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? [])

let app: ElectronApplication | undefined
try {
  app = await launchPackagedApp({ COCKPIT_HOME: join(root, 'state') })
  await app.evaluate(({ shell }) => {
    const sink: string[] = []
    ;(globalThis as { __opened?: string[] }).__opened = sink
    shell.openExternal = async (url: string) => { sink.push(url) }
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await openProject(page, project, 'Garden')

  const button = page.getByRole('button', { name: 'Report a bug or send feedback' })
  const box = await button.boundingBox()
  const width = page.viewportSize()?.width ?? 0
  check('the Feedback button sits in the top right', Boolean(box && box.y < 160 && box.x > width / 2), JSON.stringify(box))
  await shot(page, 'toolbar')
  await button.click()
  const dialog = page.getByRole('dialog', { name: 'Report a bug' })
  await dialog.waitFor()
  check('it opens a dialog for a bug, with the title box focused', await dialog.getByLabel('Title').evaluate((el) => el === document.activeElement))
  check('Continue is unavailable until there is a title', await dialog.getByRole('button', { name: 'Continue on GitHub' }).isDisabled())
  check('it says the issue is public and is submitted on GitHub', (await dialog.textContent())?.includes('public') === true)
  const version = await app.evaluate(({ app: a }) => a.getVersion())
  check('Include names this Cockpit\'s version', Boolean(await until('version', async () => (await dialog.textContent())?.includes(`Include Cockpit ${version}`))))
  await dialog.getByLabel('Title').fill('Stop does nothing')
  await dialog.getByLabel('Details').fill('Clicked Stop twice.\nThe agent kept going.')
  for (const theme of ['Light', 'Dark'] as const) { await setTheme(page, theme); await shot(page, `bug-${theme.toLowerCase()}`) }
  await setTheme(page, 'Light')
  await dialog.getByRole('button', { name: 'Continue on GitHub' }).click()
  const first = await until('link handed to the browser', async () => (await opened(app!))[0])
  const u = first ? new URL(first) : undefined
  check('the browser gets a new issue on the Cockpit repository', `${u?.origin}${u?.pathname}` === 'https://github.com/Holodeck23/agent-cockpit/issues/new', first)
  check('titled as a bug, with the words as written', u?.searchParams.get('title') === 'Bug: Stop does nothing'
    && u.searchParams.get('body')?.startsWith('Clicked Stop twice.\nThe agent kept going.') === true)
  const macos = await app.evaluate(() => process.getSystemVersion())
  check('with the version and macOS, and no file paths', u?.searchParams.get('body')?.endsWith(`Cockpit ${version} · macOS ${macos} (${process.arch})`) === true
    && !/\/Users\/|\/private\//.test(first ?? ''), u?.searchParams.get('body') ?? '')
  check('the dialog says it is open in the browser and nothing was sent', await dialog.getByRole('status').getByText(/Nothing was sent from Cockpit/).isVisible())
  await shot(page, 'opened')
  await dialog.getByRole('button', { name: 'Done' }).click()
  await dialog.waitFor({ state: 'detached' })

  await button.click()
  const idea = page.getByRole('dialog', { name: /Report a bug|Send feedback/ })
  await idea.getByText('An idea or a comment').click()
  check('choosing an idea retitles it Send feedback', await page.getByRole('dialog', { name: 'Send feedback' }).isVisible())
  await idea.getByLabel('Title').fill('Rename a worktree')
  await idea.getByRole('checkbox').uncheck()
  await idea.getByRole('button', { name: 'Continue on GitHub' }).click()
  const second = await until('second link', async () => (await opened(app!))[1])
  const v = second ? new URL(second) : undefined
  check('feedback is titled as feedback', v?.searchParams.get('title') === 'Feedback: Rename a worktree')
  check('with Include off, nothing about the Mac goes in', v?.searchParams.get('body') === '' , v?.searchParams.get('body') ?? '')
  await page.keyboard.press('Escape')
  check('Escape closes it', await idea.waitFor({ state: 'detached', timeout: 3_000 }).then(() => true, () => false))

  await page.setViewportSize({ width: 700, height: 760 })
  await shot(page, 'toolbar-narrow')
  await button.click()
  const narrow = page.getByRole('dialog', { name: 'Report a bug' })
  await narrow.waitFor()
  await shot(page, 'narrow')
  check('narrow: the dialog fits without sideways scroll', await narrow.evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
  check('narrow: the button stays reachable', await button.isVisible())
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
} finally {
  await app?.close().catch(() => undefined)
}
finish('proof:feedback')
