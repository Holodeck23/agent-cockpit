// Stock-runtime configuration observation only: fictional profiles, no threads or model calls.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { queryAppServer } from '../server/agents/codex/app-server-query.ts'

process.umask(0o077)
const evidence = process.env.COCKPIT_PROOF_DIR ?? ''
const cli = process.env.COCKPIT_W13_CODEX ?? ''
const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
const receipt: Record<string, unknown> = { verdict: 'STOPPED', realAccounts: 0, nativeThreads: 0, modelInputs: 0,
  scope: 'Effective config only; not executable-hook/plugin behavior or MCP isolation' }
let owned = false
try {
  assert.equal(process.env.COCKPIT_PROOF_BACKGROUND, '1')
  assert.ok(isAbsolute(evidence) && isAbsolute(cli))
  mkdirSync(evidence, { mode: 0o700 }); owned = true
  assert.equal(sha(realpathSync(cli)), '74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0')
  assert.ok(!['/etc/codex/config.toml', '/etc/codex/managed_config.toml', '/etc/codex/requirements.toml',
    '/Library/Managed Preferences/com.openai.codex.plist',
    join('/Library/Managed Preferences', process.env.USER ?? '', 'com.openai.codex.plist')].some(existsSync),
  'System/managed configuration is outside this fictional fixture')
  // The vault outputs entry can be a symlink. Native source paths are canonical.
  const fixtureRoot = realpathSync(evidence)
  const home = join(fixtureRoot, 'home'), primary = join(fixtureRoot, 'primary'), worktree = join(fixtureRoot, 'linked-worktree')
  for (const dir of [home, primary]) mkdirSync(dir, { mode: 0o700 })
  const env = { HOME: home, PATH: '/usr/bin:/bin:/opt/homebrew/bin', LANG: 'en_US.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  const git = (...args: string[]): void => { execFileSync('/usr/bin/git', args, { cwd: primary, env, timeout: 10_000, stdio: 'pipe' }) }
  git('init', '-q'); git('-c', 'user.name=W13 Fixture', '-c', 'user.email=w13@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'Fictional startup fixture')
  git('worktree', 'add', '-q', '--detach', worktree)
  // Both source layers actively request the executable features we suppress. There is no
  // actual plugin or executable hook to install/trust, and no credential file is created.
  const executableConfig = 'notify=["fictional-notification-canary"]\n[features]\nhooks=true\nplugins=true\napps=true\nenable_mcp_apps=true\nskill_mcp_dependency_install=true\n'
  const files: string[] = []
  for (const cwd of [primary, worktree]) {
    mkdirSync(join(cwd, '.codex'), { mode: 0o700 })
    const path = join(cwd, '.codex', 'config.toml')
    writeFileSync(path, executableConfig, { flag: 'wx', mode: 0o600 }); files.push(path)
  }
  const cases: Record<string, unknown>[] = []
  for (const mode of ['default', 'managed'] as const) {
    const profile = mode === 'default' ? join(home, '.codex') : join(fixtureRoot, 'managed-profile')
    mkdirSync(profile, { mode: 0o700 })
    const config = join(profile, 'config.toml')
    writeFileSync(config, executableConfig + `\n[projects.${JSON.stringify(primary)}]\ntrust_level="trusted"\n`, { flag: 'wx', mode: 0o600 })
    files.push(config)
    const before = Object.fromEntries(files.map(file => [file, sha(file)]))
    for (const cwd of [primary, worktree]) {
      process.chdir(cwd)
      const answer = await queryAppServer(cli, 'config/read', { cwd, includeLayers: true }, {
        env: { ...env, ...(mode === 'managed' ? { CODEX_HOME: profile } : {}) }, timeoutMs: 15_000, experimentalApi: true,
      })
      assert.equal(answer.error, undefined)
      writeFileSync(join(evidence, `${mode}-${cwd === primary ? 'primary' : 'worktree'}-config.json`), JSON.stringify(answer.result, null, 2), { flag: 'wx', mode: 0o600 })
      const result = answer.result as { config: { features: Record<string, unknown>; notify: unknown }; layers: { name: { type: string; file?: string }; config: unknown }[] }
      for (const feature of ['hooks', 'plugins', 'apps', 'enable_mcp_apps', 'skill_mcp_dependency_install']) assert.equal(result.config.features[feature], false)
      assert.deepEqual(result.config.notify, [])
      assert.ok(result.layers.some(layer => layer.name.type === 'user' && layer.name.file === config))
      assert.ok(result.layers.some(layer => layer.name.type === 'project'))
      assert.ok(result.layers.some(layer => layer.name.type === 'sessionFlags'))
      for (const [file, hash] of Object.entries(before)) assert.equal(sha(file), hash)
      cases.push({ account: mode, workspace: cwd === primary ? 'primary' : 'linked-worktree',
        executableFeaturesDisabled: 5, notificationsCleared: true, selectedProfileObserved: true, sourceFilesUnchanged: true })
    }
  }
  receipt.verdict = 'PASS_EFFECTIVE_CONFIG_ONLY'; receipt.cases = cases
  receipt.cliSha256 = sha(realpathSync(cli)); receipt.nodeSha256 = sha(process.execPath)
} catch (error) {
  if (owned) writeFileSync(join(evidence, 'failure.txt'), error instanceof Error ? error.stack ?? error.message : String(error), { flag: 'wx', mode: 0o600 })
  process.exitCode = 1
} finally {
  if (owned) writeFileSync(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify(receipt))
}
