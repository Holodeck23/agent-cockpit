// W13 U6 oracle, no account: does a stripped plugin copy expose the same skills, commands and agents
// as the plugin itself? Pinned Claude reports what it discovered in its init message before it finds
// out it is not signed in, so each run uses an empty config folder, all hooks off and no connectors.
//   COCKPIT_PROBE_PROFILE=<CLI default profile> COCKPIT_W13_CLAUDE=<pinned claude> COCKPIT_PROOF_DIR=<out>
//   node node_modules/tsx/dist/cli.mjs scripts/probe-w13-plugin-discovery.ts
// Reads the profile and its plugin cache only; writes nothing there. Records names, never paths.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listEnabledPlugins } from '../server/agents/setup/plugin-projection.ts'
import { materializeSkillProjection, projectionPluginDirs, PROJECTION_PLUGIN, snapshotSkillSource } from '../server/agents/setup/skill-projection.ts'

const profile = process.env.COCKPIT_PROBE_PROFILE ?? '', cli = process.env.COCKPIT_W13_CLAUDE ?? '', out = process.env.COCKPIT_PROOF_DIR ?? ''
assert.ok(profile && cli && out, 'Set COCKPIT_PROBE_PROFILE, COCKPIT_W13_CLAUDE and COCKPIT_PROOF_DIR')
const version = execFileSync(cli, ['--version'], { encoding: 'utf8' }).trim()
const git = (args: string[]): string => execFileSync('git', args, { encoding: 'utf8' }).trim()
const source = { head: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']) !== '' }
const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-w13-plugin-probe-')))

interface Seen { readonly commands: string[]; readonly skills: string[]; readonly agents: string[]; readonly plugins: string[]; readonly mcpServers: number; readonly synthetic: boolean }
/** One Claude start with the given plugin folders; what its init message lists. */
function discover(pluginDirs: readonly string[]): Seen {
  const config = mkdtempSync(join(root, 'config-')), cwd = mkdtempSync(join(root, 'cwd-'))
  const run = spawnSync(cli, ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', '{"disableAllHooks":true}',
    ...pluginDirs.flatMap((dir) => ['--plugin-dir', dir]), '--model', 'haiku'], {
    cwd, encoding: 'utf8', timeout: 60_000, input: `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`,
    env: { HOME: process.env.HOME ?? '', PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: config },
  })
  const lines = run.stdout.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) as Record<string, unknown> } catch { return {} } })
  const init = lines.find((line) => line.type === 'system' && line.subtype === 'init') as
    { slash_commands?: string[]; skills?: string[]; agents?: string[]; plugins?: Array<{ name: string }>; mcp_servers?: unknown[] } | undefined
  assert.ok(init, `No init message (exit ${run.status}): ${run.stderr.slice(0, 300)}`)
  const assistant = lines.find((line) => line.type === 'assistant') as { message?: { model?: string } } | undefined
  return { commands: [...(init.slash_commands ?? [])].sort(), skills: [...(init.skills ?? [])].sort(), agents: [...(init.agents ?? [])].sort(),
    plugins: (init.plugins ?? []).map((plugin) => plugin.name).sort(), mcpServers: init.mcp_servers?.length ?? 0,
    // Not signed in: the CLI answers itself. Anything else means an account was reached.
    synthetic: assistant?.message?.model === '<synthetic>' }
}
const scoped = (seen: Seen, name: string) => ({
  commands: seen.commands.filter((entry) => entry.startsWith(`${name}:`)), skills: seen.skills.filter((entry) => entry.startsWith(`${name}:`)),
  agents: seen.agents.filter((entry) => entry.startsWith(`${name}:`)),
})
const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((entry, i) => entry === b[i])

const results: Record<string, unknown>[] = []
let verdict: 'passed' | 'failed' = 'passed'
try {
  const enabled = listEnabledPlugins(profile).filter((row) => !row.problem)
  const all = snapshotSkillSource(profile, { plugins: enabled })
  const projection = materializeSkillProjection(all, join(root, 'projections'))
  for (const plugin of enabled) {
    const copy = join(root, 'native', plugin.name)
    mkdirSync(join(root, 'native'), { recursive: true })
    cpSync(plugin.installPath, copy, { recursive: true, verbatimSymlinks: true })
    const native = scoped(discover([copy]), plugin.name)
    const strippedSeen = discover([join(projection, '.cockpit-plugins', plugin.name)])
    const stripped = scoped(strippedSeen, plugin.name)
    const match = same(native.commands, stripped.commands) && same(native.skills, stripped.skills) && same(native.agents, stripped.agents)
    if (!match || !strippedSeen.synthetic) verdict = 'failed'
    results.push({ plugin: plugin.key, native: { commands: native.commands.length, skills: native.skills.length, agents: native.agents.length },
      stripped: { commands: stripped.commands.length, skills: stripped.skills.length, agents: stripped.agents.length, mcpServers: strippedSeen.mcpServers },
      match, ...(match ? {} : { onlyNative: [...native.commands, ...native.agents].filter((e) => ![...stripped.commands, ...stripped.agents].includes(e)),
        onlyStripped: [...stripped.commands, ...stripped.agents].filter((e) => ![...native.commands, ...native.agents].includes(e)) }) })
  }
  // Every folder at once, as a launch passes them: my-setup must hold only the profile's own entries.
  // Every folder at once, as a launch passes them: my-setup must list exactly what it lists alone, so
  // nothing in the nested plugin copies is read as part of it.
  const alone = scoped(discover([projectionPluginDirs(snapshotSkillSource(profile), materializeSkillProjection(snapshotSkillSource(profile), join(root, 'alone')))[0]!]), PROJECTION_PLUGIN)
  const together = discover(projectionPluginDirs(all, projection))
  const mine = scoped(together, PROJECTION_PLUGIN)
  const unchanged = same(alone.commands, mine.commands) && same(alone.skills, mine.skills) && same(alone.agents, mine.agents)
  if (!together.synthetic || !unchanged) verdict = 'failed'
  // Claude also counts a skill folder nested deeper than the snapshot's own count does.
  const deeper = mine.skills.map((entry) => entry.slice(PROJECTION_PLUGIN.length + 1)).filter((name) => !all.skills.includes(name))
  results.push({ together: { plugins: together.plugins, mySetupUnchangedByPlugins: unchanged, mySetupSkills: mine.skills.length, snapshotSkills: all.skills.length,
    skillsClaudeFindsBeyondSnapshotCount: deeper, mySetupAgents: mine.agents.length, snapshotAgents: all.agents.length, mcpServers: together.mcpServers } })
} catch (error) {
  verdict = 'failed'
  results.push({ error: error instanceof Error ? error.message.replaceAll(profile, '<profile>').replaceAll(root, '<root>') : String(error) })
} finally {
  rmSync(root, { recursive: true, force: true })
}
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'plugin-discovery.json'), `${JSON.stringify({ probe: 'W13-U6 stripped plugin discovery oracle (no account)', cli: version, source, at: new Date().toISOString(), verdict, results }, null, 2)}\n`)
console.log(`[w13-plugin-probe] ${verdict}`)
console.log(JSON.stringify(results, null, 2))
if (verdict !== 'passed') process.exitCode = 1
