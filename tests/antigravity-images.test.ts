import { chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { brainDir, newTurnImages } from '../server/agents/antigravity/images.ts'
import { launchAntigravity } from '../server/agents/antigravity/launch.ts'
import type { NormalizedEvent } from '../server/agents/types.ts'

// Like agy 1.3.1 asked for an image (live run, 2026-10-09): its image-generator subagent saves the
// picture in the conversation's brain folder under $HOME, and the stream carries only text and a result.
const STAND_IN = `#!/bin/sh
brain="$HOME/.gemini/antigravity-cli/brain/c-1"
printf '%s\\n' '{"event":"init","conversation_id":"c-1","init":{"model":"m","cwd":"/p"}}'
while read -r _line; do
  n=$((n + 1))
  mkdir -p "$brain"
  printf 'img' > "$brain/apple_$n.jpg"
  printf 'notes' > "$brain/notes_$n.md"
  printf '%s\\n' '{"event":"result","result":{"conversation_id":"c-1","status":"SUCCESS","response":"saved"}}'
done
`

function standIn(): { dir: string; executable: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agy-images-'))
  const executable = join(dir, 'agy')
  writeFileSync(executable, STAND_IN)
  chmodSync(executable, 0o755)
  return { dir, executable }
}

describe('newTurnImages', () => {
  it('lists only image files modified since the turn began, oldest first, minus those already shown', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-brain-'))
    const since = Date.now() - 5_000
    const old = join(dir, 'old.png')
    writeFileSync(old, 'x')
    utimesSync(old, new Date(since - 60_000), new Date(since - 60_000))
    const first = join(dir, 'first.jpg')
    writeFileSync(first, 'x')
    utimesSync(first, new Date(since + 1_000), new Date(since + 1_000))
    const second = join(dir, 'second.PNG')
    writeFileSync(second, 'x')
    writeFileSync(join(dir, 'plan.md'), 'x')
    mkdirSync(join(dir, 'folder.png'))
    expect(newTurnImages(dir, since, new Set())).toEqual([first, second])
    expect(newTurnImages(dir, since, new Set([first]))).toEqual([second])
  })

  it('finds nothing in a folder that does not exist', () => {
    expect(newTurnImages(join(tmpdir(), 'no-such-agy-brain'), 0, new Set())).toEqual([])
  })
})

describe('brainDir', () => {
  it('joins only a plain conversation id into a path', () => {
    expect(brainDir('/h', '9ac06146-c477-464f-970b-53125d7546b4')).toBe('/h/.gemini/antigravity-cli/brain/9ac06146-c477-464f-970b-53125d7546b4')
    expect(brainDir('/h', '../../etc')).toBeUndefined()
    expect(brainDir('/h', 'a/b')).toBeUndefined()
    expect(brainDir('/h', '')).toBeUndefined()
  })
})

describe('An Antigravity turn that made an image', () => {
  it('shows the image before the turn ends, once, and not again on the next turn', async () => {
    const { dir, executable } = standIn()
    const events: NormalizedEvent[] = []
    let results = 0
    const session = launchAntigravity({ cwd: dir }, (event) => { events.push(event); if (event.kind === 'result') results++ }, { executable, env: { HOME: dir } })
    const waitFor = async (n: number): Promise<void> => {
      const started = Date.now()
      while (results < n && Date.now() - started < 10_000) await new Promise((r) => setTimeout(r, 25))
    }
    session.send('Draw an apple')
    await waitFor(1)
    session.send('Draw another')
    await waitFor(2)
    await session.close()
    const brain = join(dir, '.gemini', 'antigravity-cli', 'brain', 'c-1')
    const shown = events.filter((e) => e.kind === 'image_data' || e.kind === 'result').map((e) => e.kind === 'image_data' ? e.source : e.kind)
    expect(shown).toEqual([{ path: join(brain, 'apple_1.jpg') }, 'result', { path: join(brain, 'apple_2.jpg') }, 'result'])
  }, 15_000)
})
