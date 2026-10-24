// Stock-process checks of late native discovery and pending-input retirement.
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
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
const receipt: Record<string, unknown> = { verdict: 'NOT_RUN', scope: 'Stock 0.162.1, fictional pretrusted profile, late-discovery and pending input. No cloud, atomic, package or live-account acceptance.' }
async function until(check: () => boolean) {
  const end = performance.now() + 8000
  while (!check()) { assert.ok(performance.now() < end, 'Native observation deadline'); await delay(10) }
}
let owned = false
try {
  assert.equal(process.env.COCKPIT_PROOF_BACKGROUND, '1')
  assert.ok(isAbsolute(output) && isAbsolute(executable))
  assert.equal(sha(realpathSync(executable)), '74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0')
  mkdirSync(output, { mode: 0o700 }); owned = true
  const root = realpathSync(output), outcomes: unknown[] = []
  const positive = join(root, 'positive-control.started')
  execFileSync('/bin/sh', ['-c', 'printf started > "$1"', 'fixture', positive], { timeout: 1000 }); assert.ok(existsSync(positive))
  for (const mode of ['new-source', 'withdraw', 'stop', 'close']) {
    const dir = join(root, mode), cwd = join(dir, 'project'), profile = join(dir, 'profile'), home = join(dir, 'home')
    mkdirSync(dir); mkdirSync(cwd); mkdirSync(profile); mkdirSync(home)
    const projectRoot = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
    const config = join(profile, 'config.toml'), methods = join(dir, 'methods.jsonl'), release = join(dir, 'release'), held = join(dir, 'held')
    const marker = join(dir, 'unreviewed.started')
    writeFileSync(config, `cli_auth_credentials_store="file"
model="fictional-no-inference"
model_provider="fictional"
[projects.${JSON.stringify(projectRoot)}]
trust_level="trusted"
[model_providers.fictional]
name="Fictional local provider"
base_url="http://127.0.0.1:1/v1"
wire_api="responses"
requires_openai_auth=false
`, { flag: 'wx' })
    const before = sha(config), proxy = join(dir, 'stock-transport.cjs')
    writeFileSync(proxy, `#!${process.execPath}
const fs=require('node:fs'),readline=require('node:readline'),{spawn}=require('node:child_process');
const child=spawn(${JSON.stringify(executable)},process.argv.slice(2),{env:process.env,stdio:['pipe','pipe','pipe']});let reads=0;
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.method)fs.appendFileSync(${JSON.stringify(methods)},JSON.stringify(r.method)+'\\n');
if(r.method==='config/read' && ++reads===4 && ${JSON.stringify(mode)}!=='new-source'){fs.writeFileSync(${JSON.stringify(held)},'held');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);child.stdin.write(line+'\\n')}},5)}else child.stdin.write(line+'\\n')}).on('close',()=>child.stdin.end());
child.stdout.pipe(process.stdout);child.stderr.resume();child.on('exit',code=>process.exit(code??1));
`, { flag: 'wx', mode: 0o700 })
    const events: NormalizedEvent[] = []
    const session = launchCodex({ cwd }, e => events.push(e), { executable: proxy,
      env: { HOME: home, CODEX_HOME: profile, OPENAI_API_KEY: '', CODEX_API_KEY: '' },
    })
    try {
      await until(() => events.some(e => e.kind === 'session'))
      if (mode === 'new-source') {
        const added = join(cwd, '.codex'); mkdirSync(added)
        writeFileSync(join(added, 'config.toml'), `[mcp_servers.late]\ncommand="/bin/sh"\nargs=${JSON.stringify(['-c', 'printf started > "$1"', 'fixture', marker])}\n`, { flag: 'wx' })
      }
      session.send('fictional task held before model input', 'waiting')
      if (mode === 'new-source') await until(() => events.some(e => e.kind === 'exit'))
      else {
        await until(() => existsSync(held))
        if (mode === 'withdraw') assert.equal(await session.cancelQueued?.('waiting'), true)
        if (mode === 'stop') session.interrupt()
        if (mode === 'close') await session.close()
        writeFileSync(release, 'released', { flag: 'wx' })
        if (mode !== 'close') { await delay(100); await session.close() }
      }
      const requests: string[] = readFileSync(methods, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      assert.equal(requests.filter(method => method === 'turn/start' || method === 'turn/steer').length, 0)
      assert.ok(!events.some(e => e.kind === 'user_taken')); assert.ok(!existsSync(marker))
      assert.equal(sha(config), before); assert.ok(!existsSync(join(profile, 'auth.json')))
      if (mode === 'new-source') assert.ok(events.some(e => e.kind === 'error' && /setup changed|could not be checked/.test(e.message)))
      if (mode === 'stop') assert.ok(events.some(e => e.kind === 'user_undelivered' && e.id === 'waiting'))
      writeFileSync(join(dir, 'events.json'), JSON.stringify(events, null, 2) + '\n', { flag: 'wx' })
      outcomes.push({ mode, verdict: 'PASS', requests, modelInputs: 0, originalConfigUnchanged: true })
    } finally { await session.close() }
  }
  receipt.verdict = 'PASS_BOUNDED_LATER_INPUT_REVIEW'; receipt.outcomes = outcomes; receipt.modelInputs = 0
  receipt.cliSha256 = sha(realpathSync(executable)); receipt.nodeSha256 = sha(process.execPath)
} catch (error) {
  receipt.verdict = 'FAIL'; process.exitCode = 1
  if (owned) writeFileSync(join(output, 'failure.txt'), error instanceof Error ? error.stack ?? error.message : String(error), { flag: 'wx' })
} finally {
  if (owned) writeFileSync(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(receipt))
}
