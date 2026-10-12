// Clears what builds and test runs leave behind. Part of the build (scripts/release.ts runs it
// before packaging and after success); safe to run by hand.
//
//   npm run clean                 remove, print each thing and the bytes freed
//   npm run clean -- --dry-run    list what would go; remove nothing
//   npm run clean -- --all        also list every temp entry (default: the first 25)
//
// Rules and the never-touched list: scripts/lib/clean.ts and docs/BUILD-NOTES.md.
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clean, formatReport, listPublishedVersions, listRunningCommands } from './lib/clean.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const args = process.argv.slice(2)
const unknown = args.filter((arg) => !['--dry-run', '--all'].includes(arg))
if (unknown.length) {
  console.error(`clean: unknown option ${unknown.join(' ')}\nusage: npm run clean [-- --dry-run] [--all]`)
  process.exit(2)
}

const currentVersion = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
const tempDir = tmpdir()
const result = clean({
  repoRoot: ROOT,
  tempDir,
  currentVersion,
  publishedVersions: listPublishedVersions(ROOT),
  runningCommands: listRunningCommands(),
  keep: process.env.TMPDIR ? [process.env.TMPDIR] : [],
  dryRun: args.includes('--dry-run'),
})
const limit = args.includes('--all') ? Number.MAX_SAFE_INTEGER : 25
for (const line of formatReport(result, { repoRoot: ROOT, tempDir, limit })) console.log(line)
