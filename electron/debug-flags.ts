// A released Cockpit refuses to start with a debugger attached. Otherwise an agent could quit
// Cockpit, relaunch it with --remote-debugging-port, and drive the window (and its API key)
// from outside. Proof builds (npm run package:proof) keep these flags: Playwright launches
// Electron with --inspect=0 --remote-debugging-port=0. The release fuses also switch off
// --inspect and NODE_OPTIONS in Node itself (scripts/release.ts).

const DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address', 'inspect', 'inspect-brk', 'inspect-port', 'inspect-wait', 'debug']

// Chromium's command line takes `-name` as well as `--name` for a switch, so both spellings count.
const DEBUG_SWITCH = new RegExp(`^--?(?:${DEBUG_SWITCHES.join('|')})(?:=|$)`)

/**
 * The command-line switches in `argv` that would let another program drive this app. `hasSwitch`
 * is the real parser (Electron's `app.commandLine.hasSwitch`): the text check above cannot be the
 * only guard, because a spelling Chromium accepts must not slip past a regular expression.
 */
export function debugSwitches(argv: readonly string[], hasSwitch: (name: string) => boolean = () => false): string[] {
  const found = argv.filter((arg) => DEBUG_SWITCH.test(arg))
  const named = new Set(found.map((arg) => arg.replace(/^--?/, '').split('=')[0]))
  return [...found, ...DEBUG_SWITCHES.filter((name) => !named.has(name) && hasSwitch(name)).map((name) => `--${name}`)]
}

/** Set at bundle time by `npm run package` and the release script, never at run time. */
export const IS_RELEASE_BUILD = process.env.COCKPIT_RELEASE_BUILD === '1'
