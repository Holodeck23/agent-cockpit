// Read-only dry run of the library scanner (projects-area Move 2). Not part of the app.
// Usage: npx tsx scripts/scan-libraries.ts <root>[:private] ... [--json]
// Prints counts and timing per library; --json prints the full scan (keep it out of the repo: it holds real folder names).
import { scanLibrary, scanPaths, type Library } from '../server/projects/libraries.ts'

const args = process.argv.slice(2)
const json = args.includes('--json')
const libraries: Library[] = args.filter((a) => a !== '--json').map((a) => (a.endsWith(':private') ? { root: a.slice(0, -8), private: true } : { root: a }))
if (libraries.length === 0) { console.error('Usage: npx tsx scripts/scan-libraries.ts <root>[:private] ... [--json]'); process.exit(2) }

const all: unknown[] = []
const seen = new Map<string, string>()
let duplicates = 0
for (const library of libraries) {
  const started = performance.now()
  const scan = scanLibrary(library, libraries.map((l) => l.root).filter((r) => r !== library.root))
  const ms = Math.round(performance.now() - started)
  const paths = scanPaths(scan)
  for (const p of paths) { if (seen.has(p)) duplicates += 1; else seen.set(p, library.root) }
  console.log(`${library.root}: ${scan.areas.length} areas, ${paths.length} projects, ${ms} ms${scan.truncated ? ', TRUNCATED' : ''}`)
  all.push(scan)
}
console.log(`paths listed in more than one library: ${duplicates}`)
if (json) console.log(JSON.stringify(all, null, 2))
