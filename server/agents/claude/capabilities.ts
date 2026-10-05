import { execFile } from 'node:child_process'
import { startErrorMessage } from '../start-error.ts'

export interface ClaudeCapabilities {
  readonly permissionPrompts: boolean
  /** --replay-user-messages: Claude says when it takes each message, so mid-turn messages can wait visibly (J1). */
  readonly replayUserMessages: boolean
  /** --prompt-suggestions: a predicted next prompt after each turn (J2). Server-gated: an account may get none. */
  readonly promptSuggestions: boolean
  /** --append-system-prompt-file (J5). 2.1.289 never declares it; it names it only in --bare's prose. */
  readonly appendSystemPromptFile: boolean
  /** --chrome: Claude in Chrome, for Use my Chrome (H4). */
  readonly chrome: boolean
  readonly options: ReadonlyMap<string, string>
}

/** Only option declarations count; prose mentioning an option is not support. */
export function parseClaudeHelp(help: string): ClaudeCapabilities {
  const options = new Map<string, string>()
  const declarations = [...help.matchAll(/^ {2}(?! )(?:-[A-Za-z], )?(--[\w-]+)(?:,\s*(--[\w-]+))?/gm)]
  for (let i = 0; i < declarations.length; i++) {
    const match = declarations[i]!
    const block = help.slice(match.index, declarations[i + 1]?.index ?? help.length)
    options.set(match[1]!, block)
    if (match[2]) options.set(match[2], block)
  }
  if (!options.has('--print') || !options.has('--permission-mode')) {
    throw new Error('Could not read Claude Code capabilities. Check that the selected claude executable is Claude Code, then retry. No agent turn was started.')
  }
  return {
    permissionPrompts: options.has('--permission-prompts'),
    replayUserMessages: options.has('--replay-user-messages'),
    promptSuggestions: options.has('--prompt-suggestions'),
    appendSystemPromptFile: options.has('--append-system-prompt-file') || help.includes('--append-system-prompt[-file]'),
    chrome: options.has('--chrome'),
    options,
  }
}

export function validateClaudeArgs(args: readonly string[], capabilities: ClaudeCapabilities): void {
  // This SDK option is hidden from --help in both tested CLI versions. Its
  // behavior is covered by the real Allow/Deny gate, not inferred from help.
  const hidden = '--permission-prompt-tool'
  const switches = new Set(['--print', '--verbose', '--include-partial-messages', '--strict-mcp-config', '--replay-user-messages', '--chrome'])
  for (let i = 0; i < args.length; i++) {
    const option = args[i]!
    const block = capabilities.options.get(option)
    const named = option === '--append-system-prompt-file' && capabilities.appendSystemPromptFile
    if (!block && option !== hidden && !named) throw incompatible(option)
    if (switches.has(option)) continue
    const value = args[++i]!
    if (['--permission-mode', '--effort', '--input-format', '--output-format', '--permission-prompts'].includes(option)) {
      const choices = block?.match(/\(choices:\s*([\s\S]*?)\)/)?.[1]
      const supported = choices ? [...choices.matchAll(/"([^"]+)"/g)].map((m) => m[1]) : []
      if (!supported.includes(value)) throw incompatible(`${option} ${value}`)
    }
  }
}

function incompatible(feature: string): Error {
  return new Error(`This Claude Code installation does not support ${feature}, which Cockpit needs for this conversation. Update the Claude Code executable used by Cockpit, then retry, or choose another agent. Your conversation has been kept; no agent turn was started.`)
}

/** No prompt, model call or success cache: an installed CLI can change between launches. */
export async function probeClaude(executable: string, cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<ClaudeCapabilities> {
  const help = await new Promise<string>((resolve, reject) => {
    execFile(executable, ['--help'], {
      cwd, env, signal, encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024, killSignal: 'SIGKILL',
    }, (error, stdout) => {
      if (!error) { resolve(stdout); return }
      if (error.code === 'ENOENT' || error.code === 'EACCES') {
        reject(new Error(startErrorMessage('claude', Object.assign(new Error(error.message), { code: error.code }))))
      } else {
        reject(new Error('Could not check Claude Code compatibility (the check failed, timed out, or returned too much output). Check the selected CLI in Terminal, then retry. No agent turn was started.'))
      }
    })
  })
  return parseClaudeHelp(help)
}
