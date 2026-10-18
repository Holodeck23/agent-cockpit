// Synthetic native Stop batch fixture. No child commands, tools, account data or network.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
process.umask(0o077)
const [root] = process.argv.slice(2)
let lock
const stopped = { continue: false, stopReason: 'W13 synthetic completion remains blocked.' }
let response = stopped
try {
  if (!root || !path.isAbsolute(root) || fs.realpathSync(root) !== root) throw new Error('Invalid fixture root')
  const expected = JSON.parse(fs.readFileSync(path.join(root, 'expected-binding-private.json'), 'utf8'))
  const chunks = [], buffer = Buffer.alloc(8192)
  let total = 0, size
  while ((size = fs.readSync(0, buffer)) > 0) {
    total += size
    if (total > 256 * 1024) throw new Error('Input bound exceeded')
    chunks.push(Buffer.from(buffer.subarray(0, size)))
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (input.hook_event_name !== 'Stop' || input.session_id !== expected.sessionId
    || input.turn_id !== expected.turnId || typeof input.stop_hook_active !== 'boolean') throw new Error('Native binding mismatch')
  lock = fs.openSync(path.join(root, 'batch.active'), 'wx', 0o600)
  const cycles = path.join(root, 'cycles')
  const names = fs.readdirSync(cycles).sort()
  if (names.length > 1 || names.some((name, i) => name !== String(i + 1)
    || !fs.existsSync(path.join(cycles, name, 'decision-private.json')))) throw new Error('Prior batch incomplete or exhausted')
  for (const name of names) {
    const prior = JSON.parse(fs.readFileSync(path.join(cycles, name, 'decision-private.json'), 'utf8'))
    const started = JSON.parse(fs.readFileSync(path.join(cycles, name, 'start-private.json'), 'utf8'))
    if (prior.ordinal !== 1 || prior.disposition !== 'one-correction' || prior.cycleId !== started.cycleId
      || started.sessionId !== expected.sessionId || started.turnId !== expected.turnId
      || prior.checks.length !== 2 || prior.checks.some((check, i) => check.cycleId !== prior.cycleId
        || check.hookId !== ['a', 'b'][i] || check.outcome !== 'reject')) throw new Error('Invalid prior batch')
  }
  const ordinal = names.length + 1
  if (input.stop_hook_active !== (ordinal === 2)) throw new Error('Unexpected correction flag')
  const cycleId = crypto.randomUUID(), cycleDir = path.join(cycles, String(ordinal))
  fs.mkdirSync(cycleDir, { mode: 0o700 })
  const syncDir = (dir) => { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) } }
  const persist = (file, value) => {
    const fd = fs.openSync(path.join(cycleDir, file), 'wx', 0o600)
    try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    syncDir(cycleDir)
  }
  syncDir(cycles)
  persist('start-private.json', { cycleId, ordinal, sessionId: expected.sessionId, turnId: expected.turnId,
    stopHookActive: input.stop_hook_active, invocationPid: process.pid, input })
  // Both reviewed synthetic checks reject: one batch counts once, regardless of hook count.
  const checks = ['a', 'b'].map((hookId) => ({ cycleId, hookId, outcome: 'reject' }))
  persist('decision-private.json', { cycleId, ordinal, checks,
    disposition: ordinal === 1 ? 'one-correction' : 'block' })
  if (ordinal === 1) response = { decision: 'block', reason: 'W13 synthetic batch: respond READY once more.' }
} catch {
  // Native exit-1 hooks may fail open: return the documented Stop shape even on fixture failure.
  response = stopped
} finally {
  try { if (lock !== undefined) { fs.closeSync(lock); fs.unlinkSync(path.join(root, 'batch.active')) } }
  catch { response = stopped }
}
process.stdout.write(JSON.stringify(response) + '\n')
