import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { stopChild } from '../stop.ts'
import type { AgentSession, ApprovalBehavior, EventSink, PendingApproval } from '../types.ts'
import { buildClaudeArgs, type ClaudeLaunchInput } from './flags.ts'
import { parseClaudeLine } from './parse.ts'

export interface ClaudeLaunchDeps {
  /** Override for tests or a non-PATH install. */
  executable?: string
  /** Added to the agent's environment (and so inherited by its MCP servers). */
  env?: Readonly<Record<string, string>>
}

/**
 * Starts one long-lived `claude -p` process in stream-json mode. The process
 * stays alive across turns; each `send` is a new user message on stdin.
 */
export function launchClaude(input: ClaudeLaunchInput, onEvent: EventSink, deps: ClaudeLaunchDeps = {}): AgentSession {
  const args = buildClaudeArgs(input)
  const child = spawn(deps.executable ?? 'claude', args, {
    cwd: input.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...deps.env },
  })
  let exited = false
  const stderrTail: string[] = []

  const write = (message: unknown): void => {
    if (exited || !child.stdin.writable) {
      onEvent({ kind: 'error', message: 'Agent process is not running' })
      return
    }
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  createInterface({ input: child.stdout }).on('line', (line) => {
    for (const event of parseClaudeLine(line)) onEvent(event)
  })
  createInterface({ input: child.stderr }).on('line', (line) => {
    stderrTail.push(line)
    if (stderrTail.length > 20) stderrTail.shift()
  })
  child.on('error', (error) => {
    exited = true
    onEvent({ kind: 'error', message: `Could not start claude: ${error.message}` })
  })
  child.on('exit', (code) => {
    exited = true
    if (code !== 0 && code !== null && stderrTail.length > 0) {
      onEvent({ kind: 'error', message: stderrTail.join('\n') })
    }
    onEvent({ kind: 'exit', code })
  })

  return {
    agent: 'claude',
    send(text: string) {
      write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
    },
    respondApproval(approval: PendingApproval, behavior: ApprovalBehavior) {
      // updatedInput must echo the original input: an empty object would replace it.
      const response =
        behavior === 'deny'
          ? { behavior: 'deny', message: 'Denied from Agent Cockpit' }
          : {
              behavior: 'allow',
              updatedInput: approval.input,
              ...(behavior === 'allow_session' ? { updatedPermissions: approval.suggestions } : {}),
            }
      write({ type: 'control_response', response: { subtype: 'success', request_id: approval.requestId, response } })
      onEvent({ kind: 'approval_resolved', requestId: approval.requestId, behavior })
    },
    interrupt() {
      write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } })
    },
    close: () => stopChild(child, () => !exited),
    alive: () => !exited,
  }
}
