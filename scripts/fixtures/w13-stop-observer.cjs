// Reviewed inert Stop callback. No tools, subprocesses, downloads or credential access.
const fs = require('node:fs')
const path = require('node:path')
process.umask(0o077)
const [root, label] = process.argv.slice(2)
if (!root || !path.isAbsolute(root) || !['a', 'b'].includes(label)) process.exit(1)
const chunks = [], buffer = Buffer.alloc(8192)
let total = 0, size
while ((size = fs.readSync(0, buffer)) > 0) {
  total += size
  if (total > 256 * 1024) process.exit(1)
  chunks.push(Buffer.from(buffer.subarray(0, size)))
}
const bytes = Buffer.concat(chunks)
const input = JSON.parse(bytes.toString('utf8'))
fs.appendFileSync(path.join(root, 'stop-observations-private.jsonl'), JSON.stringify({ label, pid: process.pid, input }) + '\n', { mode: 0o600 })
if (label === 'a') {
  try {
    fs.writeFileSync(path.join(root, 'first-rejection-private'), 'Synthetic first completion rejected\n', { flag: 'wx', mode: 0o600 })
    process.stderr.write('Synthetic Stop check: respond with READY once more.\n')
    process.exit(2)
  } catch (error) { if (error.code !== 'EEXIST') throw error }
}
process.stdout.write('{}\n')
