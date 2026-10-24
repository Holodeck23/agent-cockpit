// Background-only production preflight smoke; fictional account, zero model input.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { codexStartupPreflight } from '../server/agents/codex/startup-preflight.ts'
import { queryAppServer } from '../server/agents/codex/app-server-query.ts'
import { launchCodex } from '../server/agents/codex/launch.ts'
import type { NormalizedEvent } from '../server/agents/types.ts'

process.umask(0o077)
const output = process.env.COCKPIT_PROOF_DIR ?? '', executable = process.env.COCKPIT_W13_CODEX ?? ''
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const receipt: Record<string, unknown> = { verdict: 'NOT_RUN', modelInputs: 0,
  scope: 'Production local preflight, stock no-policy account helper, runtime-switch refusal. No actual managed-policy positive or package/installed qualification.' }
let owned = false
try {
  assert.equal(process.env.COCKPIT_PROOF_BACKGROUND, '1')
  assert.ok(isAbsolute(output) && isAbsolute(executable))
  assert.equal(sha(realpathSync(executable)), '74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0')
  mkdirSync(output, { mode: 0o700 }); owned = true
  const root = realpathSync(output), home = join(root, 'fictional-home'), profile = join(root, 'fictional-profile')
  mkdirSync(home); mkdirSync(profile)
  const config = join(profile, 'config.toml')
  writeFileSync(config, 'cli_auth_credentials_store="file"\n', { flag: 'wx' })
  const before = sha(config)
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, CODEX_HOME: profile, OPENAI_API_KEY: '', CODEX_API_KEY: '' }
  await codexStartupPreflight(env)
  receipt.localCheck = 'NO_LOCAL_MANAGED_SOURCE_DETECTED'
  const helper = await queryAppServer(executable, 'account/read', {}, { env, timeoutMs: 5000 })
  assert.equal(helper.error, undefined)
  assert.ok(helper.result && typeof helper.result === 'object')
  assert.equal((helper.result as { account?: unknown }).account, null)
  receipt.stockHelper = 'FICTIONAL_UNSIGNED_ACCOUNT_READ_PASS'

  // Calibrate the executable canary independently. Refused runs must never invoke
  // it, so even an effect at process entry would be caught. It starts no children.
  const canary = join(root, 'codex-entry-canary.sh'), control = join(root, 'control.started')
  writeFileSync(canary, '#!/bin/sh\nprintf started > "$COCKPIT_PREFLIGHT_MARKER"\n', { flag: 'wx', mode: 0o700 })
  await promisify(execFile)(canary, [], { env: { ...env, COCKPIT_PREFLIGHT_MARKER: control }, timeout: 1000 })
  assert.ok(existsSync(control))
  receipt.entryCanary = 'POSITIVE_CONTROL_STARTED'
  const results: string[] = []
  for (const kind of ['account/read', 'model/list', 'new', 'resume']) {
    const marker = join(root, `${kind.replace('/', '-')}.started`)
    const refusedEnv = { ...env, COCKPIT_PREFLIGHT_MARKER: marker, CODEX_APP_SERVER_MANAGED_CONFIG_PATH: '/unsupported-policy-path' }
    if (kind === 'new' || kind === 'resume') {
      const events: NormalizedEvent[] = []
      const session = launchCodex({ cwd: root, ...(kind === 'resume' ? { resume: 'fictional-saved' } : {}) }, e => events.push(e), {
        executable: canary, env: refusedEnv,
      })
      try {
        session.send('fictional undelivered task', 'queued')
        const deadline = performance.now() + 3000
        while (!events.some(e => e.kind === 'exit')) { assert.ok(performance.now() < deadline); await delay(10) }
        assert.ok(events.some(e => e.kind === 'error' && e.message.includes('startup sources could not be checked')))
        assert.ok(!events.some(e => e.kind === 'session' || e.kind === 'user_taken'))
      } finally { await session.close() }
    } else {
      const answer = await queryAppServer(canary, kind, {}, { env: refusedEnv, timeoutMs: 1000 })
      assert.ok(answer.error?.includes('startup sources could not be checked'))
    }
    assert.ok(!existsSync(marker), 'A refused provider executable started')
    results.push(kind)
  }
  assert.equal(sha(config), before)
  assert.ok(!existsSync(join(profile, 'auth.json')))
  receipt.refusedBeforeProcessEntry = results
  receipt.sourceConfigUnchanged = true
  receipt.cliSha256 = sha(realpathSync(executable)); receipt.nodeSha256 = sha(process.execPath)
  receipt.verdict = 'PASS_BOUNDED_PREFLIGHT'
} catch (error) {
  receipt.verdict = 'FAIL'
  if (owned) writeFileSync(join(output, 'failure.txt'), error instanceof Error ? error.stack ?? error.message : String(error), { flag: 'wx' })
  process.exitCode = 1
} finally {
  if (owned) writeFileSync(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(receipt))
}
