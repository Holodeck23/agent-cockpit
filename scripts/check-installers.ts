// Re-reviews the official installers before a release. Fetches each one the way Cockpit does
// (vendor's own HTTPS host, size cap) and compares its sha256 with the one this release pins in
// server/agents/lifecycle/plans.ts. Exits 1 on any drift and prints the new hash, so a release
// never ships a pin that would send every stranger to "Install this version anyway".
// Usage: npm run check:installers (also a step in scripts/release.ts, after verify)
import { createHash } from 'node:crypto'
import { INSTALLERS } from '../server/agents/lifecycle/plans.ts'
import { fetchInstaller } from '../server/agents/lifecycle/service.ts'

let drift = 0
for (const [agent, spec] of Object.entries(INSTALLERS)) {
  if (!spec) continue
  try {
    const sha = createHash('sha256').update(await fetchInstaller(spec.url, spec.hosts)).digest('hex')
    if (sha === spec.sha256) { console.log(`ok     ${agent}  ${spec.url}  ${sha}`); continue }
    drift++
    console.log(`DRIFT  ${agent}  ${spec.url}\n       pinned ${spec.sha256}\n       now    ${sha}`)
  } catch (error) {
    drift++
    console.log(`FAIL   ${agent}  ${spec.url}  ${error instanceof Error ? error.message : String(error)}`)
  }
}
if (drift) {
  console.log(`\ncheck:installers: ${drift} installer(s) differ from the pinned review. Read the new script, then update INSTALLERS in server/agents/lifecycle/plans.ts.`)
  process.exit(1)
}
console.log('\ncheck:installers: every official installer matches its pinned review')
