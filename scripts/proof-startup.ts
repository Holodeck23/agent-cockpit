// Packaged P1 startup gate: deliberately absent CLIs, then a local stand-in. No provider usage.
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createThreadStore } from '../server/threads/store.ts'
import { openApprovals } from '../server/threads/status.ts'
import { launchPackagedApp, ROOT, PROOF_DIR } from './lib/launch-app.ts'
import { apiPost, headStatus, messageBox, openProject } from './lib/ui.ts'

const home = mkdtempSync(join(tmpdir(), 'cockpit-startup-proof-'))
mkdirSync(PROOF_DIR, { recursive: true })
const bin = join(home, 'bin')
mkdirSync(bin)
const state = join(home, 'state')
const store = createThreadStore(state)
const app = await launchPackagedApp({ COCKPIT_HOME: state })
try {
  // Override only this proof process's PATH after shell-path setup. No real agent is reachable.
  await app.evaluate((_electron, path) => { process.env.PATH = path }, `${bin}:/usr/bin:/bin`)
  const page = await app.firstWindow()
  page.setDefaultTimeout(15_000)
  await openProject(page, home, 'Startup recovery')
  for (const agent of ['claude', 'codex', 'antigravity', 'opencode']) {
    const title = `Missing ${agent}`
    const created = await apiPost(page, '/api/threads', { projectPath: home, title, text: 'hello', settings: { agent } }) as { data: { id: string } }
    const id = created.data.id
    await page.locator('.card').filter({ hasText: title }).click()
    await headStatus(page).filter({ hasText: 'Error' }).waitFor()
    assert.equal(store.get(id)?.sessionStarted, false)
    assert.equal(openApprovals(store.events(id)).length, 0)
    assert.equal(store.events(id).filter((e) => e.event.kind === 'result').length, 1)
    assert.equal(await page.locator('.approval.open').count(), 0)
    // Antigravity is checked at launch (W10-01) and says so in its own words; the others keep the start error.
    assert.match(await page.locator('.transcript').innerText(), agent === 'antigravity' ? /Antigravity is not installed: .*Install it, then retry/ : /Install it and sign in/)
    console.log(`PASS ${agent}: missing CLI terminates, no approval or invented session`)
  }

  // Retry the last thread with the real ACP fixture and assert a provider session is established.
  copyFileSync(join(ROOT, 'scripts/fixtures/opencode-agent/opencode'), join(bin, 'opencode'))
  chmodSync(join(bin, 'opencode'), 0o755)
  await messageBox(page).fill('Retry after restoring executable')
  await messageBox(page).press('Enter')
  const approval = page.locator('.approval.open')
  await approval.waitFor()
  await approval.getByRole('button', { name: 'Allow', exact: true }).click()
  await headStatus(page).filter({ hasText: 'Ready' }).waitFor()
  const recovered = store.list().find((m) => m.title === 'Missing opencode')!
  assert.equal(recovered.sessionStarted, true)
  assert.equal(recovered.sessionId, 'oc-session-1')
  assert.match(await page.locator('.transcript').innerText(), /instructions received/)
  assert.doesNotMatch(await page.locator('.transcript').innerText(), /Loaded /)
  console.log('PASS restored OpenCode starts fresh, establishes a provider session, and completes')

  const help = readFileSync(join(ROOT, 'scripts/fixtures/claude-help.txt'), 'utf8')
  const helpFile = join(home, 'claude-help.txt')
  writeFileSync(helpFile, help.replace('  --strict-mcp-config\n', ''))
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
  const argvFile = join(home, 'claude-argv')
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\nif [ "$1" = "--help" ]; then cat ${quote(helpFile)}; exit 0; fi\nprintf '%s\\n' "$@" > ${quote(argvFile)}\nexec ${quote(join(ROOT, 'scripts/fixtures/echo-agent/claude'))} "$@"\n`)
  chmodSync(join(bin, 'claude'), 0o755)
  const created = await apiPost(page, '/api/threads', { projectPath: home, title: 'Unsupported Claude', text: 'hello', settings: { agent: 'claude' } }) as { data: { id: string } }
  await page.locator('.card').filter({ hasText: 'Unsupported Claude' }).click()
  await headStatus(page).filter({ hasText: 'Error' }).waitFor()
  assert.match(await page.locator('.transcript').innerText(), /Update the Claude Code executable/)
  assert.equal(store.get(created.data.id)?.sessionStarted, false)
  assert.equal(store.events(created.data.id).filter((e) => e.event.kind === 'result').length, 1)
  assert.equal(existsSync(argvFile), false)
  await page.screenshot({ path: join(PROOF_DIR, 'proof-claude-incompatible.png') })
  console.log('PASS incompatible Claude has actionable guidance, no launch, no invented session')
  writeFileSync(helpFile, help.replace(/^  --permission-prompts.*\n/m, ''))
  await messageBox(page).fill('Retry with compatible legacy CLI')
  await messageBox(page).press('Enter')
  await headStatus(page).filter({ hasText: 'Ready' }).waitFor()
  assert.equal(store.get(created.data.id)?.sessionStarted, true)
  const args = readFileSync(argvFile, 'utf8')
  assert.doesNotMatch(args, /--permission-prompts/)
  assert.match(args, /--permission-prompt-tool\nstdio/)
  assert.match(args, /--permission-mode\nmanual/)
  console.log('PASS retry probes changed CLI, legacy argv retains manual/stdin approvals and completes')
  mkdirSync(PROOF_DIR, { recursive: true })
  await page.screenshot({ path: join(PROOF_DIR, 'proof-startup.png') })
  console.log('PROOF STARTUP PASS — missing/incompatible CLIs and fresh retries, no provider usage')
} finally {
  await app.close()
}
