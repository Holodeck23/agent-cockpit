// One isolated native Codex typed-skill attempt through app-server, observed at loopback.
// No real account/auth, remote model or user memories. Optional resource mode reads one synthetic file.
import assert from 'node:assert/strict'
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { createInterface } from 'node:readline'
import { ProbeAttempt, ProbeOutput } from './lib/w13-completion-probe.ts'
import { assessNativeSkillRequest, assessNativeSkillResource } from './lib/w13-skill-request.ts'

process.umask(0o077)
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
const cli = process.env.COCKPIT_W13_CODEX ?? '', evidence = process.env.COCKPIT_PROOF_DIR ?? '', privateDir = process.env.COCKPIT_PROOF_PRIVATE_DIR ?? ''
const resourceRead = process.env.COCKPIT_W13_SKILL_RESOURCE === 'read-only'
const workspaceKind = process.env.COCKPIT_W13_FIXTURE_WORKSPACE ?? 'primary'
const receipt: Record<string, unknown> = { scenario: 'native-codex-typed-skill-request', layer: 'direct-cli-synthetic',
  startedAt: new Date().toISOString(), verdict: 'BLOCKED', remoteModelRequests: 0, nativeInputs: 0, loopbackRequests: 0,
  accountScope: 'inert-unauthenticated-fixture', workspaceScope: 'isolated-synthetic-project' }
let attempt: ProbeAttempt | undefined, child: ChildProcessWithoutNullStreams | undefined
let ownedExited = false, requestCount = 0, outputError: Error | undefined
const raw = new ProbeOutput()
const server = createServer()
let timeout: ReturnType<typeof setTimeout> | undefined
try {
  assert.equal(process.env.COCKPIT_PROOF_BACKGROUND, '1')
  assert.ok(process.env.COCKPIT_W13_SKILL_RESOURCE === undefined || resourceRead)
  assert.ok(['primary', 'worktree'].includes(workspaceKind))
  assert.ok([cli, evidence, privateDir].every(isAbsolute))
  const root = realpathSync(join(process.env.HOME ?? '', 'vault', 'clients')) + sep
  assert.ok(realpathSync(dirname(privateDir)).startsWith(root))
  attempt = new ProbeAttempt(evidence, privateDir); attempt.create()
  assert.equal(sha(cli), '74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0')
  assert.equal(sha(process.execPath), '68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b')
  // A system-managed executable source cannot be hidden by an isolated HOME.
  assert.ok(!['/etc/codex/config.toml', '/etc/codex/managed_config.toml', '/etc/codex/requirements.toml',
    '/Library/Managed Preferences/com.openai.codex.plist',
    join('/Library/Managed Preferences', process.env.USER ?? '', 'com.openai.codex.plist')].some(existsSync), 'System-managed config requires review before this fixture')
  const script = fileURLToPath(import.meta.url), repo = dirname(dirname(script))
  receipt.sourceParent = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
  receipt.sourceIndexTree = execFileSync('git', ['write-tree'], { cwd: repo, encoding: 'utf8' }).trim()
  receipt.harnessSha256 = sha(script)
  receipt.provider = { name: 'codex', version: '0.162.1', executableSha256: sha(cli), runtimeSha256: sha(process.execPath) }
  const home = join(privateDir, 'home'), codexHome = join(privateDir, 'codex-home'), project = join(privateDir, 'project')
  let cwd = project
  mkdirSync(project, { mode: 0o700 }); mkdirSync(home, { mode: 0o700 })
  const gitEnv = { HOME: home, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  execFileSync('/usr/bin/git', ['init', '-q', project], { env: gitEnv, timeout: 10_000 })
  if (workspaceKind === 'worktree') {
    execFileSync('/usr/bin/git', ['-C', project, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=W13 fixture', '-c', 'user.email=w13@example.invalid',
      'commit', '--allow-empty', '-qm', 'Synthetic worktree baseline'], { env: gitEnv, timeout: 10_000 })
    cwd = join(privateDir, 'worktree')
    execFileSync('/usr/bin/git', ['-C', project, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-q', '-b', 'w13-fixture', cwd], { env: gitEnv, timeout: 10_000 })
  }
  receipt.fixtureWorkspaceKind = workspaceKind
  receipt.resourceReadRequested = resourceRead
  const selectedDir = join(cwd, '.agents', 'skills', 'w13-shared-skill')
  const otherDir = join(home, '.agents', 'skills', 'w13-shared-skill')
  for (const dir of [home, codexHome, project, selectedDir, otherDir]) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const selected = `W13_SELECTED_SKILL_${randomUUID()}`, excluded = `W13_OTHER_SKILL_${randomUUID()}`
  const resource = `W13_RESOURCE_${randomUUID()}`
  const selectedFile = join(selectedDir, 'SKILL.md'), otherFile = join(otherDir, 'SKILL.md')
  const skill = (marker: string): string => `---\nname: w13-shared-skill\ndescription: Inert W13 typed skill source.\n---\n\n${marker}\nA supporting file is reference.txt. ${resourceRead ? 'Only the selected reference may be read.' : 'Do not execute tools.'}\n`
  writeFileSync(selectedFile, skill(selected), { flag: 'wx', mode: 0o600 })
  writeFileSync(otherFile, skill(excluded), { flag: 'wx', mode: 0o600 })
  writeFileSync(join(selectedDir, 'reference.txt'), resource, { flag: 'wx', mode: 0o600 })
  const prompt = `  --label "two words"\n--target W13_ARG_${randomUUID()}  `
  const resourceCallId = 'w13-reviewed-resource-read'
  let firstBody: unknown
  let acceptRequest!: (body: unknown) => void, rejectRequest!: (error: Error) => void
  const captured = new Promise<unknown>((resolve, reject) => { acceptRequest = resolve; rejectRequest = reject })
  server.on('request', (request, response) => {
    const chunks: Buffer[] = []; let size = 0
    request.on('error', () => rejectRequest(new Error('Loopback request failed')))
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 2_000_000) { request.destroy(); rejectRequest(new Error('Loopback request exceeded its byte bound')); return }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses')
        assert.equal(request.headers.authorization, undefined, 'Unexpected authentication on a fixture request')
        requestCount++
        assert.ok(requestCount <= (resourceRead ? 2 : 1), 'Unexpected extra inference request')
        attempt!.writePrivate(`model-request-${requestCount}-wire-private.bin`, Buffer.concat(chunks))
        const bytes = request.headers['content-encoding'] === 'gzip'
          ? gunzipSync(Buffer.concat(chunks), { maxOutputLength: 2_000_000 }) : Buffer.concat(chunks)
        attempt!.writePrivate(`model-request-${requestCount}-private.json`, bytes)
        const body: unknown = JSON.parse(bytes.toString('utf8'))
        if (resourceRead && requestCount === 1) {
          firstBody = body
          assessNativeSkillRequest(body, selected, excluded, prompt, resource)
          const tools = (body as { tools?: { name?: string; parameters?: any }[] }).tools
          const tool = tools?.find((item) => item.name === 'exec_command')
          assert.ok(tool?.parameters?.properties?.cmd && tool.parameters.properties.workdir, 'Reviewed native resource read tool unavailable')
          const call = { type: 'function_call', id: 'w13-resource-item', call_id: resourceCallId,
            name: 'exec_command', arguments: JSON.stringify({ cmd: '/bin/cat reference.txt', workdir: selectedDir, login: false, max_output_tokens: 500 }) }
          response.writeHead(200, { 'Content-Type': 'text/event-stream' })
          response.end(`data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: call })}\n\n`
            + `data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: call })}\n\n`
            + `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'w13-local-resource', output: [call], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } })}\n\n`)
          return
        }
        // Request-only mode never returns a tool. Resource mode permits one fixed synthetic cat.
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.end('data: {"type":"response.completed","response":{"id":"w13-local","output":[],"usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}\n\n')
        acceptRequest(body)
      } catch (error) { response.destroy(); rejectRequest(error instanceof Error ? error : new Error('Invalid loopback request')) }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const config = `model_provider = "w13fixture"\nmodel = "w13-fixture"\napproval_policy = "never"\nsandbox_mode = "read-only"\ncheck_for_update_on_startup = false\n[features]\nmemories = false\nmulti_agent = false\nhooks = false\napps = false\nplugins = false\nshell_tool = false\n[memories]\ngenerate_memories = false\nuse_memories = false\n[model_providers.w13fixture]\nname = "W13 loopback capture"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`
  writeFileSync(join(codexHome, 'config.toml'), 'web_search = "disabled"\n' + (resourceRead
    ? config.replace('shell_tool = false', 'shell_tool = true').replace('[features]\n', '[features]\nunified_exec = true\n') : config)
    .replace(`[projects.${JSON.stringify(project)}]`, `[projects.${JSON.stringify(cwd)}]`), { flag: 'wx', mode: 0o600 })
  const env: NodeJS.ProcessEnv = { HOME: home, CODEX_HOME: codexHome, TMPDIR: privateDir,
    PATH: '/usr/bin:/bin:/opt/homebrew/bin', USER: process.env.USER, LOGNAME: process.env.LOGNAME, LANG: 'en_US.UTF-8' }
  child = spawn(cli, ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = new Promise<void>((resolve) => {
    child!.once('error', () => { outputError = new Error('Owned native fixture could not start') })
    child!.once('close', () => { ownedExited = true; resolve() })
  })
  const capture = (channel: 'stdout' | 'stderr', chunk: Buffer): void => {
    if (raw.overflow) return
    try { raw.append(channel, chunk) } catch (error) {
      outputError = error instanceof Error ? error : new Error('Output capture failed')
      rejectRequest(outputError); child!.kill('SIGKILL'); child!.stdout.destroy(); child!.stderr.destroy()
    }
  }
  child.stdout.on('data', (chunk: Buffer) => capture('stdout', chunk))
  child.stderr.on('data', (chunk: Buffer) => capture('stderr', chunk))
  const send = (message: unknown): void => { child!.stdin.write(JSON.stringify(message) + '\n') }
  let initTimer: ReturnType<typeof setTimeout> | undefined, capabilityTimer: ReturnType<typeof setTimeout> | undefined
  initTimer = setTimeout(() => rejectRequest(new Error('Protocol initialize exceeded 15 seconds')), 15_000)
  child.stdin.on('error', () => rejectRequest(new Error('Native protocol input closed')))
  let chosen: { name: string; path: string } | undefined
  let phase: 'initializing' | 'listing' | 'starting' | 'turn' = 'initializing'
  const sameFile = (path: unknown, target: string): boolean => {
    try { return typeof path === 'string' && realpathSync(path.startsWith('file://') ? fileURLToPath(path) : path) === target } catch { return false }
  }
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const message = JSON.parse(line)
      if (message.error) throw new Error('Native app-server rejected a planned request')
      if (message.method && message.id !== undefined) throw new Error('Unexpected native server control request')
      if (message.id === 1) {
        assert.equal(phase, 'initializing'); phase = 'listing'
        clearTimeout(initTimer)
        send({ method: 'initialized' })
        capabilityTimer = setTimeout(() => rejectRequest(new Error('Skill discovery exceeded 30 seconds')), 30_000)
        send({ id: 2, method: 'skills/list', params: { cwds: [cwd], forceReload: true } })
      } else if (message.id === 2) {
        assert.equal(phase, 'listing'); phase = 'starting'
        clearTimeout(capabilityTimer)
        const entries = message.result?.data
        assert.ok(Array.isArray(entries))
        const skills = entries.flatMap((entry: any) => entry.skills ?? [])
        const selectedRows = skills.filter((row: any) => sameFile(row.path, selectedFile))
        const otherRows = skills.filter((row: any) => sameFile(row.path, otherFile))
        assert.equal(selectedRows.length, 1, 'The exact selected skill was not discovered')
        assert.equal(otherRows.length, 1, 'The same-name user skill was not discovered')
        chosen = selectedRows[0]
        assert.ok(chosen && chosen.name === 'w13-shared-skill' && selectedRows[0].enabled === true)
        assert.equal(otherRows[0].name, chosen.name)
        receipt.distinctSameNameSourcesListed = true
        send({ id: 3, method: 'thread/start', params: { cwd, ephemeral: true,
          model: 'w13-fixture', modelProvider: 'w13fixture', approvalPolicy: 'never', sandbox: 'read-only' } })
      } else if (message.id === 3) {
        assert.equal(phase, 'starting'); phase = 'turn'
        const threadId = message.result?.thread?.id
        assert.ok(typeof threadId === 'string' && threadId.length > 0 && chosen)
        attempt!.writePrivate('native-binding-private.json', JSON.stringify({ threadId, selectedPath: chosen.path, arguments: prompt }) + '\n')
        receipt.nativeInputs = 1
        send({ id: 4, method: 'turn/start', params: { threadId,
          input: [{ type: 'skill', name: chosen.name, path: chosen.path }, { type: 'text', text: prompt }] } })
      } else if (message.id !== undefined) assert.equal(message.id, 4, 'Unexpected native response identity')
    } catch (error) { rejectRequest(error instanceof Error ? error : new Error('Invalid native protocol message')) }
  })
  send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent-cockpit-w13-proof', version: '1' }, capabilities: { experimentalApi: true } } })
  const deadline = new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Native skill request exceeded 60 seconds')), 60_000) })
  let body: unknown
  try {
    body = await Promise.race([captured, closed.then(() => { throw outputError ?? new Error('Native fixture exited before an inference request') }), deadline])
  } finally {
    clearTimeout(timeout); clearTimeout(initTimer); clearTimeout(capabilityTimer)
    if (!ownedExited) child.kill('SIGKILL')
    let retirementTimer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([closed, new Promise<never>((_resolve, reject) => {
      retirementTimer = setTimeout(() => { child!.unref(); child!.stdin.destroy(); child!.stdout.destroy(); child!.stderr.destroy(); reject(new Error('Owned fixture termination is uncertain')) }, 5_000)
    })]) } finally { clearTimeout(retirementTimer) }
  }
  assert.equal(outputError, undefined)
  assert.equal(requestCount, resourceRead ? 2 : 1)
  receipt.observation = assessNativeSkillRequest(resourceRead ? firstBody : body, selected, excluded, prompt, resource)
  if (resourceRead) receipt.resourceObservation = assessNativeSkillResource(body, resourceCallId, resource, excluded)
  receipt.verdict = resourceRead ? 'PASS_NATIVE_TYPED_SKILL_AND_RESOURCE_READ' : 'PASS_NATIVE_TYPED_SKILL_REQUEST_CONTEXT'
} catch (error) {
  receipt.error = 'Native fixture stopped; inspect private diagnostics before any further attempt'
  attempt?.writePrivate('error-private.txt', error instanceof Error ? error.stack ?? error.message : 'Unknown failure')
  process.exitCode = 1
} finally {
  clearTimeout(timeout)
  if (server.listening) { server.closeAllConnections(); server.close() }
  attempt?.writePrivate('native-output-private.txt', raw.snapshot())
  receipt.loopbackRequests = requestCount
  receipt.ownedProviderExited = ownedExited
  receipt.outputOverflow = raw.overflow
  receipt.finishedAt = new Date().toISOString()
  receipt.limitations = [resourceRead ? 'Synthetic selected-resource read; no real model selection or arbitrary skill script execution' : 'Native typed-skill request construction only; no real model execution or resource tool read',
    'Inert synthetic profile; default/managed and primary/worktree matrix remains open',
    'No native policy enforcement, completion-cycle or skill lifecycle proof']
  attempt?.writeReceipt(receipt)
  console.log(JSON.stringify({ verdict: receipt.verdict, loopbackRequests: requestCount, ownedProviderExited: ownedExited }))
}
