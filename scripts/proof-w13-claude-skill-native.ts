// One pinned, no-tools Claude slash-skill call in an isolated project. Synthetic canary only.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
const cli = '/Users/Nova/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
const evidenceDir = process.env.COCKPIT_PROOF_DIR ?? ''
const privateDir = process.env.COCKPIT_PROOF_PRIVATE_DIR ?? ''
const accountId = process.env.COCKPIT_PROOF_ACCOUNT_ID ?? ''
const receipt: Record<string, unknown> = { probe: 'W13 Claude native slash skill with argument',
  verdict: 'STOPPED', startedAt: new Date().toISOString(), providerCalls: 0 }

try {
  assert.equal(process.env.COCKPIT_PROOF_BACKGROUND, '1')
  assert.ok(isAbsolute(evidenceDir) && isAbsolute(privateDir) && /^[0-9a-f-]{36}$/.test(accountId))
  assert.equal(sha(cli), '8addc857f3fe64d5a0368af9ee50321b50afb4a6918ba3ef018ab84f5dbbe081')
  assert.equal(sha(process.execPath), '68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b')
  const registry = JSON.parse(readFileSync(join(homedir(), '.agent-cockpit', 'accounts.json'), 'utf8')) as
    { accounts: Array<{ id: string; agent: string; mode: string; generation: number; identity?: { state: string } }> }
  const account = registry.accounts.find((row) => row.id === accountId)
  assert.ok(account && account.agent === 'claude' && account.mode === 'managed' && account.identity?.state === 'known')
  const profile = join(homedir(), '.agent-cockpit', 'account-profiles', accountId)
  assert.equal(realpathSync(profile), profile)
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  mkdirSync(privateDir, { recursive: true, mode: 0o700 })
  const fixture = mkdtempSync(join(privateDir, 'fixture-'))
  const project = join(fixture, 'project')
  const skill = join(project, '.claude', 'skills', 'w13-proof-skill')
  mkdirSync(skill, { recursive: true, mode: 0o700 })
  const marker = `W13SKILL${randomBytes(9).toString('hex').toUpperCase()}`
  writeFileSync(join(skill, 'SKILL.md'), `---\nname: w13-proof-skill\ndescription: Synthetic W13 native invocation proof.\n---\n\nWhen invoked, reply with exactly ${marker}| followed by the invocation argument. Do not use tools.\n`, { mode: 0o600 })
  const settings = join(fixture, 'settings.json'), mcp = join(fixture, 'mcp.json')
  writeFileSync(settings, JSON.stringify({ disableAllHooks: true }), { mode: 0o600 })
  writeFileSync(mcp, JSON.stringify({ mcpServers: {} }), { mode: 0o600 })
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: profile }
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
    'COCKPIT_MCP_TOKEN', 'COCKPIT_MCP_URL']) delete env[key]
  receipt.providerCalls = 1
  const { stdout, stderr } = await run(cli, ['--print', '--output-format', 'json', '--no-session-persistence',
    '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--mcp-config', mcp,
    '--setting-sources', 'project,local', '--settings', settings, '/w13-proof-skill banana'],
  { cwd: project, env, timeout: 90_000, maxBuffer: 2_000_000 })
  writeFileSync(join(fixture, 'provider-output.json'), stdout, { mode: 0o600 })
  if (stderr) writeFileSync(join(fixture, 'provider-stderr.txt'), stderr, { mode: 0o600 })
  const result = JSON.parse(stdout) as { result?: string; is_error?: boolean }
  receipt.exactMarkerAndArgument = result.result?.trim() === `${marker}|banana`
  receipt.providerReportedError = result.is_error === true
  receipt.cliSha256 = sha(cli)
  receipt.accountGeneration = account.generation
  receipt.verdict = receipt.exactMarkerAndArgument && !receipt.providerReportedError
    ? 'PASS_DIRECT_NATIVE_INVOCATION' : 'INCONCLUSIVE_OR_FAIL'
} catch (error) {
  receipt.error = 'Probe stopped; inspect private diagnostics before any retry'
  if (privateDir) {
    mkdirSync(privateDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(privateDir, 'error-private.txt'), error instanceof Error ? error.message : String(error), { mode: 0o600 })
  }
} finally {
  receipt.finishedAt = new Date().toISOString()
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(evidenceDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
  }
}
if (receipt.verdict !== 'PASS_DIRECT_NATIVE_INVOCATION') process.exitCode = 1
