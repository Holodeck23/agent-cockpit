// Shared by the page and the desktop shell: what a file name looks like, and whether opening it can run something.

/**
 * A file name as shown to you: characters that reorder or hide text (right-to-left overrides,
 * zero-width marks, controls) become visible as ⟨U+202E⟩. `Invoice-<U+202E>fdp.command` would
 * otherwise read as `Invoice-dnammoc.pdf`. Display only: the real name is still what is opened.
 */
export function visibleName(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g,
    (c) => `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`)
}

/** Types macOS runs, installs or follows when opened, rather than showing them in a viewer. */
const LAUNCHABLE = new Set(['app', 'command', 'tool', 'terminal', 'sh', 'bash', 'zsh', 'csh', 'ksh', 'fish', 'py', 'rb', 'pl', 'php', 'js', 'mjs', 'cjs',
  'workflow', 'action', 'jar', 'pkg', 'mpkg', 'dmg', 'webloc', 'inetloc', 'fileloc', 'url', 'scpt', 'scptd', 'applescript', 'osascript', 'prefpane',
  'qlgenerator', 'saver', 'kext', 'plugin', 'bundle', 'dylib', 'so', 'mobileconfig', 'shortcut', 'definition'])

/** Why opening this file needs your confirmation, or undefined when it is an ordinary document. */
export function launchReason(name: string, mode: number): string | undefined {
  const ext = /\.([^./]+)$/.exec(name)?.[1]?.toLowerCase()
  if (ext && LAUNCHABLE.has(ext)) return `a .${ext} file can run programs when it is opened`
  if ((mode & 0o111) !== 0) return 'it is marked executable, so opening it can run it'
  return undefined
}

const HIDING = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]+/g

/** Agent-chosen text on an approval card that must stay on one line (a title, a name): no newlines, nothing that reorders or hides text. */
export function oneLine(text: string): string {
  return text.replace(HIDING, ' ').replace(/\s+/g, ' ').trim()
}

/** Longer agent-chosen text (a command, a task): lines and tabs stay, characters that reorder or hide text become visible. */
export function revealHidden(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g,
    (c) => `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`)
}
