import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// agy 1.3.1 hands an image request to its image-generator subagent, which saves the picture in the
// parent conversation's brain folder: ~/.gemini/antigravity-cli/brain/<conversation id>/<name>_<ms>.jpg
// (live run, 2026-10-09). The stream reports only the subagent step and a link in the reply, so the
// images a turn made are found in that folder when the turn ends.

const IMAGE = /\.(png|jpe?g|webp|gif)$/i
// agy's conversation ids are UUIDs; anything else is never joined into a path.
const CONVERSATION_ID = /^[A-Za-z0-9-]{1,64}$/

/** The brain folder of one agy conversation, or undefined for an id that is not a plain id. */
export function brainDir(home: string, conversationId: string): string | undefined {
  return CONVERSATION_ID.test(conversationId) ? join(home, '.gemini', 'antigravity-cli', 'brain', conversationId) : undefined
}

/** Image files directly in `dir` modified at or after `since`, oldest first, minus `seen`. No folder: none. */
export function newTurnImages(dir: string, since: number, seen: ReadonlySet<string>): string[] {
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  return names
    .filter((name) => IMAGE.test(name))
    .map((name) => join(dir, name))
    .filter((path) => !seen.has(path))
    .flatMap((path) => {
      try {
        const stat = statSync(path)
        return stat.isFile() && stat.mtimeMs >= since ? [{ path, at: stat.mtimeMs }] : []
      } catch {
        return []
      }
    })
    .sort((a, b) => a.at - b.at)
    .map((file) => file.path)
}
