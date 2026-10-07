import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { installCrashGuard, LOG_LIMIT } from '../electron/crash-guard.ts'

// The main-process guard: an uncaught error is logged and Cockpit keeps running, instead of
// Electron's modal error dialog freezing the server, the window and the phone.

const setup = () => {
  const target = new EventEmitter()
  const file = join(mkdtempSync(join(tmpdir(), 'cockpit-crash-')), 'logs', 'main-errors.log')
  const log = installCrashGuard(target, file, () => new Date('2026-10-07T12:00:00Z'))
  return { target, file, log }
}

describe('main-process crash guard', () => {
  it('logs an uncaught exception with its stack and returns, so the process keeps running', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { target, file, log } = setup()
    const error = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    expect(() => target.emit('uncaughtException', error, 'uncaughtException')).not.toThrow()
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('2026-10-07T12:00:00.000Z uncaught exception')
    expect(text).toContain('Error: read ECONNRESET')
    expect(text).toMatch(/crash-guard\.test\.ts/)
    expect(log.count()).toBe(1)
    quiet.mockRestore()
  })

  it('logs unhandled rejections, including ones that are not Errors', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { target, file, log } = setup()
    target.emit('unhandledRejection', 'plain reason')
    target.emit('uncaughtException', new Error('from a promise'), 'unhandledRejection')
    const text = readFileSync(file, 'utf8')
    expect(text.match(/unhandled rejection/g)).toHaveLength(2)
    expect(text).toContain('plain reason')
    expect(log.count()).toBe(2)
    quiet.mockRestore()
  })

  it('moves a full log aside instead of growing without bound', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { target, file } = setup()
    target.emit('uncaughtException', new Error('first'), 'uncaughtException')
    writeFileSync(file, 'x'.repeat(LOG_LIMIT + 1))
    target.emit('uncaughtException', new Error('after the limit'), 'uncaughtException')
    expect(existsSync(`${file}.1`)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('after the limit')
    expect(readFileSync(file, 'utf8').length).toBeLessThan(10_000)
    quiet.mockRestore()
  })

  it('never throws itself, even when the log cannot be written', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const target = new EventEmitter()
    installCrashGuard(target, '/dev/null/cannot/main-errors.log')
    expect(() => target.emit('uncaughtException', new Error('still fine'), 'uncaughtException')).not.toThrow()
    quiet.mockRestore()
  })
})
