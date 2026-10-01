// U1 branch-control gate, run against the PACKAGED app (npm run package first): `npm run proof:git`.
// A scratch repository with a local bare remote. The branch pill must show the branch, switch,
// refuse a switch with uncommitted changes, create-and-switch, push (setting the upstream, then
// again to it), and refuse to switch or create while a conversation in the project is working.
// Claude is replaced by a stand-in that never finishes a turn (scripts/fixtures/silent-agent),
// so the check costs nothing. A folder that is not a repository shows no pill.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { apiPost, headStatus, openProject, startConversation } from './lib/ui.ts'

const ENV = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@example.com', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@example.com' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { env: ENV, encoding: 'utf8' }).trim()

const base = mkdtempSync(join(tmpdir(), 'cockpit-git-proof-'))
const repo = join(base, 'branch-demo')
const remote = join(base, 'remote.git')
const plain = join(base, 'plain-folder')
mkdirSync(repo); mkdirSync(plain)
git(base, 'init', '--bare', '-q', '-b', 'main', remote)
git(repo, 'init', '-q', '-b', 'main')
writeFileSync(join(repo, 'README.md'), '# branch demo\n')
git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'first')
git(repo, 'branch', 'side')
git(repo, 'remote', 'add', 'origin', remote)
const commit = (name: string): void => { writeFileSync(join(repo, name), `${name}\n`); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', name) }
const onDisk = (): string => git(repo, 'branch', '--show-current')

const { check, finish } = checker()
const app = await launchPackagedApp({ COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/silent-agent') })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')

const pill = (p: Page) => p.getByRole('button', { name: 'Branch', exact: true })
const panel = (p: Page) => p.getByRole('dialog', { name: 'Branches' })
const row = (p: Page, name: string) => panel(p).getByRole('option', { name: new RegExp(`^${name.replace(/[/.]/g, '\\$&')}\\b`) })
/** Closes and reopens the panel, which re-reads the repository. */
async function reopen(p: Page): Promise<void> {
  if (await panel(p).isVisible()) await p.keyboard.press('Escape')
  await pill(p).click()
  await panel(p).waitFor()
  await p.waitForTimeout(400)
}

try {
  await openProject(page, repo, 'Branch demo')
  await pill(page).waitFor({ timeout: 15_000 })
  check('pill shows the current branch', (await pill(page).textContent())?.includes('main') ?? false, await pill(page).textContent() ?? '')

  await reopen(page)
  check('panel says the branch is project-wide', await panel(page).getByText('Applies to every conversation in this project.').isVisible())
  check('lists local branches with the current one marked', (await row(page, 'main').textContent())?.includes('Current') === true && await row(page, 'side').isEnabled())

  writeFileSync(join(repo, 'draft.md'), 'wip\n')
  await reopen(page)
  check('uncommitted changes block switching', !(await row(page, 'side').isEnabled()) && (await row(page, 'side').textContent())?.includes('Commit or stash first') === true)
  check('the panel says how many changes', await panel(page).getByText(/^1 uncommitted change\./).isVisible())
  rmSync(join(repo, 'draft.md'))

  await reopen(page)
  await row(page, 'side').click()
  await panel(page).getByText('Switched to side.').waitFor({ timeout: 15_000 })
  check('switching moves the repository', onDisk() === 'side', onDisk())
  check('pill follows the switch', (await pill(page).textContent())?.includes('side') ?? false)

  const input = panel(page).getByRole('textbox', { name: 'Find or name a branch' })
  await input.fill('feature/proof')
  check('typing a new name offers to create it', await panel(page).getByRole('button', { name: /New branch “feature\/proof”/ }).isVisible())
  await input.press('Enter')
  await panel(page).getByText('Created and switched to feature/proof.').waitFor({ timeout: 15_000 })
  check('create-and-switch on disk', onDisk() === 'feature/proof', onDisk())

  commit('one.txt')
  await reopen(page)
  check('a branch without upstream says so', await panel(page).getByText('Not pushed yet').isVisible())
  await panel(page).getByRole('button', { name: 'Push' }).click()
  await panel(page).getByText('Pushed to origin/feature/proof.').waitFor({ timeout: 60_000 })
  check('first push sets the upstream and reaches the remote', git(remote, 'rev-parse', 'feature/proof') === git(repo, 'rev-parse', 'HEAD')
    && git(repo, 'rev-parse', '--abbrev-ref', '@{upstream}') === 'origin/feature/proof')

  commit('two.txt')
  await reopen(page)
  check('pill shows unpushed commits', (await pill(page).textContent())?.includes('↑1') ?? false, await pill(page).textContent() ?? '')
  await panel(page).getByRole('button', { name: 'Push' }).click()
  await panel(page).getByText('Pushed to origin/feature/proof.').waitFor({ timeout: 60_000 })
  check('second push updates the remote', git(remote, 'rev-parse', 'feature/proof') === git(repo, 'rev-parse', 'HEAD'))
  await page.keyboard.press('Escape')

  await startConversation(page, 'Keep working on the branch demo')
  await headStatus(page).filter({ hasText: 'Working' }).waitFor({ timeout: 30_000 })
  await reopen(page)
  check('a working conversation is named in the panel', await panel(page).getByText(/^Switching waits until Keep working on the branch demo finishes\./).isVisible())
  check('switch rows are disabled while it works', !(await row(page, 'main').isEnabled()))
  await panel(page).getByRole('textbox', { name: 'Find or name a branch' }).fill('blocked-branch')
  check('creating is disabled while it works', !(await panel(page).getByRole('button', { name: /New branch “blocked-branch”/ }).isEnabled()))
  const refused = await apiPost(page, '/api/git/switch', { projectPath: repo, branch: 'main' }) as { error?: string }
  check('the API refuses the switch too', refused.error?.includes('Keep working on the branch demo') === true, refused.error)
  check('repository stayed on its branch', onDisk() === 'feature/proof', onDisk())
  await page.screenshot({ path: join(PROOF_DIR, 'proof-git-working.png') })
  await page.keyboard.press('Escape')

  await openProject(page, plain, 'Plain folder')
  await page.getByRole('button', { name: 'New conversation' }).click().catch(() => {})
  await page.getByRole('textbox', { name: 'Message' }).waitFor({ timeout: 15_000 })
  await page.waitForTimeout(800)
  check('no pill outside a repository', (await pill(page).count()) === 0)
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message : String(error))
  await page.screenshot({ path: join(PROOF_DIR, 'proof-git-failure.png') }).catch(() => {})
} finally {
  await app.close()
}
mkdirSync(PROOF_DIR, { recursive: true })
finish('PROOF GIT')
