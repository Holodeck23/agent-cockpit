// A released Cockpit refuses to start with a debugger attached. Otherwise an agent could quit
// Cockpit, relaunch it with --remote-debugging-port, and drive the window (and its API key)
// from outside. Proof builds (npm run package:proof) keep these flags: Playwright launches
// Electron with --inspect=0 --remote-debugging-port=0. The release fuses also switch off
// --inspect and NODE_OPTIONS in Node itself (scripts/release.ts).

const DEBUG_SWITCHES = ['--remote-debugging-port', '--remote-debugging-pipe', '--remote-debugging-address', '--inspect', '--inspect-brk', '--inspect-port', '--inspect-wait', '--debug']

/** The command-line switches in `argv` that would let another program drive this app. */
export function debugSwitches(argv: readonly string[]): string[] {
  return argv.filter((arg) => DEBUG_SWITCHES.some((name) => arg === name || arg.startsWith(`${name}=`)))
}

/** Set at bundle time by `npm run package` and the release script, never at run time. */
export const IS_RELEASE_BUILD = process.env.COCKPIT_RELEASE_BUILD === '1'
