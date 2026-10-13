import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { developmentRoot } from '../server/development.ts'
import { AGENT_SPAWN, stopChild } from '../server/agents/stop.ts'
import { createThreadStore } from '../server/threads/store.ts'

describe('development preview state', () => {
  it('is stable per real checkout, separate from the desktop profile and other checkouts', () => {
    const checkout = mkdtempSync(join(tmpdir(), 'cockpit-dev-checkout-'))
    const other = mkdtempSync(join(tmpdir(), 'cockpit-dev-other-'))
    const home = mkdtempSync(join(tmpdir(), 'cockpit-dev-home-'))
    const alias = join(home, 'alias')
    symlinkSync(checkout, alias)
    const env = { COCKPIT_HOME: join(home, 'desktop') }
    const root = developmentRoot(checkout, env, home)
    expect(root).not.toBe(env.COCKPIT_HOME)
    expect(root).toBe(developmentRoot(alias, env, home))
    expect(root).not.toBe(developmentRoot(other, env, home))
    expect(developmentRoot(checkout, { ...env, COCKPIT_DEV_HOME: './explicit' }, home)).toBe(join(checkout, 'explicit'))
    expect(() => developmentRoot(checkout, { COCKPIT_HOME: checkout, COCKPIT_DEV_HOME: alias }, home)).toThrow('separate state')
  })

  it('starts the real development entry point without interrupting an inherited parent run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-dev-parent-'))
    const dev = mkdtempSync(join(tmpdir(), 'cockpit-dev-child-'))
    const store = createThreadStore(root)
    const id = randomUUID()
    const stamp = new Date().toISOString()
    store.create({ id, projectPath: process.cwd(), title: 'Parent still working', createdAt: stamp, updatedAt: stamp,
      sessionId: randomUUID(), sessionStarted: true,
      completed: false, settings: { agent: 'codex', permissionMode: 'manual', useHooks: false } })
    store.append(id, { kind: 'user_text', text: 'Keep working', runId: randomUUID() })
    const events = join(root, 'threads', id, 'events.jsonl')
    const before = readFileSync(events, 'utf8')
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts', '--development'], {
      cwd: process.cwd(), env: { ...process.env, COCKPIT_HOME: root, COCKPIT_DEV_HOME: dev, COCKPIT_PORT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'], ...AGENT_SPAWN,
    })
    let alive = true
    child.once('exit', () => { alive = false })
    let output = ''
    child.stdout.on('data', (data: Buffer) => { output += String(data) })
    child.stderr.on('data', (data: Buffer) => { output += String(data) })
    try {
      await expect.poll(() => output.includes('[cockpit] http://127.0.0.1:'), { timeout: 10_000 }).toBe(true)
      expect(output).toContain(`(threads in ${dev})`)
      expect(output).not.toContain('unfinished run(s)')
      expect(readFileSync(events, 'utf8')).toBe(before)
    } finally {
      await stopChild(child, () => alive)
    }
  }, 15_000)
})
