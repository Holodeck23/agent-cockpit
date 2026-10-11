// A released Cockpit refuses to start with a debugger attached. Otherwise an agent could quit
// Cockpit, relaunch it with --remote-debugging-port, and drive the window (and its API key)
// from outside. Proof builds (npm run package:proof) keep these flags: Playwright launches
// Electron with --inspect=0 --remote-debugging-port=0. The release fuses also switch off
// --inspect and NODE_OPTIONS in Node itself (scripts/release.ts).

const DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address', 'inspect', 'inspect-brk', 'inspect-port', 'inspect-wait', 'debug']

/** The command-line switches in `argv` that would let another program drive this app. */
export function debugSwitches(argv: readonly string[], hasSwitch: (name: string) => boolean = () => false): string[] {
  const found = argv.filter((arg) => {
    // Chromium accepts either dash prefix. Do not mistake a lookalike name for a switch.
    const name = /^--?([^=]+)(?:=|$)/.exec(arg)?.[1]
    return name !== undefined && DEBUG_SWITCHES.includes(name)
  })
  // Ask the actual parser too: a spelling accepted by Chromium must not evade our text check.
  for (const name of DEBUG_SWITCHES) if (hasSwitch(name) && !found.some((arg) => arg.replace(/^--?/, '').split('=')[0] === name)) found.push(`--${name}`)
  return found
}

/** Set at bundle time by `npm run package` and the release script, never at run time. */
export const IS_RELEASE_BUILD = process.env.COCKPIT_RELEASE_BUILD === '1'
