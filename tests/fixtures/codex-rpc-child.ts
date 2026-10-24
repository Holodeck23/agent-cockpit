import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

type Request = { id?: number; method: string; params?: any }
type Reply = ((id: number | undefined, result: unknown) => void) & {
  notify(method: string, params: unknown): void
  fail(id: number | undefined, message: string): void
}
const fixtures = new Map<string, (request: Request, reply: Reply, env?: NodeJS.ProcessEnv) => void>()
export function registerCodexRpcFixture(command: string, handler: (request: Request, reply: Reply, env?: NodeJS.ProcessEnv) => void) {
  fixtures.set(command, handler)
}
export function clearCodexRpcFixtures() { fixtures.clear() }

// Keep real newline JSON-RPC framing while separating protocol race tests from
// OS scheduling of a fresh Node process. Stock-process effects have native proofs.
export function spawnCodexRpcFixture(command: string, env?: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams | undefined {
  const handler = fixtures.get(command)
  if (!handler) return undefined
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
  let buffer = '', closed = false
  child.stdin.on('data', bytes => {
    buffer += bytes.toString()
    let end: number
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      const request = JSON.parse(line) as Request
      const reply: Reply = Object.assign((id: number | undefined, result: unknown) => {
        if (!closed && id !== undefined) child.stdout.push(JSON.stringify({ id, result }) + '\n')
      }, { notify(method: string, params: unknown) {
        if (!closed) child.stdout.push(JSON.stringify({ method, params }) + '\n')
      }, fail(id: number | undefined, message: string) {
        if (!closed) child.stdout.push(JSON.stringify({ id, error: { message } }) + '\n')
      } })
      queueMicrotask(() => { if (!closed) handler(request, reply, env) })
    }
  })
  child.stdin.on('finish', () => {
    closed = true
    queueMicrotask(() => { child.stdout.push(null); child.emit('exit', 0); child.emit('close', 0) })
  })
  return child
}
