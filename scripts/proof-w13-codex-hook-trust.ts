// Prepare an inert hook bundle; optional batch mode trusts only freshly reviewed fixture hashes via native config API.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { queryAppServer } from '../server/agents/codex/app-server-query.ts'
import { ProbeAttempt } from './lib/w13-completion-probe.ts'

process.umask(0o077)
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
const quote = (value: string): string => "'" + value.replaceAll("'", "'\"'\"'") + "'"
const cli = process.env.COCKPIT_W13_CODEX ?? '', evidence = process.env.COCKPIT_PROOF_DIR ?? '', privateDir = process.env.COCKPIT_PROOF_PRIVATE_DIR ?? ''
const batch = process.env.COCKPIT_W13_HOOK_FIXTURE === 'parent-batch'
let attempt: ProbeAttempt | undefined
const receipt: Record<string, unknown> = { scenario: 'native-codex-hook-trust-preparation', verdict: 'BLOCKED', modelInputs: 0, realAccounts: 0 }
try {
  assert.equal(process.env.COCKPIT_PROOF_BACKGROUND, '1')
  assert.ok(process.env.COCKPIT_W13_HOOK_FIXTURE === undefined || batch)
  assert.ok(!batch || process.env.COCKPIT_W13_TRUST_REVIEWED_BATCH === '1')
  assert.ok([cli, evidence, privateDir].every(isAbsolute))
  assert.ok(realpathSync(dirname(privateDir)).startsWith(realpathSync(join(process.env.HOME ?? '', 'vault', 'clients')) + sep))
  attempt = new ProbeAttempt(evidence, privateDir); attempt.create()
  assert.equal(sha(cli), '74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0')
  assert.equal(sha(process.execPath), '68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b')
  assert.ok(!['/etc/codex/config.toml', '/etc/codex/managed_config.toml', '/etc/codex/requirements.toml',
    '/Library/Managed Preferences/com.openai.codex.plist', join('/Library/Managed Preferences', process.env.USER ?? '', 'com.openai.codex.plist')].some(existsSync))
  const repo = dirname(dirname(fileURLToPath(import.meta.url)))
  const home = join(privateDir, 'home'), codexHome = join(privateDir, 'codex-home'), project = join(privateDir, 'project')
  for (const folder of [home, codexHome, project]) mkdirSync(folder, { mode: 0o700 })
  execFileSync('/usr/bin/git', ['init', '-q', project], { timeout: 10_000,
    env: { HOME: home, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })
  const callback = join(privateDir, 'stop-observer.cjs')
  writeFileSync(callback, readFileSync(join(repo, batch ? 'scripts/fixtures/w13-stop-batch.cjs' : 'scripts/fixtures/w13-stop-observer.cjs')), { flag: 'wx', mode: 0o600 })
  if (batch) mkdirSync(join(privateDir, 'cycles'), { mode: 0o700 })
  const hooks = join(codexHome, 'hooks.json')
  writeFileSync(hooks, JSON.stringify({ hooks: { Stop: [{ hooks: (batch ? ['batch'] : ['a', 'b']).map((label) => ({ type: 'command',
    command: [process.execPath, callback, privateDir, label].map(quote).join(' '), timeout: 5 })) }] } }), { flag: 'wx', mode: 0o600 })
  const config = join(codexHome, 'config.toml')
  writeFileSync(config, `model_provider="w13fixture"\nmodel="w13-fixture"\napproval_policy="never"\nsandbox_mode="read-only"\ncheck_for_update_on_startup=false\n[features]\nhooks=true\nmemories=false\nmulti_agent=false\napps=false\nplugins=false\nshell_tool=false\n[memories]\ngenerate_memories=false\nuse_memories=false\n[model_providers.w13fixture]\nname="W13 local fixture"\nbase_url="http://127.0.0.1:1/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\nrequest_max_retries=0\nstream_max_retries=0\n[projects.${JSON.stringify(project)}]\ntrust_level="trusted"\n`, { flag: 'wx', mode: 0o600 })
  const env: Record<string, string> = { HOME: home, CODEX_HOME: codexHome, TMPDIR: privateDir, PATH: '/usr/bin:/bin:/opt/homebrew/bin',
    USER: process.env.USER ?? '', LOGNAME: process.env.LOGNAME ?? '', LANG: 'en_US.UTF-8', TERM: 'xterm-256color' }
  attempt.writePrivate('fixture-context-private.json', JSON.stringify({ cli, runtime: process.execPath, project, env,
    manifest: { cli: sha(cli), runtime: sha(process.execPath), callback: sha(callback), hooks: sha(hooks), config: sha(config) } }, null, 2) + '\n')
  process.chdir(project)
  const answer = await queryAppServer(cli, 'hooks/list', { cwds: [project] }, { env, timeoutMs: 15_000 })
  attempt.writePrivate('hooks-before-trust-private.json', JSON.stringify(answer, null, 2) + '\n')
  assert.equal(answer.error, undefined)
  const entries = (answer.result as { data: { hooks: { key: string; currentHash: string; eventName: string; trustStatus: string; enabled: boolean }[] }[] }).data
  const rows = entries.flatMap((entry) => entry.hooks)
  assert.equal(rows.length, batch ? 1 : 2)
  assert.ok(rows.every((row) => row.eventName.toLowerCase() === 'stop' && row.enabled))
  assert.equal(existsSync(join(privateDir, 'stop-observations-private.jsonl')), false)
  receipt.hooks = rows.map((row) => ({ eventName: row.eventName, trustStatus: row.trustStatus, enabled: row.enabled }))
  receipt.sourceParent = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  receipt.sourceIndexTree = execFileSync('git', ['write-tree'], { cwd: repo, encoding: 'utf8' }).trim()
  receipt.verdict = 'PREPARED_NATIVE_TRUST_REQUIRED'
  if (batch) {
    // Native generic config API persists the same exact hash representation observed in /hooks.
    // This path is restricted to this freshly owned, source-reviewed inert batch fixture.
    assert.ok(rows.every((row) => row.trustStatus === 'untrusted' && typeof row.key === 'string' && typeof row.currentHash === 'string'))
    const written = await queryAppServer(cli, 'config/value/write', { filePath: config, keyPath: 'hooks.state', mergeStrategy: 'replace',
      value: Object.fromEntries(rows.map((row) => [row.key, { trusted_hash: row.currentHash }])) }, { env, timeoutMs: 15_000 })
    attempt.writePrivate('native-trust-config-write-private.json', JSON.stringify(written))
    assert.equal(written.error, undefined)
    const after = await queryAppServer(cli, 'hooks/list', { cwds: [project] }, { env, timeoutMs: 15_000 })
    attempt.writePrivate('hooks-after-trust-private.json', JSON.stringify(after))
    assert.equal(after.error, undefined)
    const trusted = (after.result as typeof answer.result & { data: typeof entries }).data.flatMap((entry) => entry.hooks)
    assert.equal(trusted.length, 1)
    assert.ok(trusted.every((row, index) => row.enabled && row.trustStatus === 'trusted'
      && row.key === rows[index]!.key && row.currentHash === rows[index]!.currentHash))
    const original = JSON.parse(readFileSync(join(privateDir, 'fixture-context-private.json'), 'utf8'))
    assert.equal(sha(callback), original.manifest.callback); assert.equal(sha(hooks), original.manifest.hooks)
    attempt.writePrivate('fixture-trusted-context-private.json', JSON.stringify({ ...original,
      manifest: { ...original.manifest, config: sha(config) } }, null, 2))
    receipt.verdict = 'PASS_NATIVE_REVIEWED_BATCH_TRUST'
    receipt.trustMethod = 'native config/value/write; exact reviewed hook key/currentHash; fresh inert fixture only'
    receipt.trustedHooks = 1
  }
} catch (error) {
  attempt?.writePrivate('error-private.txt', error instanceof Error ? error.stack ?? error.message : 'Unknown failure')
  process.exitCode = 1
} finally {
  attempt?.writeReceipt(receipt)
  console.log(JSON.stringify({ verdict: receipt.verdict, modelInputs: 0 }))
}
