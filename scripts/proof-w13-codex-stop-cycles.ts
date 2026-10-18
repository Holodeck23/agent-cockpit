// Bounded synthetic native Stop correction observation. No remote model or real account.
import assert from 'node:assert/strict'
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { gunzipSync } from 'node:zlib'
import { ProbeAttempt, ProbeOutput } from './lib/w13-completion-probe.ts'
import { assessCodexStopRecords, assessCodexHookEvents } from './lib/w13-codex-stop-observation.ts'

process.umask(0o077)
const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
const evidence = process.env.COCKPIT_PROOF_DIR ?? '', privateDir = process.env.COCKPIT_PROOF_PRIVATE_DIR ?? ''
const contextFile = process.env.COCKPIT_PROOF_CONTEXT ?? ''
const receipt: Record<string, unknown> = { scenario: 'native-codex-parent-stop-correction', verdict: 'BLOCKED',
  layer: 'direct-cli-synthetic', remoteModelRequests: 0, realAccounts: 0, nativeInputs: 0 }
let attempt: ProbeAttempt | undefined, child: ChildProcessWithoutNullStreams | undefined
let exited = false, requests = 0, timer: ReturnType<typeof setTimeout> | undefined
let fixture = '', threadId = '', turnId = ''
const output = new ProbeOutput(), notifications: any[] = []
const server = createServer()
try {
  assert.equal(process.env.COCKPIT_PROOF_BACKGROUND, '1')
  assert.ok([evidence, privateDir, contextFile].every(isAbsolute))
  const privateRoot = realpathSync(join(process.env.HOME ?? '', 'vault', 'clients')) + sep
  assert.ok(realpathSync(dirname(privateDir)).startsWith(privateRoot))
  assert.ok(realpathSync(contextFile).startsWith(privateRoot))
  attempt = new ProbeAttempt(evidence, privateDir); attempt.create()
  fixture = dirname(realpathSync(contextFile))
  const context = JSON.parse(readFileSync(contextFile, 'utf8'))
  assert.equal(realpathSync(context.project), join(fixture, 'project'))
  assert.equal(context.env.HOME, join(fixture, 'home'))
  assert.equal(context.env.CODEX_HOME, join(fixture, 'codex-home'))
  assert.equal(sha(context.cli), '74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0')
  assert.equal(sha(process.execPath), '68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b')
  for (const [key, file] of Object.entries({ callback: join(fixture, 'stop-observer.cjs'),
    hooks: join(fixture, 'codex-home/hooks.json'), config: join(fixture, 'codex-home/config.toml') })) {
    assert.equal(sha(file), context.manifest[key])
  }
  assert.equal(sha(join(fixture, 'stop-observer.cjs')), sha(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/w13-stop-observer.cjs')))
  for (const file of ['stop-observations-private.jsonl', 'first-rejection-private']) assert.equal(existsSync(join(fixture, file)), false)
  assert.ok(!['/etc/codex/config.toml', '/etc/codex/managed_config.toml', '/etc/codex/requirements.toml',
    '/Library/Managed Preferences/com.openai.codex.plist',
    join('/Library/Managed Preferences', process.env.USER ?? '', 'com.openai.codex.plist')].some(existsSync))
  let fail!: (error: Error) => void, finish!: () => void
  const completed = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject })
  // A finite Responses stream returns text only. Native Stop commands are the only callbacks.
  server.on('request', (request, response) => {
    const chunks: Buffer[] = []; let bytes = 0
    request.on('error', () => fail(new Error('Loopback transport failed')))
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 2_000_000) { request.destroy(); fail(new Error('Loopback input exceeded limit')); return }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses')
        assert.equal(request.headers.authorization, undefined)
        requests++; assert.ok(requests <= 2, 'More than one correction inference')
        const wire = Buffer.concat(chunks)
        const body = request.headers['content-encoding'] === 'gzip' ? gunzipSync(wire, { maxOutputLength: 2_000_000 }) : wire
        JSON.parse(body.toString('utf8'))
        attempt!.writePrivate(`request-${requests}-private.json`, body)
        const id = `w13-response-${requests}`, item = { id: `w13-message-${requests}`, type: 'message', role: 'assistant',
          status: 'completed', content: [{ type: 'output_text', text: 'READY', annotations: [] }] }
        const events = [
          { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
          { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
          { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
          { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'READY' },
          { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'READY' },
          { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } },
        ]
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))
      } catch (error) { response.destroy(); fail(error instanceof Error ? error : new Error('Invalid fixture request')) }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const configPath = join(fixture, 'codex-home/config.toml'), beforeConfig = readFileSync(configPath, 'utf8')
  assert.equal(beforeConfig.match(/http:\/\/127\.0\.0\.1:1\/v1/g)?.length, 1)
  attempt.writePrivate('config-before-private.toml', beforeConfig)
  // Only the owned inert fixture provider endpoint changes; native trust hashes stay intact.
  writeFileSync(configPath, beforeConfig.replace('http://127.0.0.1:1/v1', `http://127.0.0.1:${address.port}/v1`), { mode: 0o600 })
  attempt.writePrivate('config-execution-private.toml', readFileSync(configPath))
  const repo = dirname(dirname(fileURLToPath(import.meta.url)))
  receipt.sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  receipt.sourceIndexTree = execFileSync('git', ['write-tree'], { cwd: repo, encoding: 'utf8' }).trim()
  receipt.harnessSha256 = sha(fileURLToPath(import.meta.url))
  child = spawn(context.cli, ['app-server'], { cwd: context.project, env: context.env, stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = new Promise<void>((resolve) => {
    child!.once('error', () => fail(new Error('Owned native helper could not start')))
    child!.once('close', () => { exited = true; resolve() })
  })
  const capture = (channel: 'stdout' | 'stderr', chunk: Buffer): void => {
    if (output.overflow) return
    try { output.append(channel, chunk) } catch (error) { fail(error as Error); child!.kill('SIGKILL'); child!.stdout.destroy(); child!.stderr.destroy() }
  }
  child.stdout.on('data', (chunk: Buffer) => capture('stdout', chunk))
  child.stderr.on('data', (chunk: Buffer) => capture('stderr', chunk))
  child.stdin.on('error', () => fail(new Error('Native input closed')))
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  let requestId = 0
  const rpc = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    const id = ++requestId
    const wait = setTimeout(() => reject(new Error('Native protocol/capability deadline exceeded')), method === 'initialize' ? 15_000 : 30_000)
    pending.set(id, { resolve, reject, timer: wait })
    child!.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const message = JSON.parse(line)
      if (message.id !== undefined) {
        if (message.method) throw new Error('Unexpected native server control request')
        const waiter = pending.get(message.id); assert.ok(waiter)
        clearTimeout(waiter.timer)
        pending.delete(message.id)
        if (message.error) { const error = new Error('Native request rejected'); waiter.reject(error); throw error }
        waiter.resolve(message.result)
      } else {
        notifications.push(message)
        if (message.method === 'error') throw new Error('Native turn error')
        if (message.method === 'turn/completed') {
          assert.equal(message.params.threadId, threadId)
          assert.equal(message.params.turn.id, turnId)
          assert.equal(message.params.turn.status, 'completed')
          finish()
        }
      }
    } catch (error) { fail(error instanceof Error ? error : new Error('Invalid native event')) }
  })
  const flow = async (): Promise<void> => {
    await rpc('initialize', { clientInfo: { name: 'agent-cockpit-w13-proof', version: '1' }, capabilities: { experimentalApi: true } })
    child!.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
    const listed = await rpc('hooks/list', { cwds: [context.project] })
    attempt!.writePrivate('hooks-execution-private.json', JSON.stringify(listed))
    const hooks = listed.data.flatMap((entry: any) => entry.hooks)
    assert.equal(hooks.length, 2)
    assert.ok(hooks.every((row: any) => row.eventName === 'stop' && row.enabled && row.trustStatus === 'trusted'))
    const reviewed = JSON.parse(readFileSync(join(fixture, 'hooks-after-trust-private.json'), 'utf8')).result.data
      .flatMap((entry: any) => entry.hooks)
    assert.deepEqual(hooks.map((row: any) => [row.key, row.currentHash]).sort(),
      reviewed.map((row: any) => [row.key, row.currentHash]).sort())
    const thread = await rpc('thread/start', { cwd: context.project, ephemeral: true, model: 'w13-fixture',
      modelProvider: 'w13fixture', approvalPolicy: 'never', sandbox: 'read-only' })
    threadId = thread.thread.id; assert.ok(threadId)
    receipt.nativeInputs = 1
    const turn = await rpc('turn/start', { threadId, input: [{ type: 'text', text: 'Reply READY. Do not use tools.' }] })
    turnId = turn.turn.id; assert.ok(turnId)
    await completed
  }
  // Protocol wait is independently bounded inside the overall native launch budget.
  timer = setTimeout(() => fail(new Error('Native Stop observation exceeded 60 seconds')), 60_000)
  try { await Promise.race([flow(), completed, closed.then(() => { throw new Error('Native helper exited before completion') })]) }
  finally {
    clearTimeout(timer)
    for (const waiter of pending.values()) clearTimeout(waiter.timer)
    if (!exited) child.kill('SIGKILL')
    let retirement: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([closed, new Promise<never>((_resolve, reject) => {
      retirement = setTimeout(() => { child!.unref(); child!.stdin.destroy(); child!.stdout.destroy(); child!.stderr.destroy(); reject(new Error('Owned helper retirement uncertain')) }, 5_000)
    })]) } finally { clearTimeout(retirement) }
  }
  assert.equal(output.overflow, false)
  const records = readFileSync(join(fixture, 'stop-observations-private.jsonl'), 'utf8')
  attempt.writePrivate('stop-observations-private.jsonl', records)
  const parsed = records.trim().split('\n').map((line) => JSON.parse(line))
  receipt.callbackRecords = assessCodexStopRecords(parsed, threadId, turnId)
  receipt.hookEvents = assessCodexHookEvents(notifications, threadId, turnId)
  attempt.writePrivate('binding-private.json', JSON.stringify({ threadId, turnId }))
  assert.equal(requests, 2)
  // This observation intentionally does not invent cycle IDs from hook-run IDs or model text.
  receipt.verdict = 'OBSERVED_NATIVE_CORRECTION_CYCLE_ID_UNPROVED'
} catch (error) {
  attempt?.writePrivate('error-private.txt', error instanceof Error ? error.stack ?? error.message : 'Unknown failure')
  process.exitCode = 1
} finally {
  clearTimeout(timer)
  if (server.listening) { server.closeAllConnections(); server.close() }
  attempt?.writePrivate('native-output-private.txt', output.snapshot())
  attempt?.writePrivate('notifications-private.json', JSON.stringify(notifications, null, 2))
  receipt.loopbackRequests = requests; receipt.ownedProviderExited = exited; receipt.outputOverflow = output.overflow
  receipt.limitations = ['Synthetic native correction only; real account/workspace matrix open',
    'Cycle grouping and host-owned enforcement are not established', 'No SubagentStop execution']
  attempt?.writeReceipt(receipt)
  console.log(JSON.stringify({ verdict: receipt.verdict, loopbackRequests: requests, ownedProviderExited: exited }))
}
