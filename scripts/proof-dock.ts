// U7 app-icon gate, run against the PACKAGED app (npm run package first): `npm run proof:dock`.
// No agent usage: stand-ins only. While an agent works (silent-agent never finishes) the Dock icon
// cycles its frames at about four a second, and returns to the plain icon the moment nothing works;
// the badge counts conversations that need you (ask-agent waits on approvals) and clears at zero.
// The proof wraps app.dock in the main process to watch what Cockpit sets. Whether macOS shows the
// moving icon in the Cmd-Tab switcher is a look-at-it check, not automated here.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright-core'
import { checker, launchPackagedApp, ROOT } from './lib/launch-app.ts'
import { apiPost, openProject } from './lib/ui.ts'

interface DockLog { icons: string[]; badges: string[]; rest: string }
const home = mkdtempSync(join(tmpdir(), 'cockpit-dock-proof-'))
const project = join(home, 'dock-demo')
mkdirSync(project)
writeFileSync(join(project, 'README.md'), '# dock demo\n')

async function launch(agent: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchPackagedApp({ COCKPIT_HOME: join(home, `state-${agent}`), COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures', agent) })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  page.setDefaultTimeout(15_000)
  await openProject(page, project, 'Dock demo')
  // Record each icon by a hash of its whole PNG data (orbit frames can share their top rows, so a
  // slice would merge them), and every badge, as Cockpit sets them.
  await app.evaluate(({ app: electronApp, nativeImage }) => {
    // No named helpers in here: the proof's bundler would wrap them in a __name() the app lacks.
    const dock = electronApp.dock!
    const log = { icons: [] as string[], badges: [] as string[],
      rest: '' }
    { const d = nativeImage.createFromPath(`${electronApp.getAppPath()}/dist-electron/dock/rest.png`).toDataURL(); let h = 0; for (let i = 0; i < d.length; i += 3) h = (h * 31 + d.charCodeAt(i)) | 0; log.rest = `${d.length}:${h}` }
    ;(globalThis as unknown as { dockLog: typeof log }).dockLog = log
    const original = { setIcon: dock.setIcon.bind(dock), setBadge: dock.setBadge.bind(dock) }
    Object.assign(dock, {
      setIcon(image: Electron.NativeImage) { const d = image.toDataURL(); let h = 0; for (let i = 0; i < d.length; i += 3) h = (h * 31 + d.charCodeAt(i)) | 0; log.icons.push(`${d.length}:${h}`); original.setIcon(image) },
      setBadge(text: string) { log.badges.push(text); original.setBadge(text) },
    })
  })
  return { app, page }
}
const dockLog = (app: ElectronApplication): Promise<DockLog> => app.evaluate(() => (globalThis as unknown as { dockLog: DockLog }).dockLog)
const badge = (app: ElectronApplication): Promise<string> => app.evaluate(({ app: a }) => a.dock!.getBadge())
const statusOf = (page: Page, title: string): Promise<string | undefined> => page.evaluate(async (t) =>
  ((await (await fetch('/api/threads')).json()) as { data: Array<{ meta: { title: string }; status: string }> }).data.find((r) => r.meta.title.startsWith(t))?.status, title)

/** Polls the API until `test` holds for the thread statuses (waitForFunction would treat the async check as already true). */
async function untilStatuses(page: Page, what: string, test: (statuses: string[]) => boolean): Promise<void> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const statuses = await page.evaluate(async () => ((await (await fetch('/api/threads')).json()) as { data: Array<{ status: string }> }).data.map((t) => t.status))
    if (test(statuses)) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${statuses.join(', ')}`)
    await page.waitForTimeout(250)
  }
}

const { check, finish } = checker()
let { app, page } = await launch('silent-agent')
try {
  check('the rest frame is packaged', Number((await dockLog(app)).rest.split(':')[0]) > 1_000)
  await apiPost(page, '/api/threads', { projectPath: project, text: 'Keep working on this' })
  await page.locator('.card').filter({ hasText: 'Keep working' }).waitFor()
  await page.waitForTimeout(2_200)
  const moving = await dockLog(app)
  const distinct = new Set(moving.icons).size
  // 2.2 s at FRAME_MS (100 ms) is about 22 frame changes.
  check('while an agent works the icon cycles its frames', moving.icons.length >= 16 && moving.icons.length <= 26 && distinct >= 14,
    `${moving.icons.length} changes in 2.2 s, ${distinct} different`)
  check('the moving frames are not the plain icon', !moving.icons.includes(moving.rest))
  check('working alone sets no badge', await badge(app) === '')

  // The stand-in ignores Stop (it never finishes a turn), so end its session by deleting the conversation.
  await page.evaluate(async () => {
    const id = ((await (await fetch('/api/threads')).json()) as { data: Array<{ meta: { id: string } }> }).data[0]!.meta.id
    await fetch(`/api/threads/${id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{}' })
  })
  await untilStatuses(page, 'nothing working', (all) => !all.includes('working'))
  await page.waitForTimeout(600)
  const stopped = await dockLog(app)
  await page.waitForTimeout(1_000)
  const later = await dockLog(app)
  check('when nothing works the icon goes back to plain and stays still', stopped.icons.at(-1) === stopped.rest && later.icons.length === stopped.icons.length,
    `${later.icons.length - stopped.icons.length} changes after stopping`)
  await app.close()

  ;({ app, page } = await launch('ask-agent'))
  for (const text of ['First needs a decision', 'Second needs a decision']) await apiPost(page, '/api/threads', { projectPath: project, text })
  await untilStatuses(page, 'two waiting', (all) => all.filter((x) => x === 'needs_input').length === 2)
  await page.waitForTimeout(500)
  check('the badge counts conversations that need you', await badge(app) === '2', await badge(app))
  // The turns start as working, so the moon may move until each asks; once both wait, nothing moves.
  const atWait = await dockLog(app)
  await page.waitForTimeout(1_000)
  const stillWaiting = await dockLog(app)
  check('waiting is not working: the icon stays still', stillWaiting.icons.length === atWait.icons.length && (atWait.icons.length === 0 || atWait.icons.at(-1) === atWait.rest),
    `${stillWaiting.icons.length - atWait.icons.length} changes while waiting`)

  await page.locator('.card').filter({ hasText: 'First needs' }).click()
  for (const step of ['echo step 1', 'echo step 2']) {
    const card = page.locator('.approval.open').filter({ hasText: step })
    await card.waitFor()
    await card.getByRole('button', { name: 'Allow', exact: true }).click()
  }
  await untilStatuses(page, 'one waiting', (all) => all.filter((x) => x === 'needs_input').length === 1 && !all.includes('working'))
  await page.waitForTimeout(500)
  check('answering one lowers the badge', await badge(app) === '1', `${await badge(app)} (first is ${await statusOf(page, 'First')})`)

  await page.locator('.card').filter({ hasText: 'Second needs' }).click()
  for (const step of ['echo step 1', 'echo step 2']) {
    const card = page.locator('.approval.open').filter({ hasText: step })
    await card.waitFor()
    await card.getByRole('button', { name: 'Allow', exact: true }).click()
  }
  await untilStatuses(page, 'nothing waiting or working', (all) => !all.includes('needs_input') && !all.includes('working'))
  await page.waitForTimeout(500)
  check('the badge clears when nothing needs you', await badge(app) === '', await badge(app))
  check('the badge only changed when the count did', JSON.stringify((await dockLog(app)).badges) === JSON.stringify(['1', '2', '1', '']) ||
    JSON.stringify((await dockLog(app)).badges) === JSON.stringify(['2', '1', '']), (await dockLog(app)).badges.join(' → '))
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
} finally {
  await app.close()
}
finish('PROOF DOCK')
