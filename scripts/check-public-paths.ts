// This repository is public. Fails if any tracked text file contains an absolute home-directory
// path (/Users/<name>/… or /home/<name>/…), which exposes a maintainer's account name and folder
// layout. Placeholder homes used by tests and docs are allowed. Runs in `npm run verify` and CI,
// so it applies to every tool and person that commits here. Usage: npm run check:paths
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const HOME_PATH = /\/(?:Users|home)\/([A-Za-z0-9_][A-Za-z0-9._-]*)/g
const PLACEHOLDERS = new Set(['me', 'you', 'someone', 'dev', 'example', 'user', 'username', 'name'])

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
const hits: string[] = []
for (const file of files) {
  let text: string
  try { text = readFileSync(file, 'utf8') } catch { continue }
  if (text.includes('\0')) continue // binary
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(HOME_PATH)) {
      if (!PLACEHOLDERS.has(match[1]!.toLowerCase())) hits.push(`${file}:${index + 1}: ${match[0]}`)
    }
  })
}

if (hits.length > 0) {
  console.error(`check:paths found ${hits.length} absolute home path(s) in tracked files:`)
  for (const hit of hits) console.error(`  ${hit}`)
  console.error('Replace them with a relative path or a neutral description before committing.')
  process.exit(1)
}
console.log(`check:paths: ${files.length} tracked files, no home-directory paths`)
