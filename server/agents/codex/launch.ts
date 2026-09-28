import { spawn } from 'node:child_process'
import { z } from 'zod'
import { EFFORTS, PERMISSION_MODES } from '../claude/flags.ts'
import type { AgentSession, ApprovalBehavior, EventSink, PendingApproval } from '../types.ts'
import { parseCodexNotification } from './parse.ts'
import { createRpcClient, type ServerRequest } from './rpc.ts'

export const codexLaunchSchema = z.object({
  cwd: z.string().min(1),
  model: z
    .string()
    .max(100)
    .regex(/^[A-Za-z0-9._\-[\]]+$/)
    .optional(),
  effort: z.enum(EFFORTS).optional(),
  permissionMode: z.enum(PERMISSION_MODES).default('manual'),
  /** Codex thread id to resume; absent means start a new thread. */
  resume: z.string().min(1).max(200).optional(),
  /** Seed context for a brand-new thread (used when switching agents). */
  developerInstructions: z.string().max(100_000).optional(),
})
export type CodexLaunchInput = z.input<typeof codexLaunchSchema>

type Policy = { approvalPolicy: 'on-request' | 'never'; sandbox: 'read-only' | 'workspace-write' | 'danger-full-access' }

/** Cockpit permission modes mapped onto Codex's approval policy + sandbox. */
export function codexPolicy(mode: (typeof PERMISSION_MODES)[number]): Policy {
  switch (mode) {
    case 'plan':
      return { approvalPolicy: 'on-request', sandbox: 'read-only' }
    case 'auto':
    case 'dontAsk':
      return { approvalPolicy: 'never', sandbox: 'workspace-write' }
    case 'bypassPermissions':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' }
    default:
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' }
  }
}

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'execCommandApproval',
  'applyPatchApproval',
])

function describeApproval(request: ServerRequest): { toolName: string; input: unknown; description?: string } {
  const params = (request.params ?? {}) as Record<string, unknown>
  const isFile = request.method.includes('fileChange') || request.method === 'applyPatchApproval'
  return {
    toolName: isFile ? 'Edit' : 'Shell',
    input: isFile ? { file_path: params.grantRoot ?? params.reason ?? 'file change' } : { command: params.command },
    description: typeof params.reason === 'string' ? params.reason : undefined,
  }
}

export function launchCodex(input: CodexLaunchInput, onEvent: EventSink): AgentSession {
  const opts = codexLaunchSchema.parse(input)
  const child = spawn('codex', ['app-server'], { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
  let exited = false
  let threadId: string | undefined
  let currentTurnId: string | undefined
  const queued: string[] = []
  // Approval request id (as a string) -> JSON-RPC id to reply to.
  const approvalIds = new Map<string, number | string>()

  const rpc = createRpcClient(child, {
    onNotification(method, params) {
      if (method === 'turn/started') {
        const turn = (params as { turn?: { id?: string } } | undefined)?.turn
        currentTurnId = turn?.id
      }
      if (method === 'turn/completed') currentTurnId = undefined
      for (const event of parseCodexNotification(method, params)) onEvent(event)
    },
    onServerRequest(request) {
      if (!APPROVAL_METHODS.has(request.method)) {
        // Unsupported interactive requests are declined rather than left hanging.
        rpc.respond(request.id, { decision: 'decline' })
        return
      }
      const requestId = String(request.id)
      approvalIds.set(requestId, request.id)
      onEvent({ kind: 'approval_request', requestId, suggestions: ['acceptForSession'], ...describeApproval(request) })
    },
    onProtocolError(message) {
      onEvent({ kind: 'error', message })
    },
  })

  const startTurn = (text: string): void => {
    if (!threadId) {
      queued.push(text)
      return
    }
    rpc
      .request('turn/start', {
        threadId,
        input: [{ type: 'text', text, text_elements: [] }],
        ...(opts.effort ? { effort: opts.effort } : {}),
      })
      .catch((error: unknown) => onEvent({ kind: 'error', message: error instanceof Error ? error.message : String(error) }))
  }

  const policy = codexPolicy(opts.permissionMode)
  void (async () => {
    try {
      await rpc.request('initialize', { clientInfo: { name: 'agent-cockpit', title: 'Agent Cockpit', version: '0.1.0' }, capabilities: null })
      rpc.notify('initialized')
      const common = { cwd: opts.cwd, ...policy, ...(opts.model ? { model: opts.model } : {}) }
      const response = opts.resume
        ? await rpc.request<{ thread: { id: string } }>('thread/resume', { threadId: opts.resume, ...common })
        : await rpc.request<{ thread: { id: string } }>('thread/start', {
            ...common,
            ...(opts.developerInstructions ? { developerInstructions: opts.developerInstructions } : {}),
          })
      threadId = response.thread.id
      if (opts.resume) onEvent({ kind: 'session', sessionId: threadId })
      for (const text of queued.splice(0)) startTurn(text)
    } catch (error: unknown) {
      onEvent({ kind: 'error', message: `Codex failed to start: ${error instanceof Error ? error.message : String(error)}` })
      onEvent({ kind: 'result', ok: false })
      child.stdin.end()
    }
  })()

  child.on('error', (error) => {
    exited = true
    onEvent({ kind: 'error', message: `Could not start codex: ${error.message}` })
  })
  child.on('exit', (code) => {
    exited = true
    onEvent({ kind: 'exit', code })
  })

  return {
    agent: 'codex',
    send(text) {
      onEvent({ kind: 'user_text', text })
      startTurn(text)
    },
    respondApproval(approval: PendingApproval, behavior: ApprovalBehavior) {
      const rpcId = approvalIds.get(approval.requestId)
      if (rpcId === undefined) return
      approvalIds.delete(approval.requestId)
      const decision = behavior === 'deny' ? 'decline' : behavior === 'allow_session' ? 'acceptForSession' : 'accept'
      rpc.respond(rpcId, { decision })
      onEvent({ kind: 'approval_resolved', requestId: approval.requestId, behavior })
    },
    interrupt() {
      if (threadId && currentTurnId) {
        rpc.request('turn/interrupt', { threadId, turnId: currentTurnId }).catch(() => undefined)
      }
    },
    close() {
      if (!exited) child.stdin.end()
    },
    alive: () => !exited,
  }
}
