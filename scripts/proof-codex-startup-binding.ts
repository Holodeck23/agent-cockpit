// Background-only stock native config-race proof. No live account or model input.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { launchCodex } from '../server/agents/codex/launch.ts'
import type { NormalizedEvent } from '../server/agents/types.ts'

process.umask(0o077)
const output = process.env.COCKPIT_PROOF_DIR ?? '', executable = process.env.COCKPIT_W13_CODEX ?? ''
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const receipt: Record<string, unknown> = { verdict: 'NOT_RUN', modelInputs: 0,
  scope: 'Pinned stock config/read through a transparent transport race fixture. Point-in-time checks; no cloud, atomic, packaged or installed acceptance.' }
let owned = false
async function until(check: () => boolean) {
  const deadline = performance.now() + 8000
  while (!check()) { assert.ok(performance.now() < deadline, 'Native observation deadline'); await delay(10) }
}
try {
  assert.equal(process.env.COCKPIT_PROOF_BACKGROUND, '1')
  assert.ok(isAbsolute(output) && isAbsolute(executable))
  assert.equal(sha(realpathSync(executable)), '74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0')
  mkdirSync(output, { mode: 0o700 }); owned = true
  const root = realpathSync(output), outcomes: unknown[] = []
  const controlMarker = join(root, 'positive-control.started')
  execFileSync('/bin/sh', ['-c', 'printf started > "$1"', 'fixture', controlMarker], { timeout: 1000 })
  assert.ok(existsSync(controlMarker)); receipt.commandCanary = 'CALIBRATED'
  for (const mode of ['control', 'new-before-thread', 'resume-before-thread', 'after-thread']) {
    const dir = join(root, mode), home = join(dir, 'home'), profile = join(dir, 'profile'), cwd = join(dir, 'project')
    mkdirSync(dir); mkdirSync(home); mkdirSync(profile); mkdirSync(cwd)
    const config = join(profile, 'config.toml'), marker = join(dir, 'unreviewed.started'), methods = join(dir, 'methods.jsonl')
    const projectRoot = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
    const original = `cli_auth_credentials_store="file"
model="fictional-no-inference"
model_provider="fictional"
[projects.${JSON.stringify(projectRoot)}]
trust_level="trusted"
[model_providers.fictional]
name="Fictional local provider"
base_url="http://127.0.0.1:1/v1"
wire_api="responses"
requires_openai_auth=false
`
    const changed = `${original}\n[mcp_servers.late]\ncommand="/bin/sh"\nargs=${JSON.stringify(['-c', 'printf started > "$1"', 'fixture', marker])}\n`
    writeFileSync(config, original, { flag: 'wx' })
    const proxy = join(dir, 'stock-transport.cjs')
    // Record method names only. The native config payload is forwarded, never
    // persisted. Mutation happens after stock has read, before the host sees it.
    writeFileSync(proxy, `#!${process.execPath}
const {spawn}=require('node:child_process'), fs=require('node:fs'), readline=require('node:readline');
const child=spawn(${JSON.stringify(executable)}, process.argv.slice(2), {env:process.env,stdio:['pipe','pipe','pipe']});
const pending=new Map(); let mutated=false;
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.method){fs.appendFileSync(${JSON.stringify(methods)},JSON.stringify(r.method)+'\\n');pending.set(r.id,r.method)}child.stdin.write(line+'\\n')}).on('close',()=>child.stdin.end());
readline.createInterface({input:child.stdout}).on('line',line=>{const r=JSON.parse(line), method=pending.get(r.id);
if(!mutated && (${JSON.stringify(mode)}.includes('before-thread') && method==='config/read' || ${JSON.stringify(mode)}==='after-thread' && method==='thread/start')){fs.writeFileSync(${JSON.stringify(config)},${JSON.stringify(changed)});mutated=true;fs.writeFileSync(${JSON.stringify(join(dir, 'mutation'))},method)}
process.stdout.write(line+'\\n')});
child.stderr.resume();child.on('exit',code=>process.exit(code??1));
`, { flag: 'wx', mode: 0o700 })
    const events: NormalizedEvent[] = []
    const session = launchCodex({ cwd, ...(mode.startsWith('resume') ? { resume: 'fictional-existing-thread' } : {}) }, e => events.push(e), {
      executable: proxy, env: { HOME: home, CODEX_HOME: profile, OPENAI_API_KEY: '', CODEX_API_KEY: '' },
    })
    try {
      // Never call send: this proof's zero-input claim is structural.
      await until(() => events.some(e => e.kind === (mode === 'control' ? 'session' : 'exit')))
      writeFileSync(join(dir, 'events.json'), JSON.stringify(events, null, 2) + '\n', { flag: 'wx' })
      const requests: string[] = readFileSync(methods, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      assert.ok(!requests.some(method => method === 'turn/start' || method === 'turn/steer'))
      assert.ok(!existsSync(marker)); assert.ok(!existsSync(join(profile, 'auth.json')))
      if (mode === 'control') {
        assert.equal(sha(config), createHash('sha256').update(original).digest('hex'))
        assert.equal(requests.filter(method => method === 'config/read').length, 3)
        assert.ok(events.some(e => e.kind === 'session'))
      } else {
        assert.ok(existsSync(join(dir, 'mutation')))
        assert.ok(events.some(e => e.kind === 'error' && /setup changed|could not be checked/.test(e.message)))
        assert.ok(!events.some(e => e.kind === 'session' || e.kind === 'user_taken'))
        if (mode.includes('before-thread')) assert.ok(!requests.some(method => method === 'thread/start' || method === 'thread/resume'))
      }
      outcomes.push({ mode, verdict: 'PASS', requests, noUnreviewedEffect: true })
    } finally { await session.close() }
  }
  receipt.outcomes = outcomes; receipt.cliSha256 = sha(realpathSync(executable)); receipt.nodeSha256 = sha(process.execPath)
  receipt.verdict = 'PASS_BOUNDED_NATIVE_SOURCE_RECHECK'
} catch (error) {
  receipt.verdict = 'FAIL'; process.exitCode = 1
  if (owned) writeFileSync(join(output, 'failure.txt'), error instanceof Error ? error.stack ?? error.message : String(error), { flag: 'wx' })
} finally {
  if (owned) writeFileSync(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(receipt))
}
