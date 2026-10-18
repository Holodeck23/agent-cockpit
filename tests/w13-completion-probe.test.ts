import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ParentCompletionOracle, ProbeAttempt, ProbeOutput } from '../scripts/lib/w13-completion-probe.ts'

const callback = (cycle: string, hook: string, active = false, requestId = `${cycle}-${hook}`) => ({
  request_id: requestId, request: { subtype: 'hook_callback', callback_id: hook, tool_use_id: cycle,
    input: { hook_event_name: 'Stop', session_id: 'session', stop_hook_active: active } },
})
const result = { session_id: 'session', is_error: false, subtype: 'success' }

describe('native parent completion probe oracle', () => {
  it('counts two provider cycles with two callbacks each and rejects only once regardless of callback order', () => {
    const oracle = new ParentCompletionOracle('session')
    expect(oracle.callback(callback('c1', 'cycle-observer-b'))).toEqual({})
    expect(oracle.callback(callback('c1', 'cycle-observer-a'))).toMatchObject({ decision: 'block' })
    expect(oracle.callback(callback('c2', 'cycle-observer-a', true))).toEqual({})
    expect(oracle.callback(callback('c2', 'cycle-observer-b', true))).toEqual({})
    oracle.complete(result)
    expect(oracle.summary()).toEqual([{ ordinal: 1, callbacks: 2, correctionActive: false }, { ordinal: 2, callbacks: 2, correctionActive: true }])
  })
  it('does not accept four per-hook IDs as two completion cycles', () => {
    const oracle = new ParentCompletionOracle('session')
    oracle.callback(callback('individual-hook-1', 'cycle-observer-a'))
    expect(() => oracle.callback(callback('individual-hook-2', 'cycle-observer-b'))).toThrow()
    expect(() => oracle.complete(result)).toThrow()
  })
  it.each(['session', 'agent', 'cycle', 'active', 'hook', 'request'] as const)('rejects invalid %s bindings', (field) => {
    const oracle = new ParentCompletionOracle('session'), message = callback('c1', 'cycle-observer-a')
    if (field === 'session') message.request.input.session_id = 'other'
    if (field === 'agent') message.request.input.hook_event_name = 'SubagentStop'
    if (field === 'cycle') message.request.tool_use_id = ''
    if (field === 'active') message.request.input.stop_hook_active = true
    if (field === 'hook') message.request.callback_id = 'unknown'
    if (field === 'request') message.request_id = ''
    expect(() => oracle.callback(message)).toThrow()
  })
  it('rejects replays, duplicate callbacks, excess correction cycles and early/error results', () => {
    const oracle = new ParentCompletionOracle('session'), first = callback('c1', 'cycle-observer-a')
    oracle.callback(first)
    expect(() => oracle.callback(first)).toThrow()
    expect(() => oracle.callback(callback('c1', 'cycle-observer-a', false, 'new-request'))).toThrow()
    expect(() => oracle.complete(result)).toThrow()
    oracle.callback(callback('c1', 'cycle-observer-b'))
    oracle.callback(callback('c2', 'cycle-observer-a', true))
    oracle.callback(callback('c2', 'cycle-observer-b', true))
    expect(() => oracle.callback(callback('c3', 'cycle-observer-a', true))).toThrow()
    expect(() => oracle.complete({ ...result, is_error: true })).toThrow()
    expect(() => oracle.complete({ ...result, session_id: 'other' })).toThrow()
  })
})

describe('probe evidence preservation', () => {
  it('does not alter an earlier attempt when its evidence directory already exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'cycle-probe-')), evidence = join(root, 'evidence'), priv = join(root, 'private')
    mkdirSync(evidence); writeFileSync(join(evidence, 'receipt.json'), 'old failure')
    const attempt = new ProbeAttempt(evidence, priv)
    expect(() => attempt.create()).toThrow()
    attempt.writeReceipt({ verdict: 'new' }); attempt.writePrivate('error.txt', 'new')
    expect(readFileSync(join(evidence, 'receipt.json'), 'utf8')).toBe('old failure')
    expect(existsSync(priv)).toBe(false)
  })
  it('preserves early failure in its owned evidence directory without touching an existing private attempt', () => {
    const root = mkdtempSync(join(tmpdir(), 'cycle-probe-')), evidence = join(root, 'evidence'), priv = join(root, 'private')
    mkdirSync(priv); writeFileSync(join(priv, 'error.txt'), 'original')
    const attempt = new ProbeAttempt(evidence, priv)
    expect(() => attempt.create()).toThrow()
    attempt.writeReceipt({ verdict: 'BLOCKED' }); attempt.writePrivate('error.txt', 'new')
    expect(readFileSync(join(priv, 'error.txt'), 'utf8')).toBe('original')
    expect(JSON.parse(readFileSync(join(evidence, 'receipt.json'), 'utf8')).verdict).toBe('BLOCKED')
  })
  it('uses private modes and exclusive writes even within an owned attempt', () => {
    const root = mkdtempSync(join(tmpdir(), 'cycle-probe-')), attempt = new ProbeAttempt(join(root, 'evidence'), join(root, 'private'))
    attempt.create(); attempt.writePrivate('error.txt', 'first'); attempt.writeReceipt({ verdict: 'BLOCKED' })
    expect(() => attempt.writePrivate('error.txt', 'second')).toThrow()
    expect(() => attempt.writeReceipt({ verdict: 'PASS' })).toThrow()
    expect(statSync(attempt.privateDir).mode & 0o777).toBe(0o700)
    expect(statSync(join(attempt.privateDir, 'error.txt')).mode & 0o777).toBe(0o600)
  })
  it('counts multibyte raw stdout and stderr together, and fails instead of dropping the oracle', () => {
    const output = new ProbeOutput(5)
    output.append('stdout', Buffer.from('é'))
    output.append('stderr', Buffer.from('abc'))
    expect(output.bytes).toBe(5)
    expect(() => output.append('stdout', Buffer.from('x'))).toThrow(/byte limit/)
    expect(output.overflow).toBe(true)
    expect(output.snapshot().toString()).toBe('stdout: éstderr: abc')
  })
})
