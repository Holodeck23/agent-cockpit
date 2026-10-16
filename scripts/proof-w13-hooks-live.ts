// Background packaged proof that an approved project hook runs in the pinned Claude session.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { launchPackagedApp } from './lib/launch-app.ts'
import { apiPost, openProject } from './lib/ui.ts'

const cli = process.env.COCKPIT_W13_CLAUDE
assert.ok(cli && process.env.COCKPIT_APP, 'Set pinned Claude and the exact proof package')
assert.equal(process.env.COCKPIT_PROOF_BACKGROUND, '1', 'Proof must stay in the background')
const hash = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
assert.equal(hash(realpathSync(cli)), '8addc857f3fe64d5a0368af9ee50321b50afb4a6918ba3ef018ab84f5dbbe081')
assert.match(execFileSync(cli, ['--version'], { encoding: 'utf8' }), /^2\.1\.220 /)
assert.equal(hash(process.execPath), '68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b')
const managed = process.env.COCKPIT_W13_MANAGED_CLAUDE_PROFILE
assert.ok(managed, 'Set COCKPIT_W13_MANAGED_CLAUDE_PROFILE to a signed-in Cockpit managed profile')
const accountId = basename(managed)
assert.match(accountId, /^[0-9a-f-]{36}$/)
const accountRoot = join(process.env.HOME ?? '', '.agent-cockpit')
assert.equal(realpathSync(dirname(managed)), realpathSync(join(accountRoot, 'account-profiles')))
const accountFile = JSON.parse(readFileSync(join(accountRoot, 'accounts.json'), 'utf8')) as {
  accounts: Array<{ id: string; agent: string; mode: string; isolation: string }>
}
const account = accountFile.accounts.find((entry) => entry.id === accountId)
assert.ok(account && account.agent === 'claude' && account.mode === 'managed' && account.isolation === 'CLAUDE_CONFIG_DIR')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-w13-hook-live-')))
const project = join(root, 'project'), marker = join(root, 'hook-started')
const state = join(root, 'state')
mkdirSync(join(state, 'account-profiles'), { recursive: true, mode: 0o700 })
symlinkSync(realpathSync(managed), join(state, 'account-profiles', accountId))
writeFileSync(join(state, 'accounts.json'), JSON.stringify({ version: 1, revision: 1, accounts: [account],
  selections: { [project]: { claude: accountId } } }), { mode: 0o600 })
mkdirSync(join(project, '.claude'), { recursive: true })
writeFileSync(join(project, 'README.md'), '# Isolated W13 hook proof\n')
const script = join(project, 'session-start.mjs')
writeFileSync(script, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'W13-HOOK-STARTED')\n`)
writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ hooks: {
  SessionStart: [{ hooks: [{ type: 'command', command: `${process.execPath} ${script}` }] }],
} }))
// The disposable account record selects the authorized managed profile; HOME stays real for Keychain.
// Cockpit metadata stays in disposable state. Claude may write normal session data to its profile.
const app = await launchPackagedApp({ COCKPIT_HOME: state, COCKPIT_AGENT_PATH: dirname(cli) })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await openProject(page, project, 'W13 hook proof')
  const selectedAccount = await page.evaluate(async (path) => {
    const listed = await (await fetch('/api/projects')).json() as { data: Array<{ projectId?: string; path: string }> }
    const id = listed.data.find((entry) => entry.path === path)?.projectId
    if (!id) return undefined
    const choice = await (await fetch(`/api/projects/${id}/accounts`)).json() as { data: { selection: { claude: string } } }
    return choice.data.selection.claude
  }, project)
  assert.equal(selectedAccount, accountId, 'The disposable project did not select the authorized managed account')
  const source = await page.evaluate(async (path) => (await (await fetch(`/api/projects/claude-hooks?path=${encodeURIComponent(path)}`)).json()).data,
    project) as { revision: string; review: Array<{ event: string; referencedFiles: Array<{ path: string; hash: string }> }>; unavailable: unknown[] }
  assert.equal(source.review.length, 1)
  assert.equal(source.review[0]?.event, 'SessionStart')
  assert.equal(source.review[0]?.referencedFiles[0]?.hash, hash(script))
  assert.deepEqual(source.unavailable, [])
  await apiPost(page, '/api/projects/claude-hooks', { path: project, revision: source.revision })
  await apiPost(page, '/api/projects', { path: project, claudeHooks: true, claudeMcp: false })
  const created = await apiPost(page, '/api/threads', { projectPath: project, text: 'Reply exactly W13HOOKREADY. Do not use tools.',
    settings: { agent: 'claude', model: 'haiku', permissionMode: 'manual', hooksSetup: 'inherit', mcpSetup: 'off' } }) as
    { data?: { id: string }; error?: string }
  assert.ok(created.data?.id, created.error ?? 'Thread creation failed')
  let events: Array<{ kind: string; text?: string; ok?: boolean; message?: string }> = []
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    events = await page.evaluate(async (id) => (await (await fetch(`/api/threads/${id}/events`)).json()).data.events.map((row: { event: unknown }) => row.event), created.data.id)
    if (events.some((event) => event.kind === 'result')) break
    await page.waitForTimeout(500)
  }
  const result = events.find((event) => event.kind === 'result')
  assert.equal(result?.ok, true, result?.text?.includes('Not logged in')
    ? 'The isolated Claude profile is not authenticated; stop and obtain an authorized test profile'
    : 'The packaged Claude turn did not succeed')
  assert.equal(existsSync(marker), true, 'Reviewed SessionStart hook did not run')
  assert.equal(readFileSync(marker, 'utf8'), 'W13-HOOK-STARTED')
  assert.ok(events.some((event) => event.kind === 'assistant_text' && event.text?.includes('W13HOOKREADY')))
  console.log(JSON.stringify({ packagedHookRan: true, hookSourceHash: hash(script), cliVersion: '2.1.220' }))
} finally {
  await app.close()
  unlinkSync(join(state, 'account-profiles', accountId))
  rmSync(root, { recursive: true, force: true })
}
