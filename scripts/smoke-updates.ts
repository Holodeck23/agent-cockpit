// Live check of Check for Updates against the real GitHub release feed (no app, no install):
// an older version is offered the newest prerelease, whose DMG URL resolves to a file of the
// advertised size; the newest version is up to date. Usage: npm run smoke:updates
import { createUpdateChecker, UPDATE_CHANNEL } from '../electron/updates.ts'

const checker = createUpdateChecker({ fetch })
const failures: string[] = []
const check = (ok: boolean, label: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) failures.push(label)
}

const older = await checker.check('0.1.0', UPDATE_CHANNEL)
check(older.state === 'available', `0.1.0 is offered an update (got ${older.state})`)
if (older.state === 'available') {
  const { update } = older
  console.log(`     latest ${update.version} · ${update.assetName} · ${update.size} bytes · ${update.downloadUrl}`)
  const head = await fetch(update.downloadUrl, { method: 'HEAD', redirect: 'follow' })
  check(head.ok, `download URL resolves (HTTP ${head.status})`)
  check(Number(head.headers.get('content-length')) === update.size, `downloaded size matches the release asset (${head.headers.get('content-length')})`)

  const newest = await checker.check(update.version, UPDATE_CHANNEL)
  check(newest.state === 'up-to-date', `${update.version} is up to date (got ${newest.state})`)
  const stable = await checker.check('0.1.0', 'stable')
  console.log(`     stable channel from 0.1.0: ${stable.state}`)
}

if (failures.length > 0) {
  console.error(`smoke:updates FAILED (${failures.length})`)
  process.exit(1)
}
console.log('smoke:updates passed')
