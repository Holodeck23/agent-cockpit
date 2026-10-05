import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createOutputBuffer, detectLocalUrl, stripAnsi } from '../server/processes/output.ts'
import { createProcessRunner, type ProcessInfo, type ProcessRunner } from '../server/processes/runner.ts'

const project = (): string => mkdtempSync(join(tmpdir(), 'cockpit-proc-'))

/** Writes a node script into the project and returns the shell command that runs it. */
function script(dir: string, name: string, source: string): string {
  writeFileSync(join(dir, name), source)
  return `"${process.execPath}" ${name}`
}

async function until<T>(read: () => T | undefined, ms = 5000): Promise<T> {
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
  } catch {
    return false
  }
  // A killed process whose parent is gone stays a zombie until init reaps it, which a container
  // without an init never does. A zombie runs nothing and holds no port: it counts as gone.
  try {
    return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim().startsWith('Z')
  } catch {
    return false
  }
}

describe('output buffer', () => {
  it('splits chunks into numbered lines across partial writes and streams', () => {
    const buffer = createOutputBuffer()
    expect(buffer.push('stdout', 'hel')).toEqual([])
    buffer.push('stderr', 'warn\n')
    buffer.push('stdout', 'lo\nwor')
    buffer.flush()
    expect(buffer.read().lines).toEqual([
      { seq: 1, stream: 'stderr', text: 'warn' },
      { seq: 2, stream: 'stdout', text: 'hello' },
      { seq: 3, stream: 'stdout', text: 'wor' },
    ])
  })

  it('reads incrementally with since, and the last N with tail', () => {
    const buffer = createOutputBuffer()
    buffer.push('stdout', 'a\nb\nc\nd\n')
    expect(buffer.read({ since: 2 }).lines.map((l) => l.text)).toEqual(['c', 'd'])
    expect(buffer.read({ tail: 1 }).lines.map((l) => l.text)).toEqual(['d'])
    expect(buffer.read().next).toBe(4)
    expect(buffer.read({ since: 4 }).lines).toEqual([])
  })

  it('drops the oldest lines past the byte cap and counts them', () => {
    const buffer = createOutputBuffer(20)
    buffer.push('stdout', '12345\n12345\n12345\n12345\n')
    const slice = buffer.read()
    expect(slice.dropped).toBe(1)
    expect(slice.lines.map((l) => l.seq)).toEqual([2, 3, 4])
  })

  it('strips colour codes and keeps only the last carriage-return frame', () => {
    expect(stripAnsi('\u001b[32m➜\u001b[39m  Local:')).toBe('➜  Local:')
    const buffer = createOutputBuffer()
    buffer.push('stdout', '10%\r50%\r100%\r\n')
    expect(buffer.read().lines[0]?.text).toBe('100%')
  })

  it('detects the local URL a dev server prints', () => {
    expect(detectLocalUrl('  ➜  Local:   http://localhost:5173/')).toBe('http://localhost:5173/')
    expect(detectLocalUrl('listening on http://0.0.0.0:3000.')).toBe('http://localhost:3000')
    expect(detectLocalUrl('Server at http://127.0.0.1:8080/app, ready')).toBe('http://127.0.0.1:8080/app')
    expect(detectLocalUrl('docs at https://vite.dev/guide')).toBeUndefined()
  })
})

describe('process runner', () => {
  let runner: ProcessRunner | undefined
  afterEach(async () => {
    await runner?.shutdown()
    runner = undefined
  })

  it('captures stdout and stderr, records the URL and the exit code', async () => {
    runner = createProcessRunner()
    const dir = project()
    const command = script(dir, 'dev.js', "console.log('Local: http://localhost:4999/'); console.error('oops'); process.exit(3)")
    const { process: started, reused } = runner.start({ projectPath: dir, command })
    expect(reused).toBe(false)
    expect(started.status).toBe('running')
    const done = await until(() => (runner?.get(started.id)?.status === 'exited' ? runner.get(started.id) : undefined))
    expect(done).toMatchObject({ exitCode: 3, url: 'http://localhost:4999/', name: command })
    const read = runner.read(started.id)
    expect(read.lines.map((l) => [l.stream, l.text])).toEqual(
      expect.arrayContaining([
        ['stdout', 'Local: http://localhost:4999/'],
        ['stderr', 'oops'],
      ]),
    )
  })

  it('stops the whole process group, including forked children', async () => {
    runner = createProcessRunner({ graceMs: 500 })
    const dir = project()
    const command = script(
      dir,
      'fork.js',
      `const { spawn } = require('node:child_process')
       const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
       console.log('child ' + kid.pid)
       setInterval(() => {}, 1000)`,
    )
    const { process: started } = runner.start({ projectPath: dir, command })
    const line = await until(() => runner?.read(started.id).lines.find((l) => l.text.startsWith('child ')))
    const grandchild = Number(line.text.split(' ')[1])
    expect(alive(grandchild)).toBe(true)
    const stopped = await runner.stop(started.id)
    expect(stopped.status).toBe('exited')
    expect(alive(grandchild)).toBe(false)
  })

  it('escalates to SIGKILL when the group ignores SIGTERM', async () => {
    runner = createProcessRunner({ graceMs: 200 })
    const dir = project()
    const command = `exec ${script(dir, 'stubborn.js', "process.on('SIGTERM', () => {}); console.log('up'); setInterval(() => {}, 1000)")}`
    const { process: started } = runner.start({ projectPath: dir, command })
    await until(() => runner?.read(started.id).lines.find((l) => l.text === 'up'))
    const stopped = await runner.stop(started.id)
    expect(stopped.signal).toBe('SIGKILL')
  })

  it('reuses a running process with the same name and command, and keeps an exited one as finished history', async () => {
    runner = createProcessRunner()
    const dir = project()
    const long = script(dir, 'long.js', 'setInterval(() => {}, 1000)')
    const first = runner.start({ projectPath: dir, command: long, name: 'dev' })
    expect(runner.start({ projectPath: dir, command: long, name: 'dev' })).toMatchObject({ reused: true, process: { id: first.process.id } })
    await runner.stop(first.process.id)
    const again = runner.start({ projectPath: dir, command: long, name: 'dev' })
    expect(again.reused).toBe(false)
    expect(runner.list(dir).map((p: ProcessInfo) => [p.id, p.status])).toEqual([[again.process.id, 'running'], [first.process.id, 'exited']])
  })

  it('restarts a running process as a new one with the same command and name, and an exited one too', async () => {
    runner = createProcessRunner()
    const dir = project()
    const long = script(dir, 'long.js', 'setInterval(() => {}, 1000)')
    const first = runner.start({ projectPath: dir, command: long, name: 'dev' }).process
    const second = await runner.restart(first.id)
    expect(second).toMatchObject({ name: 'dev', command: long, status: 'running' })
    expect(second.id).not.toBe(first.id)
    expect(alive(first.pid!)).toBe(false)
    expect(runner.list(dir).filter((p: ProcessInfo) => p.status !== 'exited').map((p) => p.id)).toEqual([second.id])
    await runner.stop(second.id)
    const third = await runner.restart(second.id)
    expect(third.status).toBe('running')
    await expect(runner.restart('proc-nope')).rejects.toThrow('No process with id proc-nope')
  })

  it('rejects a project path that is not a folder, and unknown ids', () => {
    runner = createProcessRunner()
    expect(() => runner?.start({ projectPath: join(project(), 'missing'), command: 'true' })).toThrow(/Not a folder/)
    expect(() => runner?.read('proc-999')).toThrow(/No process/)
  })

  it('announces status changes to subscribers', async () => {
    runner = createProcessRunner()
    const dir = project()
    const seen: string[] = []
    runner.subscribe((info) => seen.push(info.status))
    const { process: started } = runner.start({ projectPath: dir, command: script(dir, 'quick.js', 'process.exit(0)') })
    await until(() => runner?.get(started.id)?.status === 'exited' || undefined)
    expect(seen[0]).toBe('running')
    expect(seen.at(-1)).toBe('exited')
  })
})
