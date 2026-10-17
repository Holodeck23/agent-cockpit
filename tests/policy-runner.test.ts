import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { judge, policyHookCommand } from '../server/hooks/policy-runner.ts'

// W13 U3c: a Claude hook on an event that can block must deny when it fails, hangs, crashes or answers
// with something unknown. Natively those all let the action through.

const exit = (code: number, stdout = '', stderr = '') => ({ kind: 'exit' as const, code, stdout, stderr })

describe('judge', () => {
  it('passes a hook’s own answers through: silence, plain text, its own block, a valid decision', () => {
    expect(judge('PreToolUse', exit(0))).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(judge('UserPromptSubmit', exit(0, 'Current time: noon\n'))).toEqual({ code: 0, stdout: 'Current time: noon\n', stderr: '' })
    expect(judge('PreToolUse', exit(2, '', 'Not in that folder\n'))).toEqual({ code: 2, stdout: '', stderr: 'Not in that folder\n' })
    const deny = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } })
    expect(judge('PreToolUse', exit(0, deny))).toMatchObject({ code: 0, stdout: deny })
    expect(judge('Stop', exit(0, '{"decision":"block","reason":"write the mirror"}')).code).toBe(0)
    expect(judge('PermissionRequest', exit(0, '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}')).code).toBe(0)
    expect(judge('UserPromptSubmit', exit(0, '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"x"},"suppressOutput":true}')).code).toBe(0)
  })

  it('blocks on failure, timeout, a signal, or a hook that could not run', () => {
    for (const outcome of [exit(1), exit(127), { kind: 'timeout' as const, ms: 5000 }, { kind: 'signal' as const, signal: 'SIGKILL' },
      { kind: 'error' as const, message: 'ENOENT' }]) {
      const verdict = judge('PreToolUse', outcome)
      expect(verdict.code).toBe(2)
      expect(verdict.stderr).toMatch(/^Cockpit blocked this because a policy hook /)
    }
    expect(judge('PreToolUse', { kind: 'timeout', ms: 5000 }).stderr).toContain('did not answer within 5 seconds')
  })

  it('blocks an answer Claude would not act on as intended', () => {
    const blocked = (event: string, stdout: string) => judge(event, exit(0, stdout)).code
    expect(blocked('PreToolUse', '{"hookSpecificOutput":{"permissionDecision":"deny"')).toBe(2)
    expect(blocked('PreToolUse', '[]')).toBe(2)
    expect(blocked('PreToolUse', '{"hookSpecificOutput":{"permissionDecision":"maybe"}}')).toBe(2)
    expect(blocked('PreToolUse', '{"hookSpecificOutput":{"hookEventName":"Stop","permissionDecision":"deny"}}')).toBe(2)
    expect(blocked('Stop', '{"decision":"approve"}')).toBe(2)
    expect(blocked('UserPromptSubmit', '{"hookSpecificOutput":{"permissionDecision":"allow"}}')).toBe(2)
    expect(blocked('PermissionRequest', '{"hookSpecificOutput":{"decision":{"behavior":"sure"}}}')).toBe(2)
    expect(blocked('Stop', '{"continue":"no"}')).toBe(2)
  })
})

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RUNNER = { command: process.execPath, args: [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), join(ROOT, 'server/hooks/policy-runner-main.ts')] }

function hook(body: string): { dir: string; script: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-policy-runner-'))
  const script = join(dir, 'hook.sh')
  writeFileSync(script, `#!/bin/sh\n${body}\n`); chmodSync(script, 0o755)
  return { dir, script }
}
/** Runs the command Claude would run for a PreToolUse hook, through /bin/sh as Claude does. */
const viaClaude = (argv: readonly string[], timeoutMs = 3000, input = '{"tool_name":"Write"}') =>
  spawnSync('/bin/sh', ['-c', policyHookCommand(RUNNER, 'PreToolUse', timeoutMs, argv)], { input, encoding: 'utf8', timeout: 30_000 })

describe('the runner as Claude runs it', () => {
  it('hands the hook its input and passes its answer through', () => {
    const { script } = hook('cat >/dev/null; echo \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}\'')
    const run = viaClaude([script])
    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    const echo = hook('cat')
    expect(viaClaude([echo.script], 3000, '{"tool_name":"Bash","x":1}').stdout).toBe('{"tool_name":"Bash","x":1}')
  }, 30_000)

  it('turns a failing hook and the hook’s own block into exit 2', () => {
    const failing = viaClaude([hook('exit 1').script])
    expect(failing.status).toBe(2)
    expect(failing.stderr).toContain('failed with exit code 1')
    const own = viaClaude([hook('echo "outside the project" >&2; exit 2').script])
    expect(own.status).toBe(2)
    expect(own.stderr).toBe('outside the project\n')
  }, 30_000)

  it('blocks a hung hook at its timeout and ends its whole process group', () => {
    const { dir, script } = hook(`(sleep 2; touch "${'$'}0.late") & sleep 10; touch "${'$'}0.done"`)
    const started = Date.now()
    const run = viaClaude([script], 500)
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('did not answer within 500 ms')
    expect(Date.now() - started).toBeLessThan(8000)
    spawnSync('/bin/sleep', ['2.5'])
    expect(existsSync(join(dir, 'hook.sh.late'))).toBe(false)
    expect(existsSync(join(dir, 'hook.sh.done'))).toBe(false)
  }, 30_000)

  it('blocks when the runner itself cannot start or is given nothing to run', () => {
    const missing = spawnSync('/bin/sh', ['-c', policyHookCommand({ command: '/nonexistent/Cockpit', args: [] }, 'PreToolUse', 1000, ['/bin/true'])],
      { input: '{}', encoding: 'utf8' })
    expect(missing.status).toBe(2)
    expect(viaClaude(['/nonexistent/hook']).status).toBe(2)
    const bad = spawnSync(RUNNER.command, [...RUNNER.args, '--event', 'PostToolUse', '--timeout-ms', '1000', '--', '/bin/true'], { input: '{}', encoding: 'utf8' })
    expect(bad.status).toBe(2)
    expect(bad.stderr).toContain('unknown event')
  }, 30_000)
})
