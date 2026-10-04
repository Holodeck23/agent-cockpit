// Which highlighter language a file uses, by its name. Kept apart from syntax.ts so the main
// bundle can ask without loading the highlighter.

const BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', plist: 'xml',
  md: 'markdown', markdown: 'markdown', py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml',
  toml: 'ini', ini: 'ini', diff: 'diff', patch: 'diff', graphql: 'graphql', gql: 'graphql', lua: 'lua', r: 'r', pl: 'perl',
}
const BY_NAME: Readonly<Record<string, string>> = { makefile: 'makefile', gnumakefile: 'makefile', '.zshrc': 'bash', '.bashrc': 'bash' }

/** The highlighter's language for a file, by its name; undefined for plain text and unknown kinds. */
export function languageFor(path: string): string | undefined {
  const name = (path.split('/').pop() ?? path).toLowerCase()
  if (BY_NAME[name]) return BY_NAME[name]
  const dot = name.lastIndexOf('.')
  return dot > 0 ? BY_EXTENSION[name.slice(dot + 1)] : undefined
}
