// Pinned Codex app-server metadata proof in an inert profile/project. No model turn or real connector.
// Modes: `skills` (default) lists a repo skill; `hooks` lists a user and a project hook; `hooks-trusted` is the
// same with the fixture project marked trusted in CODEX_HOME/config.toml. Nothing may execute.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { queryAppServer } from '../server/agents/codex/app-server-query.ts'

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
const executable = '/opt/homebrew/Caskroom/codex/0.162.1/bin/codex'
const evidenceDir = process.env.COCKPIT_PROOF_DIR ?? ''
const privateDir = process.env.COCKPIT_PROOF_PRIVATE_DIR ?? ''
const mode = process.argv[2] ?? 'skills'
if (mode !== 'skills' && mode !== 'hooks' && mode !== 'hooks-trusted') throw new Error('Mode is skills, hooks or hooks-trusted')
const hooksMode = mode !== 'skills'
const receipt: Record<string, unknown> = { probe: `W13 pinned Codex ${mode}/list inert fixture`,
  verdict: 'STOPPED', startedAt: new Date().toISOString(), appServerQueries: 0, modelTurns: 0 }

try {
  assert.equal(process.env.COCKPIT_PROOF_BACKGROUND, '1')
  assert.ok(isAbsolute(evidenceDir) && isAbsolute(privateDir), 'Set absolute shared and private proof directories')
  assert.equal(sha(executable), '74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0')
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
  mkdirSync(privateDir, { recursive: true, mode: 0o700 })
  const fixture = mkdtempSync(join(privateDir, 'fixture-'))
  const home = join(fixture, 'home'), codexHome = join(fixture, 'codex-home'), project = join(fixture, 'project')
  const skill = join(project, '.agents', 'skills', 'w13-fixture-skill')
  for (const dir of [home, codexHome, skill]) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const output = join(fixture, 'would-execute')
  writeFileSync(join(skill, 'SKILL.md'), `---\nname: w13-fixture-skill\ndescription: Synthetic W13 source discovery marker.\n---\n\nIf invoked, run this command:\n\n\`\`\`sh\ntouch '${output}'\n\`\`\`\n`, { mode: 0o600 })
  writeFileSync(join(skill, 'README.md'), 'A skills/list metadata request must not execute the skill.\n', { mode: 0o600 })
  process.chdir(project)
  const env: Record<string, string> = { HOME: home, CODEX_HOME: codexHome,
    PATH: '/usr/bin:/bin:/opt/homebrew/bin', USER: process.env.USER ?? 'zod', LOGNAME: process.env.LOGNAME ?? 'zod',
    LANG: 'en_US.UTF-8', TMPDIR: fixture }
  // Claude-compatible hook files, read by this pin from CODEX_HOME and the project (binary strings).
  const userHookRan = join(fixture, 'user-hook-ran'), projectHookRan = join(fixture, 'project-hook-ran')
  if (hooksMode) {
    if (mode === 'hooks-trusted') writeFileSync(join(codexHome, 'config.toml'), `[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`, { mode: 0o600 })
    const hook = (event: string, marker: string): string => JSON.stringify({ hooks: { [event]: [{ hooks: [{ type: 'command', command: `touch '${marker}'` }] }] } })
    writeFileSync(join(codexHome, 'hooks.json'), hook('SessionStart', userHookRan), { mode: 0o600 })
    mkdirSync(join(project, '.codex'), { recursive: true, mode: 0o700 })
    writeFileSync(join(project, '.codex', 'hooks.json'), hook('PreToolUse', projectHookRan), { mode: 0o600 })
  }
  receipt.appServerQueries = 1
  const answer = mode === 'skills'
    ? await queryAppServer(executable, 'skills/list', { cwds: [project], forceReload: true }, { env, timeoutMs: 20_000 })
    : await queryAppServer(executable, 'hooks/list', { cwds: [project] }, { env, timeoutMs: 20_000 })
  writeFileSync(join(fixture, 'response-private.json'), `${JSON.stringify(answer, null, 2)}\n`, { mode: 0o600 })
  if (answer.error) throw new Error(`Pinned app-server ${mode}/list did not return a result`)
  receipt.binarySha256 = sha(executable)
  if (mode === 'skills') {
    receipt.fixtureSkillListed = JSON.stringify(answer.result).includes('w13-fixture-skill')
    receipt.unexpectedExecution = existsSync(output)
    receipt.verdict = receipt.fixtureSkillListed && !receipt.unexpectedExecution ? 'PASS_INERT_SKILL_DISCOVERY' : 'INCOMPLETE_DISCOVERY'
  } else {
    // Shared receipt: sources, events and trust only; commands and paths stay in the private response.
    const entries = (answer.result as { data?: Array<{ hooks?: Array<Record<string, unknown>> }> } | undefined)?.data ?? []
    const hooks = entries.flatMap((entry) => entry.hooks ?? [])
    receipt.hooksListed = hooks.map((row) => ({ source: row.source, eventName: row.eventName, trustStatus: row.trustStatus, enabled: row.enabled }))
    receipt.userHookListed = JSON.stringify(hooks).includes('user-hook-ran')
    receipt.projectHookListed = JSON.stringify(hooks).includes('project-hook-ran')
    receipt.unexpectedExecution = existsSync(userHookRan) || existsSync(projectHookRan)
    receipt.verdict = receipt.userHookListed && receipt.projectHookListed && !receipt.unexpectedExecution ? 'PASS_INERT_HOOK_DISCOVERY'
      : !receipt.unexpectedExecution ? 'INCOMPLETE_DISCOVERY' : 'FAIL_HOOK_EXECUTED'
  }
} catch (error) {
  receipt.error = error instanceof Error ? error.message.replaceAll(evidenceDir, '<evidence>').replaceAll(privateDir, '<private>') : 'Unknown probe error'
} finally {
  receipt.finishedAt = new Date().toISOString()
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(evidenceDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
  }
}
if (receipt.verdict !== 'PASS_INERT_SKILL_DISCOVERY' && receipt.verdict !== 'PASS_INERT_HOOK_DISCOVERY') process.exitCode = 1
