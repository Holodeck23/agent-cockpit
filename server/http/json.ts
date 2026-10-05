import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'

// Request/response plumbing shared by every API route.

const MAX_BODY_BYTES = 1_000_000

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

// A body this many times over its limit is not drained: the connection is cut instead.
const DRAIN_FACTOR = 8

/**
 * `maxBytes` is raised only by routes that carry images. Over the limit it rejects with 413 at
 * once but keeps reading (and dropping) the rest, so the answer goes out on a healthy connection:
 * leaving a `for await` early destroys the request and its socket mid-upload, and the client's
 * next request on that keep-alive connection hung (seen on Linux CI).
 */
export function readJson(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (over) {
        if (size > maxBytes * DRAIN_FACTOR) req.destroy()
        return
      }
      if (size > maxBytes) {
        over = true
        chunks.length = 0
        reject(new HttpError(413, 'Request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('error', (error) => { if (!over) reject(error) })
    req.on('end', () => {
      if (over) return
      if (chunks.length === 0) { resolve({}); return }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new HttpError(400, 'Body is not valid JSON'))
      }
    })
  })
}

export function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new HttpError(400, z.prettifyError(result.error))
  return result.data
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
