import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createProcessRunner, type ProcessRunner } from '../../server/processes/runner.ts'

// u11-1: a dev command forks a helper that leaves the process group (setsid) and keeps the
// inherited stdout/stderr pipes open. stop() kills the group, but the child's 'close' event never
// fires, so the entry stays 'stopping'. restart() must still give back a NEW, running process.

let runner: ProcessRunner | undefined
let dir = ''

const helperPids = (): number[] => {
  const file = join(dir, 'helpers.txt')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number)
}

async function until<T>(read: () => T | undefined | false, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined && value !== false) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('timed out')
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterEach(async () => {
  await runner?.shutdown()
  runner = undefined
  for (const pid of helperPids()) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
})

describe('u11-1: restart() with a daemon that holds the output pipes open', () => {
  it('starts a new running process instead of returning the old stopping one', async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-audit-u11-1-')))
    // The helper is spawned detached (own session, so the group kill cannot reach it) and inherits
    // stdout/stderr, exactly like a daemonising watcher. It exits on its own after 20s as a safety net.
    writeFileSync(join(dir, 'dev.js'), [
      "const { spawn } = require('node:child_process')",
      "const { appendFileSync } = require('node:fs')",
      "const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] })",
      "appendFileSync('helpers.txt', helper.pid + '\\n')",
      'helper.unref()',
      'setInterval(() => {}, 1000)',
    ].join('\n'))
    const command = `"${process.execPath}" dev.js`

    runner = createProcessRunner({ graceMs: 200 })
    const first = runner.start({ projectPath: dir, command, name: 'dev' }).process
    await until(() => helperPids().length >= 1)

    const second = await runner.restart(first.id)

    // Precondition that makes this the pipe-holding scenario: the original group is gone, the helper is not.
    expect(alive(first.pid!)).toBe(false)
    expect(alive(helperPids()[0]!)).toBe(true)

    // Correct behaviour: a different process, actually running, with its own PID.
    expect(second.status).toBe('running')
    expect(second.id).not.toBe(first.id)
    expect(second.pid).not.toBe(first.pid)
  })
})
