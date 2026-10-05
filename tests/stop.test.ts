import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { AGENT_SPAWN, stopChild } from '../server/agents/stop.ts'

function run(script: string): { child: ChildProcess; alive: () => boolean } {
  const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'ignore', 'ignore'] })
  let exited = false
  child.on('exit', () => (exited = true))
  return { child, alive: () => !exited }
}

// Give the child time to install its handlers before we start stopping it.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300))

describe('stopChild', () => {
  it('lets a well-behaved agent exit on stdin EOF', async () => {
    const { child, alive } = run("process.stdin.resume(); process.stdin.on('end', () => process.exit(0))")
    await settle()
    const started = Date.now()
    await stopChild(child, alive, 1000)
    expect(alive()).toBe(false)
    expect(child.signalCode).toBeNull()
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('sends SIGTERM to an agent that ignores EOF (e.g. mid-turn)', async () => {
    const { child, alive } = run('process.stdin.resume(); setInterval(() => {}, 1000)')
    await settle()
    await stopChild(child, alive, 200)
    expect(alive()).toBe(false)
    expect(child.signalCode).toBe('SIGTERM')
  })

  it('sends SIGKILL to an agent that also ignores SIGTERM', async () => {
    const { child, alive } = run("process.on('SIGTERM', () => {}); process.stdin.resume(); setInterval(() => {}, 1000)")
    await settle()
    await stopChild(child, alive, 200)
    expect(alive()).toBe(false)
    expect(child.signalCode).toBe('SIGKILL')
  })

  it('resolves at once for a process that already exited', async () => {
    const { child, alive } = run('process.exit(0)')
    await new Promise((resolve) => child.once('exit', resolve))
    await expect(stopChild(child, alive)).resolves.toBeUndefined()
  })

  it('takes the commands an agent started with it when the agent has to be killed (M4)', async () => {
    // An agent that ignores EOF and SIGTERM, with a shell command of its own that does too.
    const script = "const { spawn } = require('node:child_process');" +
      "const c = spawn('/bin/sh', ['-c', 'trap \"\" TERM; while :; do sleep 1; done'], { stdio: 'ignore' }); console.log(c.pid);" +
      "process.on('SIGTERM', () => {}); process.stdin.resume(); setInterval(() => {}, 1000)"
    const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'ignore'], ...AGENT_SPAWN })
    let exited = false
    child.on('exit', () => (exited = true))
    const grandchild = await new Promise<number>((resolve) => child.stdout!.once('data', (d: Buffer) => resolve(Number(String(d).trim()))))
    expect(running(grandchild)).toBe(true)
    await stopChild(child, () => !exited, 200)
    expect(child.signalCode).toBe('SIGKILL')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(running(grandchild)).toBe(false)
  })
})

/** Exists and is not a zombie (a container without an init that reaps leaves those behind). */
function running(pid: number): boolean {
  try { return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z') } catch { return false }
}
