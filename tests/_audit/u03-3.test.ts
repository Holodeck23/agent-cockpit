import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { launchAntigravity } from '../../server/agents/antigravity/launch.ts'
import type { NormalizedEvent } from '../../server/agents/types.ts'

// u03-3: agy does not implement queues(), so the thread manager writes a message sent while a turn is
// running straight to agy's stdin. send() resets turnStartedAt, so an image the running turn's
// image-generator saved BEFORE that second send falls outside the (turnStartedAt - 1000) window at the
// turn's result, and is never shown.
//
// Stand-in agy: init, then on the FIRST user line it saves an image, on the SECOND user line (sent
// mid-turn) it ends the turn with a single result.
const STAND_IN = `#!/bin/sh
brain="$HOME/.gemini/antigravity-cli/brain/c-1"
printf '%s\\n' '{"event":"init","conversation_id":"c-1","init":{"model":"m","cwd":"/p"}}'
read -r _first
mkdir -p "$brain"
printf 'img' > "$brain/img_1.jpg"
read -r _second
printf '%s\\n' '{"event":"result","result":{"conversation_id":"c-1","status":"SUCCESS","response":"saved img_1.jpg"}}'
read -r _rest
`

const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

describe('Antigravity image generated before a mid-turn send', () => {
  it('is still shown when the turn ends', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-u03-3-'))
    roots.push(dir)
    const executable = join(dir, 'agy')
    writeFileSync(executable, STAND_IN)
    chmodSync(executable, 0o755)

    const events: NormalizedEvent[] = []
    let results = 0
    const session = launchAntigravity({ cwd: dir }, (event) => { events.push(event); if (event.kind === 'result') results++ }, { executable, env: { HOME: dir } })
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
    const until = async (done: () => boolean, ms = 10_000): Promise<void> => {
      const started = Date.now()
      while (!done() && Date.now() - started < ms) await sleep(25)
    }
    const image = join(dir, '.gemini', 'antigravity-cli', 'brain', 'c-1', 'img_1.jpg')

    session.send('Draw an apple')
    await until(() => existsSync(image))
    expect(existsSync(image)).toBe(true)
    // Past the one second of slack in the adapter: the turn is still running, the user adds to it.
    await sleep(1_500)
    session.send('make it red')
    await until(() => results >= 1)
    await session.close()

    expect(results).toBe(1)
    const shown = events.filter((e) => e.kind === 'image_data').map((e) => e.kind === 'image_data' ? e.source : undefined)
    // CORRECT behaviour: the image saved during this turn is surfaced at its result.
    expect(shown).toEqual([{ path: image }])
  }, 20_000)
})
