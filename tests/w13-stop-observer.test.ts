import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const callback = fileURLToPath(new URL('../scripts/fixtures/w13-stop-observer.cjs', import.meta.url))
it('records native input unchanged, rejects once through one callback and allows the others', () => {
  const root = mkdtempSync(join(tmpdir(), 'w13-stop-observer-'))
  const input = { session_id: 'session', hook_event_name: 'Stop', stop_hook_active: false }
  let status: unknown
  try { execFileSync(process.execPath, [callback, root, 'a'], { input: JSON.stringify(input), stdio: ['pipe', 'pipe', 'pipe'] }) }
  catch (error) { status = (error as { status: number }).status }
  expect(status).toBe(2)
  expect(execFileSync(process.execPath, [callback, root, 'b'], { input: JSON.stringify(input), encoding: 'utf8' })).toBe('{}\n')
  expect(execFileSync(process.execPath, [callback, root, 'a'], { input: JSON.stringify({ ...input, stop_hook_active: true }), encoding: 'utf8' })).toBe('{}\n')
  const rows = readFileSync(join(root, 'stop-observations-private.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  expect(rows.map((row) => row.label)).toEqual(['a', 'b', 'a'])
  expect(rows[0].input).toEqual(input)
  expect(rows[2].input.stop_hook_active).toBe(true)
})
it('refuses oversized input before recording any observation', () => {
  const root = mkdtempSync(join(tmpdir(), 'w13-stop-observer-'))
  expect(() => execFileSync(process.execPath, [callback, root, 'a'], { input: Buffer.alloc(300_000), stdio: ['pipe', 'pipe', 'pipe'] })).toThrow()
  expect(existsSync(join(root, 'stop-observations-private.jsonl'))).toBe(false)
})
