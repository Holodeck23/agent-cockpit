import { spawn, type ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { stopChild } from '../server/agents/stop.ts'

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
})
