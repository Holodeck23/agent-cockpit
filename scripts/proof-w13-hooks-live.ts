// Background packaged proof that an approved project hook runs in the pinned Claude session.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { launchPackagedApp } from './lib/launch-app.ts'
import { apiPost, openProject } from './lib/ui.ts'

const cli = process.env.COCKPIT_W13_CLAUDE
assert.ok(cli && process.env.COCKPIT_APP, 'Set pinned Claude and the exact proof package')
assert.equal(process.env.COCKPIT_PROOF_BACKGROUND, '1', 'Proof must stay in the background')
const hash = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
assert.equal(hash(realpathSync(cli)), '8addc857f3fe64d5a0368af9ee50321b50afb4a6918ba3ef018ab84f5dbbe081')
assert.match(execFileSync(cli, ['--version'], { encoding: 'utf8' }), /^2\.1\.220 /)
assert.equal(hash(process.execPath), '68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b')
const root = mkdtempSync(join(tmpdir(), 'cockpit-w13-hook-live-'))
const project = join(root, 'project'), marker = join(root, 'hook-started')
mkdirSync(join(project, '.claude'), { recursive: true })
writeFileSync(join(project, 'README.md'), '# Isolated W13 hook proof\n')
const script = join(project, 'session-start.mjs')
writeFileSync(script, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'W13-HOOK-STARTED')\n`)
writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ hooks: {
  SessionStart: [{ hooks: [{ type: 'command', command: `${process.execPath} ${script}` }] }],
} }))
// HOME controls Cockpit's source inventory; CLAUDE_CONFIG_DIR keeps the same signed-in CLI identity.
// Strict mode and the private settings snapshot prevent ambient hooks from entering the provider.
const app = await launchPackagedApp({ HOME: root, CLAUDE_CONFIG_DIR: join(process.env.HOME ?? '', '.claude'),
  COCKPIT_HOME: join(root, 'state'), COCKPIT_AGENT_PATH: dirname(cli) })
try {
  const page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  await openProject(page, project, 'W13 hook proof')
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
}
