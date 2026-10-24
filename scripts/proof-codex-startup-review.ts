// Stock-runtime MCP startup check with fictional profiles, local canaries and no model inputs.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { launchCodex } from '../server/agents/codex/launch.ts'
import { createRpcClient } from '../server/agents/codex/rpc.ts'
import { codexStartupConfigArgs } from '../server/agents/codex/startup-config.ts'
import { codexMcpConfigArgs } from '../server/mcp/wiring.ts'
import { AGENT_SPAWN, stopChild } from '../server/agents/stop.ts'
import type { NormalizedEvent } from '../server/agents/types.ts'

process.umask(0o077)
const output = process.env.COCKPIT_PROOF_DIR ?? '', executable = process.env.COCKPIT_W13_CODEX ?? ''
const receipt: Record<string, unknown> = { verdict: 'NOT_RUN', modelInputs: 0, scope: 'Stock 0.162.1 pre-thread MCP effects; not package, managed pre-spawn or lifecycle qualification' }
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
async function until(test: () => boolean, ms = 8000): Promise<void> {
  const end = performance.now() + ms
  while (!test()) { assert.ok(performance.now() < end, 'Expected startup observation did not arrive'); await delay(25) }
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Native fixture RPC deadline')), 15_000) })]) }
  finally { clearTimeout(timer) }
}
let owned = false
try {
  assert.equal(process.env.COCKPIT_PROOF_BACKGROUND, '1')
  assert.ok(isAbsolute(output) && isAbsolute(executable))
  assert.equal(sha(realpathSync(executable)), '74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0')
  // These sources are outside this fictional fixture. Never modify them for a proof.
  for (const path of ['/etc/codex/config.toml', '/etc/codex/managed_config.toml', '/etc/codex/requirements.toml',
    '/Library/Managed Preferences/com.openai.codex.plist',
    join('/Library/Managed Preferences', process.env.USER ?? '', 'com.openai.codex.plist')]) assert.ok(!existsSync(path), 'System/managed configuration is outside this fixture')
  mkdirSync(output, { mode: 0o700 }); owned = true
  const root = realpathSync(output), cwd = join(root, 'project'), profile = join(root, 'fictional-codex-home')
  mkdirSync(cwd); mkdirSync(profile)
  const canary = join(root, 'mcp-canary.cjs'), inherited = join(root, 'inherited.started'), bridge = join(root, 'bridge.started')
  const productionMarker = join(root, 'production-inherited.started')
  writeFileSync(canary, `const fs = require('node:fs'); fs.writeFileSync(process.argv[2], 'started'); if (fs.existsSync(${JSON.stringify(join(root, 'production-phase'))}) && process.argv[2] === ${JSON.stringify(inherited)}) fs.writeFileSync(${JSON.stringify(productionMarker)}, 'started');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
 const r = JSON.parse(line); if (r.id === undefined) return;
 const result = r.method === 'initialize' ? { protocolVersion: r.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fictional-startup-canary', version: '1' } } : r.method === 'tools/list' ? { tools: [] } : {};
 process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }) + '\\n');
});`, { flag: 'wx' })
  const configFile = join(profile, 'config.toml')
  writeFileSync(configFile, `cli_auth_credentials_store="file"
model="fictional-no-inference"
model_provider="fictional"
[model_providers.fictional]
name="Fictional local provider"
base_url="http://127.0.0.1:1/v1"
wire_api="responses"
requires_openai_auth=false
[mcp_servers."unreviewed.with.dots"]
command=${JSON.stringify(process.execPath)}
args=${JSON.stringify([canary, inherited])}
`, { flag: 'wx' })
  const before = sha(configFile)
  const syntheticHome = join(root, 'fictional-home'); mkdirSync(syntheticHome)
  const env = { HOME: syntheticHome, CODEX_HOME: profile, OPENAI_API_KEY: '', CODEX_API_KEY: '' }
  // Positive control: the same inherited command actually starts with ordinary native thread creation.
  const child = spawn(executable, ['app-server', ...codexStartupConfigArgs()], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], ...AGENT_SPAWN })
  let exited = false; child.on('exit', () => { exited = true })
  let errors = ''; child.stderr.on('data', chunk => { errors = (errors + String(chunk)).slice(-16000) })
  const rpc = createRpcClient(child, { onNotification() {}, onServerRequest(request) { rpc.respond(request.id, { decision: 'decline' }) }, onProtocolError() {} })
  try {
    await bounded(rpc.request('initialize', { clientInfo: { name: 'cockpit-startup-positive-control', version: '1' }, capabilities: { experimentalApi: true } }))
    rpc.notify('initialized')
    await bounded(rpc.request('thread/start', { cwd, approvalPolicy: 'on-request', sandbox: 'read-only' }))
    await until(() => existsSync(inherited))
    receipt.positiveControl = 'INHERITED_COMMAND_STARTED'
  } finally {
    await stopChild(child, () => !exited)
    writeFileSync(join(root, 'positive-stderr.txt'), errors, { flag: 'wx' })
  }
  const canaryBefore = sha(canary)
  writeFileSync(join(root, 'production-phase'), 'active', { flag: 'wx' })
  const events: NormalizedEvent[] = []
  const session = launchCodex({ cwd, permissionMode: 'plan' }, event => events.push(event), { executable, env,
    configArgs: codexMcpConfigArgs({ command: process.execPath, args: [canary, bridge], secretEnv: {} }) })
  try {
    await until(() => events.some(event => event.kind === 'session') || events.some(event => event.kind === 'result' && !event.ok))
    assert.ok(events.some(event => event.kind === 'session'), 'Production launch did not create the reviewed thread')
    await until(() => existsSync(bridge))
    await delay(750)
    assert.ok(!existsSync(productionMarker), 'Unreviewed inherited command started in the production path')
    assert.equal(sha(configFile), before)
    assert.equal(sha(canary), canaryBefore)
    assert.ok(!existsSync(join(profile, 'auth.json')))
    receipt.production = { threadCreated: true, hostBridgeStarted: true, inheritedCommandStarted: false, sourceConfigUnchanged: true }
  } finally { await session.close(); writeFileSync(join(root, 'production-events.json'), JSON.stringify(events, null, 2), { flag: 'wx' }) }
  receipt.verdict = 'PASS_BOUNDED_NATIVE_EFFECTS'
  receipt.cliSha256 = sha(realpathSync(executable)); receipt.nodeSha256 = sha(process.execPath)
} catch (error) {
  receipt.verdict = 'FAIL'
  if (owned) writeFileSync(join(output, 'failure.txt'), error instanceof Error ? error.stack ?? error.message : String(error), { flag: 'wx' })
  process.exitCode = 1
} finally {
  if (owned) writeFileSync(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(receipt))
}
