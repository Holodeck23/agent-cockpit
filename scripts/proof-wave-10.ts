// Packaged gate for wave 10 (orders 12–13): the agent picker's checked details and Refresh, the
// install / update / sign-in actions, Antigravity's listed models and the per-project tools opt-in
// (P3). Stand-ins only (scripts/fixtures/wave10-cli, antigravity-agent): the app runs with its own
// throwaway HOME and a stand-in login shell whose PATH has no Homebrew, so none of the real CLIs on
// this Mac is seen or touched. The live routes are 13d's evidence, not this proof's.
// Usage: npm run package:proof, then COCKPIT_APP=$PWD/release/proof/mac-arm64/Cockpit.app npm run proof:wave-10
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from 'playwright-core'
import { checker, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { openProject, setTheme } from './lib/ui.ts'

const { check, finish } = checker()
const FIX = join(ROOT, 'scripts/fixtures/wave10-cli')
const root = mkdtempSync(join(tmpdir(), 'cockpit-wave10-proof-'))
const home = join(root, 'home'), state = join(root, 'state'), project = join(root, 'garden'), installers = join(root, 'installers')
for (const dir of [project, installers, join(home, '.fcli'), join(home, '.local/bin'), join(home, '.local/share/claude/versions')]) mkdirSync(dir, { recursive: true })
writeFileSync(join(project, 'README.md'), '# garden\n')
copyFileSync(join(FIX, 'fcli'), join(home, '.fcli/fcli'))
copyFileSync(join(ROOT, 'scripts/fixtures/claude-help.txt'), join(home, '.fcli/claude-help.txt'))
copyFileSync(join(FIX, 'chatgpt.com.sh'), join(installers, 'chatgpt.com.sh'))
// Claude as its native installer leaves it: a versioned file, linked from ~/.local/bin. Signed out.
const claudeFile = join(home, '.local/share/claude/versions/2.1.289')
copyFileSync(join(FIX, 'fcli'), claudeFile)
symlinkSync(claudeFile, join(home, '.local/bin/claude'))
// Antigravity where its installer puts it. Codex is not installed.
copyFileSync(join(ROOT, 'scripts/fixtures/antigravity-agent/agy'), join(home, '.local/bin/agy'))
for (const file of [claudeFile, join(home, '.fcli/fcli'), join(home, '.local/bin/agy')]) chmodSync(file, 0o755)
mkdirSync(PROOF_DIR, { recursive: true })

async function until(label: string, test: () => Promise<boolean>, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await test().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 150)) }
  console.log(`  (timed out waiting for ${label})`)
  return false
}
const shot = (page: Page, name: string) => page.screenshot({ path: join(PROOF_DIR, `wave10-${name}.png`) })
const picker = (page: Page): Locator => page.getByRole('dialog', { name: 'Agent settings' })
const details = (page: Page): Locator => picker(page).getByRole('group', { name: 'Checked details' })
const lifecycle = (page: Page): Locator => picker(page).getByRole('group', { name: 'Install and updates' })
const text = async (locator: Locator): Promise<string> => (await locator.innerText().catch(() => '')).replace(/\s+/g, ' ')
const opLine = (page: Page): Locator => lifecycle(page).locator('.lifecycle-op .agent-state-line')
async function pick(page: Page, label: string, ready: RegExp): Promise<void> {
  // A missing CLI's radio reads "Codex Unavailable".
  await picker(page).getByRole('radio', { name: new RegExp(`^${label}`) }).click()
  await until(`${label} details`, async () => ready.test(`${await text(details(page))} ${await text(lifecycle(page))}`))
}
/** Opens an action, checks what it says before anything runs, then confirms it. */
async function confirmAction(page: Page, label: string, expect: RegExp): Promise<string> {
  await lifecycle(page).getByRole('button', { name: `${label}…`, exact: true }).click()
  const confirm = lifecycle(page).locator('.lifecycle-confirm')
  const said = await text(confirm)
  check(`${label}: says what will happen before it runs`, expect.test(said), said)
  await confirm.getByRole('button', { name: label, exact: true }).click()
  return said
}
const opLogs = (): string => {
  const dir = join(state, 'agent-operations')
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.log')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n') : ''
}

let app: ElectronApplication | undefined
try {
  app = await launchPackagedApp({ HOME: home, SHELL: join(FIX, 'login-shell'), COCKPIT_HOME: state, COCKPIT_PROOF_INSTALLERS: installers }, ['--use-mock-keychain'])
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await openProject(page, project, 'Garden')
  await page.getByRole('button', { name: 'Agent settings' }).click()

  // 1. Claude: where it is, who installed it, signed out; the actions that fit (W10-01, W10-05).
  await pick(page, 'Claude Code', /Checked \d/)
  const claudeSeen = await text(details(page))
  check('1 the picker shows the checked path and installer', claudeSeen.includes(`${join(home, '.local/bin/claude')} · Claude Code native installer`), claudeSeen)
  check('1 and that it is not signed in', claudeSeen.includes('Not signed in'), claudeSeen)
  const actions = await text(lifecycle(page))
  check('1 offers Sign in and Update, never a second install', /Sign in…/.test(actions) && /Update…/.test(actions) && !/Install…/.test(actions), actions)
  await shot(page, 'claude-signed-out')

  // 2. Sign in (W10-06): confirmed, followed, verified by the CLI; credentials never shown or logged.
  await confirmAction(page, 'Sign in', /Opens your browser/)
  check('2 sign-in ends verified by the CLI', await until('signed in', async () => (await text(opLine(page))).includes('Sign in: Signed in')), await text(opLine(page)))
  check('2 the checked details follow without a manual Refresh', await until('details signed in', async () => (await text(details(page))).includes('Signed in · claude.ai · max')), await text(details(page)))
  check('2 and the result stays on screen after that re-check', (await text(opLine(page))).includes('Sign in: Signed in'), await text(opLine(page)))
  const output = await text(lifecycle(page).locator('.lifecycle-output'))
  check('2 the shown output has the credential and address removed', output.includes('<secret>') && output.includes('<email>') && !/sk-ant-proofmarker|proof\.user@/.test(output), output)
  check('2 and so does the log on disk', opLogs().includes('Login successful') && !/sk-ant-proofmarker|proof\.user@/.test(opLogs()))
  await shot(page, 'claude-signed-in')

  // 3. Update (W10-07): by the manager that owns it, then read again.
  await confirmAction(page, 'Update', /Updates .*2\.1\.289/)
  check('3 update ends with the new version read back', await until('updated', async () => /Update: Updated/.test(await text(opLine(page))) && /updated to 2\.1\.292/.test(await text(lifecycle(page))), 20_000), await text(lifecycle(page)))

  // 4. Codex is missing: install with the official installer; changed bytes are refused, then run only on request.
  await pick(page, 'Codex', /Install…/)
  const codexBefore = await text(lifecycle(page))
  check('4 a missing Codex offers Install', /Install…/.test(codexBefore), codexBefore)
  await confirmAction(page, 'Install', new RegExp(`Installs to ${join(home, '.local/bin/codex').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} with the official installer`))
  const anyway = lifecycle(page).getByRole('button', { name: 'Install this version anyway' })
  check('4 an installer that changed since release is not run', await until('changed', async () => (await anyway.count()) === 1), await text(lifecycle(page)))
  const refused = await text(lifecycle(page))
  check('4 the user is told why, with the vendor address and the new hash', /has changed since this version of Cockpit was released/.test(refused) && /chatgpt\.com\/codex\/install\.sh/.test(refused) && /sha256 [0-9a-f]{12}/.test(refused), refused)
  check('4 and nothing was installed', !existsSync(join(home, '.local/bin/codex')))
  await shot(page, 'codex-installer-changed')
  await anyway.click()
  check('4 Install this version anyway installs it', await until('installed', async () => (await text(opLine(page))).includes('Install: Installed, sign-in needed'), 20_000), await text(lifecycle(page)))
  check('4 the details show the new copy and its installer', await until('codex details', async () => (await text(details(page))).includes(`${join(home, '.local/bin/codex')} · Codex standalone installer`)), await text(details(page)))
  check('4 and offer Sign in next', /Sign in…/.test(await text(lifecycle(page))), await text(lifecycle(page)))

  // 5. Light, dark, narrow on the picker.
  await shot(page, 'codex-installed-light')
  await page.keyboard.press('Escape')
  await setTheme(page, 'Dark')
  await page.getByRole('button', { name: 'Agent settings' }).click()
  await shot(page, 'codex-installed-dark')
  await page.keyboard.press('Escape')
  // The narrowest width that still shows the composer (below 760 the window is list-only).
  await page.setViewportSize({ width: 980, height: 640 })
  await page.getByRole('button', { name: 'Agent settings' }).click()
  await details(page).waitFor()
  const fits = await page.evaluate(() => {
    const box = document.querySelector('[role="dialog"][aria-label="Agent settings"]')?.getBoundingClientRect()
    // Not under the section bar: its top edge is the panel's ceiling.
    const bar = document.querySelector('[role="tablist"][aria-label="Sections"]')?.getBoundingClientRect()
    return { page: document.documentElement.scrollWidth <= innerWidth, picker: box !== undefined && box.left >= 0 && box.right <= innerWidth, top: box !== undefined && bar !== undefined && box.top >= bar.bottom }
  })
  check('5 the picker fits a narrow, short window', fits.page && fits.picker && fits.top, JSON.stringify(fits))
  await shot(page, 'codex-installed-narrow')
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1360, height: 860 })
  await setTheme(page, 'Light')
  await page.getByRole('button', { name: 'Agent settings' }).click()

  // 6. Antigravity: never run just to fill the view; Refresh checks it, and its models come from `agy models` (W10-01, W10-03).
  await pick(page, 'Antigravity', /Antigravity installer/)
  const before = await text(details(page))
  check('6 Antigravity is not run just to show the picker', before.includes('Not checked yet'), before)
  await details(page).getByRole('button', { name: 'Refresh' }).click()
  check('6 Refresh checks it', await until('refreshed', async () => { const now = await text(details(page)); return /Checked \d/.test(now) && now.includes('Antigravity installer') }), `${before} → ${await text(details(page))}`)
  const models = await picker(page).locator('datalist#models-antigravity option').evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value))
  check('6 and its models come from agy itself', models.includes('gemini-3.8-flash-low') && models.includes('gemini-3.1-pro-high'), models.join(', '))
  await page.keyboard.press('Escape')

  // 7. P3: Cockpit's tools for Antigravity, in this project only, on and off.
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Garden settings…' }).click()
  const tools = page.locator('.project-settings').getByRole('checkbox', { name: /Give Antigravity Cockpit/ })
  await tools.check()
  const plugin = join(project, '.agents/plugins/cockpit')
  check('7 turning it on writes the project plugin', await until('plugin', async () => existsSync(join(plugin, 'mcp_config.json'))))
  check('7 without the session key, and nothing global', !readFileSync(join(plugin, 'mcp_config.json'), 'utf8').includes('COCKPIT_MCP_TOKEN=') && !existsSync(join(home, '.gemini/config/mcp_config.json')))
  await shot(page, 'agy-tools-on')
  // Applies through the server; the box follows its answer, so click and watch the folder.
  await until('toggle settled', async () => (await tools.isChecked()) && (await tools.isEnabled()))
  await tools.click()
  check('7 turning it off removes it', await until('plugin gone', async () => !existsSync(join(plugin, 'mcp_config.json'))))
} catch (error) {
  check('proof ran to the end', false, error instanceof Error ? error.message.split('\n')[0] : String(error))
  if (app) await (await app.firstWindow()).screenshot({ path: join(PROOF_DIR, 'wave10-failure.png') }).catch(() => {})
} finally {
  await app?.close().catch(() => {})
}
finish('PROOF WAVE 10')
