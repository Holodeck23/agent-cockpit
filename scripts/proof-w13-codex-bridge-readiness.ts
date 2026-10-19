// Development-package proof through the actual default Codex launcher and scoped Cockpit bridge.
// Fictional transport/account only. No provider login, model, helper agent or external network.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APP_BUNDLE, launchPackagedApp, PROOF_DIR, ROOT } from './lib/launch-app.ts'
import { apiPost, openProject } from './lib/ui.ts'

assert.equal(process.env.COCKPIT_PROOF_BACKGROUND, '1', 'This proof requires background input isolation')
assert.ok(APP_BUNDLE.includes('.noindex/'), 'Use an exclusive development package under .noindex')
mkdirSync(PROOF_DIR, { recursive: true })
const asar = join(APP_BUNDLE, 'Contents/Resources/app.asar')
const digest = () => createHash('sha256').update(readFileSync(asar)).digest('hex')
const before = digest()
const rows: Array<Record<string, unknown>> = []
const root = mkdtempSync(join(tmpdir(), 'cockpit-codex-bridge-proof-'))
try {
  for (const scenario of ['allow', 'missing', 'stop'] as const) {
    const directory = join(root, scenario), project = join(directory, 'project'), markers = join(directory, 'markers'), home = join(directory, 'home')
    mkdirSync(project, { recursive: true }); mkdirSync(markers); mkdirSync(home, { mode: 0o700 })
    writeFileSync(join(project, 'README.md'), '# Fictional Codex readiness proof\n')
    const release = join(directory, 'release-bridge')
    const app = await launchPackagedApp({ HOME: home, COCKPIT_HOME: join(directory, 'state'),
      COCKPIT_AGENT_PATH: join(ROOT, 'scripts/fixtures/codex-readiness'),
      COCKPIT_CODEX_READINESS_FIXTURE: join(ROOT, 'scripts/fixtures/codex-readiness/agent.mjs'),
      COCKPIT_CODEX_READINESS_MARKERS: markers, COCKPIT_CODEX_BRIDGE_RELEASE: release,
      COCKPIT_CODEX_PROOF_PACKAGE: APP_BUNDLE })
    try {
      const page = await app.firstWindow()
      page.setDefaultTimeout(25_000)
      await openProject(page, project, 'Codex readiness proof')
      const text = `Codex input held for bridge: ${scenario}`
      const created = await apiPost(page, '/api/threads', { projectPath: project, text,
        settings: { agent: 'codex', permissionMode: 'manual', hooksSetup: 'off', mcpSetup: 'off' } }) as { data?: { id: string } }
      assert.ok(created.data?.id)
      const id = created.data.id
      const events = async (): Promise<Array<{ kind: string; ok?: boolean; stopped?: boolean }>> => page.evaluate(async (threadId) => {
        const body = await (await fetch(`/api/threads/${threadId}/events`)).json()
        return body.data.events.map((row: { event: unknown }) => row.event)
      }, id)
      const until = async (check: () => Promise<boolean>, label: string): Promise<void> => {
        const deadline = Date.now() + 25_000
        while (!await check()) { assert.ok(Date.now() < deadline, label); await page.waitForTimeout(100) }
      }
      await until(async () => existsSync(join(markers, 'thread-ready')), 'Fixture never prepared the native thread')
      assert.equal(existsSync(join(markers, 'input-read')), false, 'First input escaped before bridge authentication')
      if (scenario === 'allow') {
        writeFileSync(release, 'authenticate')
        await until(async () => (await events()).some((event) => event.kind === 'result' && event.ok), 'Authenticated input did not complete')
        await until(async () => existsSync(join(markers, 'bridge-connected')), 'Packaged bridge never finished connecting')
        assert.equal(existsSync(join(markers, 'bridge-connected')), true)
        const input = JSON.parse(readFileSync(join(markers, 'input-read'), 'utf8'))
        assert.equal(input.find((item: { type: string }) => item.type === 'text').text, text)
        assert.equal((await events()).filter((event) => event.kind === 'user_taken').length, 1)
      } else {
        if (scenario === 'stop') {
          await apiPost(page, `/api/threads/${id}/interrupt`, {})
          writeFileSync(release, 'late authentication')
        }
        await until(async () => (await events()).some((event) => event.kind === 'user_undelivered'), 'Input was not marked undelivered')
        if (scenario === 'stop') {
          await until(async () => existsSync(join(markers, 'bridge-connected')), 'Late bridge did not connect for the cancellation control')
          await page.waitForTimeout(250)
        }
        assert.equal(existsSync(join(markers, 'input-read')), false, 'Refused or stopped input reached the provider')
        assert.equal((await events()).filter((event) => event.kind === 'user_undelivered').length, 1)
        await page.locator('.card').filter({ hasText: text }).click()
        await page.getByRole('button', { name: 'Restore to draft', exact: true }).click()
        assert.equal(await page.locator('textarea').inputValue(), text, 'Original input did not return to the composer')
      }
      await page.screenshot({ path: join(PROOF_DIR, `codex-readiness-${scenario}.png`) })
      rows.push({ scenario, passed: true, firstInputHeld: true,
        result: scenario === 'allow' ? 'authenticated task completed once' : 'undelivered input restored to draft',
        appClosed: false })
    } finally { await app.close(); if (rows.at(-1)?.scenario === scenario) rows.at(-1)!.appClosed = true }
    assert.equal(digest(), before)
  }
} finally {
  writeFileSync(join(PROOF_DIR, 'codex-readiness.json'), JSON.stringify({ asarSha256: before,
    unchanged: digest() === before, layer: 'packaged-synthetic', realProviderCalls: 0, rows }, null, 2) + '\n')
  rmSync(root, { recursive: true, force: true })
}
assert.equal(rows.length, 3)
console.log('CODEX PACKAGED READINESS PASS: authenticated dispatch, failed bridge recovery, Stop and late bridge recovery')
