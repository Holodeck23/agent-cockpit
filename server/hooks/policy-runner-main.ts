// Entry point of the policy hook runner (see policy-runner.ts). Bundled to dist-electron/hook-runner.cjs and
// run by the app's own binary (ELECTRON_RUN_AS_NODE=1):
//   hook-runner --event <Event> --timeout-ms <n> -- <executable> [args...]
// Hook input arrives on stdin and is handed to the hook unchanged. Every path out of here is 0 or 2.
import { judge, POLICY_EVENTS, runHook } from './policy-runner.ts'

const fail = (why: string): never => {
  process.stderr.write(`Cockpit blocked this because its policy hook runner ${why}.\n`)
  process.exit(2)
}

const args = process.argv.slice(2)
const split = args.indexOf('--')
const flags = split < 0 ? args : args.slice(0, split)
const argv = split < 0 ? [] : args.slice(split + 1)
const flag = (name: string): string | undefined => { const at = flags.indexOf(name); return at < 0 ? undefined : flags[at + 1] }
const event = flag('--event') ?? ''
const timeoutMs = Number(flag('--timeout-ms'))
if (!POLICY_EVENTS.has(event)) fail(`was given an unknown event "${event}"`)
if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) fail('was given an invalid timeout')
if (argv.length === 0 || !argv[0]) fail('was given no hook to run')

const chunks: Buffer[] = []
process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
process.stdin.on('error', () => fail('could not read the hook input'))
process.stdin.on('end', () => {
  runHook(argv, Buffer.concat(chunks).toString('utf8'), timeoutMs)
    .then((outcome) => {
      const verdict = judge(event, outcome)
      if (verdict.stdout) process.stdout.write(verdict.stdout)
      if (verdict.stderr) process.stderr.write(verdict.stderr)
      // Exit once both streams have flushed; the hook's own descendants are not waited for.
      process.stdout.write('', () => process.stderr.write('', () => process.exit(verdict.code)))
    })
    .catch((error: unknown) => fail(`failed (${error instanceof Error ? error.message : String(error)})`))
})
