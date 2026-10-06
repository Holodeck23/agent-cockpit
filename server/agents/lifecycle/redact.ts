// Installer, updater and sign-in output is shown and kept in a log, so anything shaped like a
// credential or an account address is removed first (W10-06). What the user types is never logged.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g
const PATTERNS: readonly [RegExp, string][] = [
  [/\b(sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{20,})/g, '<secret>'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<secret>'],
  [/("?(?:access|refresh|id)_token"?\s*[:=]\s*"?)[^\s",}]+/gi, '$1<secret>'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>'],
]

export function redactSecrets(text: string): string {
  let out = text.replace(ANSI, '')
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement)
  return out
}
