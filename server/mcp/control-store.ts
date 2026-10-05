import { createHash } from 'node:crypto'
import { writeFileAtomic } from '../files/atomic.ts'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

const operation = z.object({ hash: z.string(), state: z.enum(['pending', 'executing', 'done', 'failed']), result: z.object({ id: z.string(), status: z.string() }).optional(), error: z.string().optional() })
export type ControlOperation = z.infer<typeof operation>
/** One file per request. Reserved before approval; interrupted actions never replay after restart. */
export function createControlStore(root: string) {
  const dir = join(root, 'conversation-actions')
  const key = (caller: string, request: string) => createHash('sha256').update(`${caller}\n${request}`).digest('hex')
  const file = (key: string) => join(dir, `${key}.json`)
  return {
    key,
    hash: (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    read(key: string): ControlOperation | undefined {
      if (!existsSync(file(key))) return undefined
      try { return operation.parse(JSON.parse(readFileSync(file(key), 'utf8'))) }
      catch { throw new Error('Conversation action record is unreadable; preserve it and repair it before retrying this request') }
    },
    write(key: string, value: ControlOperation) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      writeFileAtomic(file(key), JSON.stringify(operation.parse(value)))
    },
  }
}
