import { createHostActions, type HostActionOptions } from './host-actions.ts'
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { launchAntigravity } from '../agents/antigravity/launch.ts'
import type { AgentCapabilities } from '../agents/capabilities/types.ts'
import type { CapabilityService } from '../agents/capabilities/service.ts'
import { launchOpencode } from '../agents/opencode/launch.ts'
import { launchClaude } from '../agents/claude/launch.ts'
import { launchCodex } from '../agents/codex/launch.ts'
import { claudeMcpOptions, codexMcpConfigArgs } from '../mcp/wiring.ts'
import { effortForClaude } from '../agents/claude/flags.ts'
import { COCKPIT_GUIDANCE, MCP_SERVER_NAME, type CockpitMcpLaunch, type McpGrant } from '../mcp/sessions.ts'
import { handoffDigest, previewHandoff, workspaceContext, type HandoffPreview } from './handoff.ts'
import type { Workspace } from '../projects/workspaces.ts'
import { isRefusal, workspaceFolder } from '../projects/resolve.ts'
import { redactBrowserEvent } from '../browser/agent-policy.ts'
import type { AccountRef, AgentId, AgentSession, ApprovalBehavior, EventSink, NormalizedEvent, OutgoingImage, PendingApproval, WorkflowSnapshot } from '../agents/types.ts'
import { defaultAccountId, type ResolvedAccount } from '../agents/accounts/types.ts'
import { deriveStatus, latestTurn, messageCountOf, openQuestion, previewOf } from './status.ts'
import { attribute, partition } from './workspace-events.ts'
import { awaitingOf } from './turns.ts'
import type { ThreadStore } from './store.ts'
import { createImageStore, MAX_ATTACHED_IMAGE_BYTES, type ImageStore } from './images.ts'
import { bindingIdOf, inputHash, unfinishedRun } from './identity.ts'
import type { ThreadMeta, ThreadSettings, ThreadStatus, ThreadSummary } from './types.ts'

export interface LaunchRequest {
  readonly cwd: string
  readonly settings: ThreadSettings
  readonly sessionId?: string
  readonly resume?: string
  /** Context for a fresh session after an agent switch. */
  readonly seed?: string
  /** The cockpit MCP server to attach to this session, if the host provides one. */
  readonly cockpit?: CockpitMcpLaunch
  /** The project's own instructions, as set in Cockpit. */
  readonly projectInstructions?: string
  /** Where this conversation's images are kept, for agents that read them as files. */
  readonly imagesDir?: string
  /** Selects the account (W12.1): CLAUDE_CONFIG_DIR or CODEX_HOME for a profile, nothing for the CLI default. */
  readonly accountEnv?: Readonly<Record<string, string>>
}
export type Launcher = (request: LaunchRequest, onEvent: EventSink) => AgentSession

/** An image you attach to a message: its bytes as sent, and the name it had, if any. */
export interface IncomingImage {
  readonly bytes: Buffer
  readonly name?: string
}

export interface ThreadUpdate {
  readonly threadId: string
  readonly event: NormalizedEvent
  readonly status: ThreadStatus
  /** The workspace whose session it came from, when it came from one (W12-15). */
  readonly workspaceId?: string
}
export type UpdateListener = (update: ThreadUpdate) => void

const IDLE_CLOSE_MS = 5 * 60_000

/** Wraps a project's instructions so the agent knows where they came from and what they cannot do. */
export function projectInstructionsBlock(text: string): string {
  return `Project instructions, set by the user in Cockpit for this folder. Follow them alongside the repository's own instructions; they do not change your permissions.\n<project-instructions>\n${text}\n</project-instructions>`
}

/** Cockpit guidance first (only when its tools are attached), then project instructions, then any handoff seed. */
/** Events that inform without being activity: they never reorder the list or mark it unread. */
const QUIET = new Set<NormalizedEvent['kind']>(['awaiting_dismissed', 'branch_changed', 'settings_changed', 'suggestion', 'account_changed', 'workspace_changed'])

export const instructionsFor = (req: LaunchRequest): string | undefined =>
  [
    req.cockpit ? COCKPIT_GUIDANCE : undefined,
    req.projectInstructions ? projectInstructionsBlock(req.projectInstructions) : undefined,
    req.seed,
  ].filter(Boolean).join('\n\n') || undefined

/**
 * Claude Code's own background updater stays off in sessions Cockpit starts (launch-scoped, no
 * settings write), so Cockpit's idle-only update decides when the executable changes (W10-07).
 */
export const claudeLaunchEnv = (env: Readonly<Record<string, string>> | undefined): Record<string, string> => ({ ...env, DISABLE_AUTOUPDATER: '1' })

export const defaultLaunchers: Record<AgentId, Launcher> = {
  claude: (req, onEvent) => {
    const mcp = req.cockpit ? claudeMcpOptions(req.cockpit) : undefined
    return launchClaude(
      {
        cwd: req.cwd,
        model: req.settings.model,
        effort: effortForClaude(req.settings.effort),
        permissionMode: req.settings.permissionMode,
        useHooks: req.settings.useHooks,
        chrome: req.settings.useChrome === true,
        sessionId: req.sessionId,
        resume: req.resume,
        appendSystemPrompt: instructionsFor(req),
        ...(mcp ? { mcpConfig: mcp.mcpConfig, allowedTools: mcp.allowedTools } : {}),
      },
      onEvent,
      { env: claudeLaunchEnv({ ...mcp?.env, ...req.accountEnv }) },
    )
  },
  codex: (req, onEvent) =>
    launchCodex(
      {
        cwd: req.cwd,
        model: req.settings.model,
        effort: req.settings.effort,
        permissionMode: req.settings.permissionMode,
        resume: req.resume,
        developerInstructions: instructionsFor(req),
      },
      onEvent,
      {
        ...(req.cockpit ? { configArgs: codexMcpConfigArgs(req.cockpit) } : {}),
        ...(req.cockpit || req.accountEnv ? { env: { ...req.cockpit?.secretEnv, ...req.accountEnv } } : {}),
      },
    ),
  antigravity: antigravityLauncher(),
  opencode: (req, onEvent) =>
    launchOpencode(
      {
        cwd: req.cwd,
        model: req.settings.model,
        permissionMode: req.settings.permissionMode,
        resume: req.resume,
        instructions: instructionsFor(req),
        // The token travels in the MCP server's environment (sent over stdio), never in arguments.
        ...(req.cockpit ? { mcp: { server: { name: MCP_SERVER_NAME, command: req.cockpit.command, args: req.cockpit.args,
          env: { ...req.cockpit.env, ...req.cockpit.secretEnv } }, env: req.cockpit.secretEnv } } : {}),
      },
      onEvent,
    ),
}

/** Whether Antigravity may get Cockpit's tools in a folder (P3), checked as a session starts. */
export type AntigravityMcpPrepare = (projectPath: string) => { readonly ready: boolean; readonly reason?: string }

/**
 * With a capability check, agy is validated and resolved just before it starts (W10-01/02).
 * Cockpit's tools, their guidance and the session token reach agy only in a project that opted in
 * (P3): the token through agy's environment, which the project's Cockpit plugin server inherits.
 */
export function antigravityLauncher(check?: () => Promise<AgentCapabilities>, prepareMcp?: AntigravityMcpPrepare): Launcher {
  return (req, onEvent) => {
    const mcp = req.cockpit && prepareMcp ? prepareMcp(req.cwd) : undefined
    if (mcp?.reason) console.warn('[cockpit] Antigravity starts without Cockpit tools:', mcp.reason)
    const cockpit = mcp?.ready ? req.cockpit : undefined
    return launchAntigravity({
      cwd: req.cwd,
      model: req.settings.model,
      effort: effortForClaude(req.settings.effort),
      permissionMode: req.settings.permissionMode,
      resume: req.resume,
      instructions: instructionsFor({ ...req, cockpit }),
      ...(req.imagesDir ? { imagesDir: req.imagesDir } : {}),
    }, onEvent, { ...(check ? { check } : {}), ...(cockpit ? { env: cockpit.secretEnv } : {}) })
  }
}

/** Issues a session's cockpit MCP launch; `release` revokes its token when the session ends. */
export type McpProvider = (grant: McpGrant) => { readonly launch: CockpitMcpLaunch; release(): void }

/** Current instructions for a project folder, read when an agent session starts. */
export type InstructionsProvider = (projectPath: string) => { readonly text: string; readonly revision: number } | undefined

export interface ManagerOptions {
  readonly launchers?: Partial<Record<AgentId, Launcher>>
  readonly mcp?: McpProvider
  readonly instructions?: InstructionsProvider
  /** Where conversation images are kept; defaults to the store's own state folder. */
  readonly images?: ImageStore
  /** The opaque primary workspace for a project folder (G-IDENTITY); undefined when it cannot be resolved. */
  readonly workspaceFor?: (projectPath: string) => string | undefined
  /** Capability records, checked just before an agent that needs it starts (W10.1). */
  readonly capabilities?: CapabilityService
  /** P3: Antigravity gets Cockpit's tools only where the project opted in. */
  readonly antigravityMcp?: AntigravityMcpPrepare
  /** Why a new session on an agent must not start now (its CLI is being updated or installed). */
  readonly launchGate?: (agent: AgentId) => string | undefined
  /** The account each launch runs under (W12.1); without it every session uses the CLI default. */
  readonly accounts?: AccountBinding
  /** A registered workspace by ID (M1); without it every session runs in the conversation's project folder. */
  readonly workspace?: (workspaceId: string) => Workspace | undefined
}

/** What the thread manager needs from the account service. */
export interface AccountBinding {
  /** The project's current choice for the agent, read at every launch. */
  resolve(projectPath: string, agent: AgentId): ResolvedAccount
  /** How a recorded account is named in the conversation; undefined once it is gone. */
  describe(accountId: string): AccountRef | undefined
}

/** A session that never starts: the reason is shown and the turn ends at once. */
function refusedSession(agent: AgentId, reason: string, onEvent: EventSink): AgentSession {
  onEvent({ kind: 'error', message: reason })
  onEvent({ kind: 'result', ok: false })
  onEvent({ kind: 'exit', code: null })
  return { agent, send: () => undefined, respondApproval: () => undefined, interrupt: () => undefined, close: () => Promise.resolve(), alive: () => false }
}

interface Live {
  /** The conversation and workspace this session belongs to ('' when the project has no workspace record). */
  readonly threadId: string
  readonly workspaceId: string
  readonly pending: Map<string, PendingApproval>
  readonly questions: Map<string, { readonly request: PendingApproval; readonly ids: ReadonlySet<string> }>
  readonly session: AgentSession
  turnRunning: boolean
  /** Helpers (sub-agents) still running; they keep the session open and the conversation working (J7). */
  readonly helpers: Set<string>
  /** Messages you sent mid-turn that wait in the agent's queue, until it takes them (J1). */
  readonly waiting: Set<string>
  /** A helper finished between turns: the agent reports back on its own, so its next output starts a turn. */
  followUp: boolean
  /** The turn's result came while messages still waited: it is "working" only for them. */
  afterResult: boolean
  stopRequested: boolean
  /** Text streamed so far for the message in progress, so a late viewer sees all of it. */
  partial: string
  idleTimer?: NodeJS.Timeout
  /** This process's launch number for the conversation. */
  readonly generation: number
  /** The run the agent is working on now; its result is stamped with it. */
  runId?: string
  /** Runs of messages still waiting in the queue, by queued id: a taken one becomes the current run. */
  readonly queuedRuns: Map<string, string>
  /** Revokes the session's control grant; also on close, in case no exit event comes (ID-06). */
  readonly releaseGrant: () => void
}

/** The conversation's agent is still working, so this cannot happen yet (HTTP 409). */
export class ThreadBusyError extends Error {}

/** An operation ID already used for a different request (HTTP 409); the first request stands (ID-05). */
export class OperationConflictError extends Error {}
/** The handoff the user read is no longer what a switch would send (D13). */
export class HandoffChangedError extends Error {}
/** The conversation has run in more than one workspace and the request did not say which (HTTP 409). */
export class ChooseWorkspaceError extends Error {}
/** The workspace asked for is not this project's, or no longer exists (HTTP 409); never replaced by another. */
export class WorkspaceUnavailableError extends Error {}

// Cockpit tools whose every call Cockpit approves itself, on the server (host-actions.ts), because
// the CLI's own gate can be bypassed. The CLI's prompt for the same call would ask twice: it is
// allowed here and only Cockpit's card is shown. save_workflow is not listed: Cockpit asks for it
// only when the project has not allowed agent workflows, so the CLI's prompt may be the only one.
const HOST_APPROVED_TOOLS = new Set(['start_process', 'stop_process', 'remember', 'start_conversation', 'send_to_conversation', 'stop_conversation']
  .map((tool) => `mcp__cockpit__${tool}`))
/** A late event worth a label: what a replaced process tried to say, never deltas, usage or its own exit. */
const STALE_LABELLED = new Set<NormalizedEvent['kind']>(['session', 'result', 'assistant_text', 'tool_use', 'approval_request', 'question', 'error', 'subagent'])

export interface ThreadManager {
  /**
   * `text` is what the user wrote (stored, titled, shown); `agentText` is what the
   * agent receives when references were expanded. They differ only for attachments
   * and workflow references. `workflows` records the referenced instructions as they were used.
   */
  /** A Cockpit-side action an agent asked for (conversation control, processes, memory, workflows), approved by the user here. */
  requestHostAction(threadId: string, toolName: string, input: unknown, signal?: AbortSignal, options?: HostActionOptions): Promise<Exclude<ApprovalBehavior, 'deny'>>
  /** A turn is running and not being stopped: in that workspace, or (without one) in any of the conversation's. */
  canControl(threadId: string, workspaceId?: string): boolean
  create(input: { createdByThreadId?: string; delegationDepth?: number; projectPath: string; title?: string; settings: ThreadSettings; text: string; agentText?: string; workflows?: readonly WorkflowSnapshot[]; workflowId?: string; workflowTrigger?: 'manual' | 'scheduled'; images?: readonly IncomingImage[]; /** An active workspace of this project to start in; refused (never replaced by the primary) when it is not. */ workspaceId?: string }): ThreadMeta
  /** `images` are checked and stored before anything is recorded or sent; a bad one throws ImageAttachError. */
  /** `operationId` makes a repeat of the same request a no-op that answers with the first run. */
  /** `workspaceId` names where it runs; required once the conversation has run in more than one workspace. */
  send(threadId: string, text: string, agentText?: string, workflows?: readonly WorkflowSnapshot[], fromConversation?: { id: string; title: string }, images?: readonly IncomingImage[], operationId?: string, workspaceId?: string): { runId: string; replayed: boolean }
  /** At startup: closes runs a crash left open as interrupted, and returns their conversations. Relaunches nothing (ID-07). */
  recoverInterrupted(): string[]
  approve(threadId: string, requestId: string, behavior: ApprovalBehavior): void
  /** Takes back a message still waiting in the agent's queue (J1); resolves to its text and images for your draft. */
  unqueue(threadId: string, queuedId: string): Promise<{ text: string; images: { file: string; name?: string }[] }>
  /** Answers the agent's open questions (J6), or with undefined closes them unanswered. */
  answerQuestion(threadId: string, requestId: string, answers: Readonly<Record<string, string>> | undefined): void
  /** Stops the turn in one workspace; without `workspaceId`, every workspace's (Stop all, W12-15). */
  interrupt(threadId: string, workspaceId?: string): void
  setCompleted(threadId: string, completed: boolean): ThreadMeta
  /** Clears the question or blocker the last turn ended with, without replying. */
  dismissAwaiting(threadId: string): void
  /** Tells the project's other conversations that its branch changed (from `byThreadId`, if given). */
  /** `workspaceId` limits it to the conversations working in that workspace: a branch belongs to one workspace. */
  noteBranchChange(projectPath: string, from: string, to: string, byThreadId?: string, workspaceId?: string): void
  /** Stops its agent session, deletes everything stored for it and tells every window. */
  remove(threadId: string): Promise<void>
  /** Same agent, new model/effort/permissions: the native session resumes with them from the next message. */
  changeSettings(threadId: string, settings: ThreadSettings): ThreadMeta
  /** The handoff a switch would send now, for the user to read first (D13). */
  handoffPreview(threadId: string): HandoffPreview
  /**
   * Hand the thread to another agent/model; the transcript goes with it. With `shown` (the digest of
   * the previewed handoff), a conversation that changed since the preview is refused, not sent.
   */
  switchAgent(threadId: string, settings: ThreadSettings, shown?: string): ThreadMeta
  /** Resume with manual permissions and CLI defaults; retain the native session when the agent is unchanged. */
  resumeRecovered(threadId: string, agent: AgentId, text: string, agentText: string): ThreadMeta
  summaries(): ThreadSummary[]
  /** The run the conversation's agent is working on now, if any (in that workspace, when named). */
  currentRunId(threadId: string, workspaceId?: string): string | undefined
  status(threadId: string): ThreadStatus
  /** The agent message currently being streamed, or '' between messages (every workspace's, joined, without `workspaceId`). */
  partialText(threadId: string, workspaceId?: string): string
  /** Each workspace's streamed text and whether its turn is running (W12-15). */
  runs(threadId: string): Array<{ workspaceId: string; working: boolean; partial: string; runId?: string }>
  subscribe(listener: UpdateListener): () => void
  /** Live sessions on one agent CLI, in every project: working (a turn or helpers) and idle (W10-07). */
  agentActivity(agent: AgentId): { busy: number; idle: number }
  /** Gracefully ends that agent's idle sessions, so its executable can be replaced; working ones are left alone. */
  closeIdleSessions(agent: AgentId): Promise<void>
  /** A project's conversations on one agent that are working or hold queued messages: an account change waits for them. */
  accountActivity(projectPath: string, agent: AgentId): { busy: number; queued: number }
  /** Conversations working under an account right now, in every project (idle sessions not counted). */
  accountSessions(accountId: string): number
  /** Gracefully ends the idle sessions running under an account, before its context is signed out. */
  closeAccountSessions(accountId: string): Promise<void>
  /**
   * After a project's account changed: idle sessions on that agent close, and each conversation bound
   * to another account records the change and continues on a fresh native session with a handoff.
   */
  rebindProject(projectPath: string, agent: AgentId, to: ResolvedAccount): Promise<void>
  /** The identity behind an account changed outside Cockpit: idle conversations on it are told and rebound. */
  identityChanged(accountId: string, to: ResolvedAccount, from?: AccountRef): Promise<void>
  /** Stops every live agent session; resolves once all have exited. */
  shutdown(): Promise<void>
}

export function createThreadManager(store: ThreadStore, options: ManagerOptions = {}): ThreadManager {
  // Tests replace some launchers; any they leave out keep the real one.
  const { capabilities } = options
  const launchers: Record<AgentId, Launcher> = {
    ...defaultLaunchers,
    antigravity: antigravityLauncher(capabilities ? () => capabilities.get('antigravity', { purpose: 'launch' }) : undefined, options.antigravityMcp),
    ...options.launchers,
  }
  // One live agent session per conversation AND workspace: two worktrees of one conversation can each
  // have an agent at work at the same time (W12-15). Keyed by keyOf(threadId, workspaceId).
  const live = new Map<string, Live>()
  const listeners = new Set<UpdateListener>()
  const generations = new Map<string, symbol>()
  const keyOf = (threadId: string, workspaceId: string | undefined): string => `${threadId}\u0000${workspaceId ?? ''}`
  const entriesOf = (threadId: string): Live[] => [...live.values()].filter((e) => e.threadId === threadId)
  const entryIn = (threadId: string, workspaceId: string | undefined): Live | undefined => live.get(keyOf(threadId, workspaceId))
  const closing = new Set<Promise<void>>()
  // Deleted conversations: a closing session's last events must not recreate their files.
  const deleted = new Set<string>()
  const hostActions = createHostActions((id, event, workspaceId) => record(id, event, workspaceId))
  const images = options.images ?? createImageStore(store.root)

  /** An image the agent showed, saved; undefined (and logged) when it is not one Cockpit keeps. */
  const keepImage = (threadId: string, event: Extract<NormalizedEvent, { kind: 'image_data' }>): NormalizedEvent | undefined => {
    try {
      const { source } = event
      if ('path' in source && statSync(source.path).size > MAX_ATTACHED_IMAGE_BYTES) throw new Error('over 5 MB')
      const saved = images.save(threadId, 'data' in source ? Buffer.from(source.data, 'base64') : readFileSync(source.path))
      const name = event.name ?? ('path' in source ? basename(source.path) : undefined)
      return { kind: 'image', file: saved.file, mediaType: saved.mediaType, from: 'agent', ...(name ? { name } : {}) }
    } catch (error) {
      console.warn('[cockpit] an image from the agent was not kept:', error instanceof Error ? error.message : error)
      return undefined
    }
  }

  const closeEntry = (entry: Live): Promise<void> => {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.stopRequested = true
    const closingSession = entry.session.close().finally(entry.releaseGrant)
    closing.add(closingSession)
    void closingSession.then(() => closing.delete(closingSession), () => closing.delete(closingSession))
    return closingSession
  }

  const busy = (entry: Live | undefined): boolean => Boolean(entry && (entry.turnRunning || entry.helpers.size > 0))
  const anyBusy = (threadId: string): boolean => entriesOf(threadId).some(busy)
  /** Whether a workspace's turn is running; '' (events from before workspaces) means any of them. */
  const busyIn = (threadId: string) => (workspaceId: string): boolean => (workspaceId === '' ? anyBusy(threadId) : busy(entryIn(threadId, workspaceId)))
  const statusOf = (threadId: string): ThreadStatus => deriveStatus(store.events(threadId), busyIn(threadId))
  const armIdleClose = (entry: Live): void => {
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => void entry.session.close(), IDLE_CLOSE_MS)
  }

  // A streamed token changes no stored event, so its status is the last one worked out for the
  // thread, unless the live session has since started or finished being busy.
  const lastStatus = new Map<string, { status: ThreadStatus; busy: string }>()
  const busySignature = (threadId: string): string => entriesOf(threadId).filter(busy).map((e) => e.workspaceId).sort().join('\n')
  const broadcast = (threadId: string, event: NormalizedEvent, workspaceId?: string): void => {
    const isBusyNow = busySignature(threadId)
    const last = lastStatus.get(threadId)
    const status = event.kind === 'text_delta' && last && last.busy === isBusyNow ? last.status : deriveStatus(store.events(threadId), busyIn(threadId))
    lastStatus.set(threadId, { status, busy: isBusyNow })
    const update: ThreadUpdate = { threadId, event, status, ...(workspaceId ? { workspaceId } : {}) }
    for (const listener of listeners) listener(update)
  }

  const persist = (write: () => unknown, kind: NormalizedEvent['kind']): void => {
    try { write() } catch (error) { console.error(`[cockpit] could not save a ${kind} event`, error) }
  }

  /**
   * `workspaceId` names the workspace whose session (or send) the event belongs to; the event is stored
   * with it, and only that workspace's live session reacts to it. Conversation-wide events pass none.
   */
  const record = (threadId: string, raw: NormalizedEvent, workspaceId?: string): void => {
    if (deleted.has(threadId)) return
    // Text an agent types into a web page is never stored or shown, only its length (H3).
    const incoming = redactBrowserEvent(raw)
    if (incoming.kind === 'image_data') {
      const image = keepImage(threadId, incoming)
      if (image) record(threadId, image, workspaceId)
      return
    }
    const owner = workspaceId === undefined ? undefined : entryIn(threadId, workspaceId)
    // Taken signals matter only for messages that waited; the rest would just fill the log.
    if (incoming.kind === 'user_taken') {
      const waiting = owner?.waiting
      if (!incoming.id || !waiting?.delete(incoming.id)) return
      const entry = owner!
      entry.afterResult = false
      const taken = entry.queuedRuns.get(incoming.id)
      if (taken) { entry.runId = taken; entry.queuedRuns.delete(incoming.id) }
      // A message queued past the end of a turn (or a Stop) starts the next one when taken.
      if (!entry.turnRunning) {
        entry.turnRunning = true
        if (entry.idleTimer) clearTimeout(entry.idleTimer)
      }
    }
    // A run's end cancels only its own workspace's pending Cockpit actions; a switch ends them all.
    if (incoming.kind === 'result' || incoming.kind === 'exit') hostActions.cancel(threadId, workspaceId ?? '')
    if (incoming.kind === 'exit') hostActions.forget(threadId, workspaceId ?? '')
    if (incoming.kind === 'agent_switch') { hostActions.cancel(threadId); hostActions.forget(threadId) }
    const entry = owner
    // A dead process cannot finish its turn later. Do not apply this to protocol errors.
    if (incoming.kind === 'exit' && entry?.turnRunning) record(threadId, { kind: 'result', ok: false }, workspaceId)
    // A failed result right after the user pressed Stop is a stop, not an error.
    const stopped: NormalizedEvent =
      incoming.kind === 'result' && !incoming.ok && entry?.stopRequested ? { ...incoming, stopped: true } : incoming
    const event: NormalizedEvent = stopped.kind === 'result' && !stopped.runId && entry?.runId ? { ...stopped, runId: entry.runId } : stopped
    // Deltas are for live rendering only; the final assistant_text is persisted.
    // A write that fails (a full disk) loses this event from the log, but the state below must still
    // move: a lost result or exit would otherwise leave the conversation working, and its session live, for good.
    if (event.kind !== 'text_delta') persist(() => store.append(threadId, event, undefined, workspaceId || undefined), event.kind)
    if (entry && event.kind === 'text_delta') entry.partial += event.text
    if (entry && (event.kind === 'assistant_text' || event.kind === 'result')) entry.partial = ''
    if (entry && event.kind === 'subagent') {
      if (event.phase === 'started') entry.helpers.add(event.id)
      if (event.phase === 'finished' && entry.helpers.delete(event.id) && !entry.turnRunning) {
        // A helper you stopped does not get reported on.
        entry.followUp = !entry.stopRequested
        if (entry.helpers.size === 0) { entry.stopRequested = false; armIdleClose(entry) }
      }
    }
    if (entry?.followUp && !entry.turnRunning && (event.kind === 'text_delta' || event.kind === 'assistant_text' || event.kind === 'tool_use')) {
      entry.followUp = false
      entry.turnRunning = true
      if (entry.idleTimer) clearTimeout(entry.idleTimer)
    }
    // Only provider evidence makes a session resumable; constructing a process does not. A session
    // still running in a workspace the conversation has since moved away from updates that binding.
    if (event.kind === 'session') {
      const meta = store.get(threadId)
      const away = meta && workspaceId && currentWorkspace(meta) !== workspaceId ? meta.bindings?.[workspaceId] : undefined
      if (meta && away && workspaceId) {
        persist(() => store.update(threadId, { bindings: { ...meta.bindings, [workspaceId]: { ...away, sessionId: event.sessionId, sessionStarted: true } } }), event.kind)
      } else if (meta) persist(() => store.update(threadId, { sessionId: event.sessionId, sessionStarted: true, handoff: undefined }), event.kind)
    }
    if (entry && event.kind === 'result') {
      entry.pending.clear()
      entry.questions.clear()
      // Messages still waiting run next, without you sending again.
      entry.turnRunning = entry.waiting.size > 0
      entry.afterResult = entry.turnRunning
      entry.stopRequested = false
      // Closing the process would kill helpers still at work, or drop waiting messages.
      if (entry.helpers.size === 0 && !entry.turnRunning) armIdleClose(entry)
    }
    if (event.kind === 'exit' && workspaceId !== undefined) {
      if (entry?.idleTimer) clearTimeout(entry.idleTimer)
      live.delete(keyOf(threadId, workspaceId))
      generations.delete(keyOf(threadId, workspaceId))
    }
    broadcast(threadId, event, workspaceId)
  }

  /**
   * Ends a thread's live session before its exit is recorded (delete, switch agent, change settings,
   * recovery): pending Cockpit actions are refused and what was allowed for that session is
   * forgotten now, not when an exit that is dropped as stale would have done it.
   */
  const retire = (threadId: string, workspaceId?: string): Promise<void> => {
    hostActions.cancel(threadId, workspaceId)
    hostActions.forget(threadId, workspaceId)
    const entries = workspaceId === undefined ? entriesOf(threadId) : [entryIn(threadId, workspaceId)].filter((e): e is Live => e !== undefined)
    for (const entry of entries) {
      live.delete(keyOf(threadId, entry.workspaceId))
      generations.delete(keyOf(threadId, entry.workspaceId))
    }
    return Promise.all(entries.map(closeEntry)).then(() => undefined)
  }

  /** The account a conversation's native session belongs to: before accounts, the CLI default. */
  const accountOf = (meta: ThreadMeta): string => meta.accountId ?? defaultAccountId(meta.settings.agent)
  // A conversation from before accounts ran on the CLI default as first identified: generation 1.
  const boundTo = (meta: ThreadMeta, account: ResolvedAccount): boolean =>
    accountOf(meta) === account.accountId && (meta.accountGeneration ?? 1) === account.generation
  /** Has run on an account (or holds a native session): a change of account is worth telling it about. */
  const hasAccount = (meta: ThreadMeta): boolean => meta.sessionStarted || meta.accountGeneration !== undefined

  /** The workspace the conversation works in now; legacy conversations resolve to their project's primary. */
  const currentWorkspace = (meta: ThreadMeta): string | undefined => meta.workspaceId ?? options.workspaceFor?.(meta.projectPath)
  const labelOf = (workspace: Workspace | undefined): string =>
    !workspace ? 'a workspace that no longer exists' : workspace.kind === 'primary' ? 'the main checkout' : `${workspace.name ?? 'a worktree'}${workspace.branch ? ` (${workspace.branch})` : ''}`
  /** The folder a workspace's agent runs in; undefined once it is gone: never the primary in its place (INTERFACES §5). */
  const cwdOf = (meta: ThreadMeta, workspaceId: string | undefined): string | undefined => {
    const folder = workspaceFolder(options.workspace, meta.projectPath, workspaceId)
    return isRefusal(folder) ? undefined : folder.cwd
  }

  /** Where the conversation works now, for what an agent is told about its folder. */
  const workingFolder = (meta: ThreadMeta): string => cwdOf(meta, currentWorkspace(meta)) ?? meta.projectPath

  /**
   * Moves an idle conversation to another workspace of its project (W12.2). Its current native
   * session is kept as that workspace's binding. The target's own session resumes with what happened
   * since it last ran, or a new one starts with the conversation so far. One transcript throughout.
   */
  const moveTo = (meta: ThreadMeta, target: string): ThreadMeta => {
    const current = currentWorkspace(meta)
    if (current === target) return meta
    const into = options.workspace?.(target)
    const home = options.workspaceFor?.(meta.projectPath)
    const homeProject = home ? options.workspace?.(home)?.projectId : undefined
    if (!into || !homeProject || into.projectId !== homeProject) throw new WorkspaceUnavailableError("That workspace is not part of this conversation's project")
    if (into.lifecycle !== 'active') throw new WorkspaceUnavailableError('That workspace is no longer available')
    // A run in the workspace being left keeps going on its own binding (W12-15); an idle session there closes.
    const leavingEntry = entryIn(meta.id, current)
    if (!busy(leavingEntry) && (leavingEntry?.waiting.size ?? 0) === 0) void retire(meta.id, current ?? '')
    const events = store.events(meta.id)
    const leaving = current ? { [current]: {
      agent: meta.settings.agent, bindingId: bindingIdOf(meta), sessionId: meta.sessionId, sessionStarted: meta.sessionStarted,
      ...(meta.accountId ? { accountId: meta.accountId } : {}), ...(meta.accountGeneration !== undefined ? { accountGeneration: meta.accountGeneration } : {}),
      cursor: events.length,
    } } : {}
    const { [target]: back, ...others } = meta.bindings ?? {}
    const where = into.kind === 'primary' ? meta.projectPath : into.cwd
    const dir = images.dir(meta.id)
    const resumes = back !== undefined && back.agent === meta.settings.agent && back.sessionStarted
    // A resumed session hears what happened ELSEWHERE since its cursor: never its own output again,
    // which matters when it kept working while the conversation was looking at another workspace.
    const keys = attribute(events)
    const since = resumes ? events.filter((_, i) => i >= back.cursor && keys[i] !== target) : events
    const told = since.length > 0 ? workspaceContext(since, where, resumes ? 'catch-up' : 'handoff', dir) : undefined
    record(meta.id, { kind: 'workspace_changed', from: current ?? '', to: target, ...(current ? { fromLabel: labelOf(options.workspace?.(current)) } : {}), toLabel: labelOf(into),
      context: resumes ? 'resumed' : told ? 'handoff' : 'none' })
    return store.update(meta.id, {
      workspaceId: target, bindings: { ...others, ...leaving },
      ...(resumes
        ? { sessionId: back.sessionId, bindingId: back.bindingId, sessionStarted: true, accountId: back.accountId, accountGeneration: back.accountGeneration, handoff: undefined, catchUp: told }
        : { sessionId: randomUUID(), bindingId: randomUUID(), sessionStarted: false, accountId: undefined, accountGeneration: undefined, handoff: told, catchUp: undefined }),
    })
  }

  /**
   * Moves an idle conversation to another account (or identity): the change is recorded where the
   * user reads it, and the next message starts a new native session there with the conversation so
   * far as a handoff. Provider resume across accounts is impossible for both CLIs (G-ACCOUNTS).
   */
  const rebind = (meta: ThreadMeta, to: ResolvedAccount, reason: 'selected' | 'identity_changed', previous?: AccountRef): ThreadMeta => {
    // After an identity change the account's record already holds the new identity: the previous
    // one is passed in, or (not known here) left out rather than shown as the new one.
    const current = options.accounts?.describe(accountOf(meta))
    const from = previous ?? (reason === 'identity_changed' && current ? { id: current.id, label: current.label } : current)
    const target = options.accounts?.describe(to.accountId) ?? { id: to.accountId, label: to.label }
    const started = meta.sessionStarted
    // An agent switch's handoff that was never delivered still goes; otherwise the transcript.
    const handoff = started ? previewHandoff(store.events(meta.id), workingFolder(meta), images.dir(meta.id)).text : meta.handoff
    record(meta.id, { kind: 'account_changed', agent: meta.settings.agent, ...(from ? { from } : {}), to: target, reason, handoff: handoff !== undefined })
    return store.update(meta.id, {
      ...(started ? { sessionId: randomUUID(), bindingId: randomUUID(), sessionStarted: false } : {}),
      ...(handoff !== undefined ? { handoff } : {}),
      accountId: to.accountId, accountGeneration: to.generation,
    })
  }

  const ensureSession = (start: ThreadMeta): Live => {
    let meta = start
    const workspaceId = currentWorkspace(meta)
    const key = keyOf(meta.id, workspaceId)
    const existing = live.get(key)
    if (existing?.session.alive()) return existing
    // A new session starts with nothing allowed for it, however the previous one ended.
    hostActions.forget(meta.id, workspaceId ?? '')
    // Read at launch: the project's account now. A native session from another account (or an older
    // identity of this one) is never resumed under it: the conversation is rebound first (W12-03).
    const account = options.accounts?.resolve(meta.projectPath, meta.settings.agent)
    if (account && hasAccount(meta) && !boundTo(meta, account)) meta = rebind(meta, account, accountOf(meta) === account.accountId ? 'identity_changed' : 'selected')
    const generation = Symbol()
    generations.set(key, generation)
    const pending = new Map<string, PendingApproval>()
    const questions: Live['questions'] = new Map()
    const requestIds = new Map<string, string>()
    // Persisted before the boundary, so every event after it belongs to this launch, even across a restart.
    const launchNumber = (meta.sessionGeneration ?? 0) + 1
    const cwd = cwdOf(meta, workspaceId)
    store.update(meta.id, { sessionGeneration: launchNumber, bindingId: bindingIdOf(meta), ...(workspaceId ? { workspaceId } : {}),
      ...(account ? { accountId: account.accountId, accountGeneration: account.generation } : {}) })
    record(meta.id, { kind: 'session_boundary', generation: launchNumber, bindingId: bindingIdOf(meta), ...(account ? { account: { id: account.accountId, generation: account.generation } } : {}),
      ...(workspaceId ? { workspaceId } : {}) }, workspaceId ?? '')
    const mcp = options.mcp?.({ threadId: meta.id, projectPath: meta.projectPath, cwd: cwd ?? meta.projectPath, ...(workspaceId ? { workspaceId } : {}) })
    // Read at launch: edits reach the next session, never one already running.
    const instructions = options.instructions?.(meta.projectPath)
    let launching = true
    const deliver: EventSink = (event) => {
      // Even a synchronous launcher callback must follow the initial user_text and live entry.
      if (launching) { queueMicrotask(() => deliver(event)); return }
      // Called from the agent's stdout handlers: a throw here (a full disk on append) would be
      // uncaught and end the server with every other agent. Losing one event is the lesser harm.
      try { handleEvent(event) } catch (error) { console.error(`[cockpit] could not record a ${event.kind} event`, error) }
    }
    let released = false
    const releaseGrant = (): void => { if (!released) { released = true; mcp?.release() } }
    const handleEvent: EventSink = (event) => {
      if (event.kind === 'exit') releaseGrant()
      // An old process may still talk after its replacement started: it is labelled, never acted on (ID-04).
      if (generations.get(key) !== generation) {
        if (STALE_LABELLED.has(event.kind)) record(meta.id, { kind: 'stale_event', generation: launchNumber, eventKind: event.kind }, workspaceId ?? '')
        return
      }
      if (event.kind === 'approval_request' && HOST_APPROVED_TOOLS.has(event.toolName)) {
        session.respondApproval({ requestId: event.requestId, input: event.input, suggestions: event.suggestions }, 'allow')
      } else if (event.kind === 'approval_request') {
        const publicId = randomUUID()
        requestIds.set(event.requestId, publicId)
        pending.set(publicId, { requestId: event.requestId, input: event.input, suggestions: event.suggestions })
        record(meta.id, { ...event, requestId: publicId }, workspaceId ?? '')
      } else if (event.kind === 'question') {
        const publicId = randomUUID()
        requestIds.set(event.requestId, publicId)
        // Claude echoes its tool input back with the answers; this is that input, field for field.
        const input = { questions: event.questions.map(({ question, header, options, multiSelect }) => ({ question, header, options, multiSelect })) }
        questions.set(publicId, { request: { requestId: event.requestId, input, suggestions: [] }, ids: new Set(event.questions.map((q) => q.id)) })
        record(meta.id, { ...event, requestId: publicId }, workspaceId ?? '')
      } else if (event.kind === 'question_answered') {
        const publicId = requestIds.get(event.requestId)
        if (!publicId) return
        questions.delete(publicId)
        requestIds.delete(event.requestId)
        record(meta.id, { ...event, requestId: publicId }, workspaceId ?? '')
      } else if (event.kind === 'approval_resolved') {
        const publicId = requestIds.get(event.requestId)
        if (!publicId) return
        pending.delete(publicId)
        requestIds.delete(event.requestId)
        record(meta.id, { ...event, requestId: publicId }, workspaceId ?? '')
      } else {
        if (event.kind === 'result' || event.kind === 'exit') {
          pending.clear()
          questions.clear()
          requestIds.clear()
        }
        record(meta.id, event, workspaceId ?? '')
      }
    }
    const blocked = cwd === undefined ? 'This workspace no longer exists. Continue the conversation in another workspace.' : options.launchGate?.(meta.settings.agent)
    const launcher: Launcher = blocked ? (_req, onEvent) => refusedSession(meta.settings.agent, blocked, onEvent) : launchers[meta.settings.agent]
    const session = launcher(
      {
        ...(instructions ? { projectInstructions: instructions.text } : {}),
        cwd: cwd ?? meta.projectPath,
        settings: meta.settings,
        ...(meta.sessionStarted ? { resume: meta.sessionId } : { sessionId: meta.sessionId }),
        ...(meta.handoff && !meta.sessionStarted ? { seed: meta.handoff } : {}),
        ...(mcp ? { cockpit: mcp.launch } : {}),
        imagesDir: images.dir(meta.id),
        ...(account && Object.keys(account.env).length > 0 ? { accountEnv: account.env } : {}),
      },
      deliver,
    )
    launching = false
    const entry: Live = { threadId: meta.id, workspaceId: workspaceId ?? '', pending, questions, helpers: new Set(), waiting: new Set(), followUp: false, afterResult: false, session, turnRunning: false, stopRequested: false, partial: '', generation: launchNumber, queuedRuns: new Map(), releaseGrant }
    live.set(key, entry)
    store.update(meta.id, { instructionsRevision: instructions?.revision, instructionsText: instructions?.text })
    return entry
  }

  const requireMeta = (threadId: string): ThreadMeta => {
    const meta = store.get(threadId)
    if (!meta) throw new Error(`Unknown thread ${threadId}`)
    return meta
  }

  const send = (threadId: string, text: string, agentText = text, workflows?: readonly WorkflowSnapshot[], fromConversation?: { id: string; title: string }, attached: readonly IncomingImage[] = [], operationId?: string, workspaceId?: string): { runId: string; replayed: boolean } => {
    if (deleted.has(threadId)) throw new Error('This conversation was deleted')
    const meta = requireMeta(threadId)
    const operation = operationId ? { id: operationId, inputHash: inputHash(text, attached) } : undefined
    if (operation) {
      // Checked before any effect, against the durable log, so a repeat after a restart is still one request.
      const earlier = store.events(threadId).find((e) => e.event.kind === 'user_text' && e.event.operation?.id === operation.id)?.event
      if (earlier?.kind === 'user_text') {
        if (earlier.operation?.inputHash !== operation.inputHash) throw new OperationConflictError('This request ID was already used for a different message')
        return { runId: earlier.runId!, replayed: true }
      }
    }
    // Once it has run in several workspaces, a request says which; it is never guessed (INTERFACES §5).
    if (workspaceId) moveTo(meta, workspaceId)
    else if (Object.keys(meta.bindings ?? {}).length > 0) throw new ChooseWorkspaceError('This conversation has run in more than one workspace. Choose the workspace to continue in.')
    const target = currentWorkspace(requireMeta(threadId)) ?? ''
    hostActions.cancel(threadId, target)
    // Every image is checked and stored first, so a bad one sends nothing.
    const stored = attached.map((image) => ({ ...images.save(threadId, image.bytes), image }))
    const outgoing: OutgoingImage[] = stored.map(({ path, mediaType, image }) => ({ path, mediaType, data: image.bytes.toString('base64') }))
    const entry = ensureSession(requireMeta(threadId))
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    // A resumed workspace session hears once what happened elsewhere since it last ran.
    // Not while that session is mid-turn: the catch-up waits for its next idle message.
    const launched = requireMeta(threadId)
    const deliverCatchUp = Boolean(launched.catchUp && launched.sessionStarted && !entry.turnRunning)
    const toAgent = deliverCatchUp ? `${launched.catchUp}\n\n${agentText}` : agentText
    if (launched.catchUp && (deliverCatchUp || !launched.sessionStarted)) store.update(threadId, { catchUp: undefined })
    // Mid-turn, a message waits in the agent's queue where it can still be taken back (J1).
    const queuedId = entry.turnRunning && entry.session.queues?.() ? randomUUID() : undefined
    const runId = randomUUID()
    const bound = requireMeta(threadId)
    const binding = queuedId ? { bindingId: bindingIdOf(bound), ...(bound.workspaceId ? { workspaceId: bound.workspaceId } : {}), agent: bound.settings.agent, generation: entry.generation } : undefined
    if (queuedId) { entry.waiting.add(queuedId); entry.queuedRuns.set(queuedId, runId) }
    else { entry.afterResult = false; entry.runId = runId }
    entry.turnRunning = true
    if (meta.completed) {
      store.update(threadId, { completed: false })
      record(threadId, { kind: 'completion_changed', completed: false })
    } else store.update(threadId, {})
    record(threadId, { kind: 'user_text', text, ...(fromConversation ? { fromConversation } : {}), ...(workflows?.length ? { workflows } : {}), ...(queuedId ? { queuedId } : {}), runId, ...(operation ? { operation } : {}), ...(binding ? { binding } : {}) }, target)
    for (const { file, mediaType, image } of stored) record(threadId, { kind: 'image', file, mediaType, from: 'you', ...(image.name ? { name: image.name } : {}) }, target)
    entry.session.send(toAgent, queuedId, outgoing.length ? outgoing : undefined)
    return { runId, replayed: false }
  }

  return {
    canControl: (id, workspaceId) => (workspaceId === undefined ? entriesOf(id) : [entryIn(id, workspaceId)]).some((e) => Boolean(e?.turnRunning && !e.stopRequested)),
    requestHostAction(threadId, toolName, input, signal, options) {
      // The asking agent's own workspace: named by its grant, else the one session that is working.
      const working = entriesOf(threadId).filter((e) => e.turnRunning && !e.stopRequested)
      const asking = options?.workspaceId !== undefined ? entryIn(threadId, options.workspaceId) : working.length === 1 ? working[0] : undefined
      if (!asking?.turnRunning || asking.stopRequested) return Promise.reject(new Error("The calling conversation is no longer working"))
      return hostActions.request(threadId, toolName, input, signal, { ...options, workspaceId: asking.workspaceId })
    },
    create({ projectPath, title, settings, text, agentText, workflows, workflowId, workflowTrigger, createdByThreadId, delegationDepth, images: attached, workspaceId: startIn }) {
      const now = new Date().toISOString()
      const primary = options.workspaceFor?.(projectPath)
      if (startIn && startIn !== primary) {
        const into = options.workspace?.(startIn)
        const projectId = primary ? options.workspace?.(primary)?.projectId : undefined
        if (!into || !projectId || into.projectId !== projectId) throw new WorkspaceUnavailableError("That workspace is not part of this project")
        if (into.lifecycle !== 'active') throw new WorkspaceUnavailableError('That workspace is no longer available')
      }
      const meta = store.create({
        id: randomUUID(),
        workflowId, workflowTrigger,
        ...(createdByThreadId ? { createdByThreadId, delegationDepth } : {}),
        title: title?.trim() || text.slice(0, 60),
        projectPath,
        settings,
        sessionId: randomUUID(),
        bindingId: randomUUID(),
        ...((startIn ?? primary) ? { workspaceId: startIn ?? primary } : {}),
        sessionStarted: false,
        completed: false,
        createdAt: now,
        updatedAt: now,
      })
      const source = createdByThreadId ? store.get(createdByThreadId) : undefined
      try {
        send(meta.id, text, agentText, workflows, source ? { id: source.id, title: source.title } : undefined, attached)
      } catch (error) {
        // A refused image leaves no empty conversation behind.
        store.remove(meta.id)
        images.remove(meta.id)
        throw error
      }
      return meta
    },
    send,
    approve(threadId, requestId, behavior) {
      if (hostActions.approve(threadId, requestId, behavior)) return
      // The session that asked, in whichever workspace: never another workspace's (W12-15).
      const entry = entriesOf(threadId).find((e) => e.pending.has(requestId)) ?? entriesOf(threadId)[0]
      if (!entry?.session.alive()) throw new Error('This approval belongs to a session that has ended')
      const request = entry.pending.get(requestId)
      if (!request || !entry.turnRunning) throw new Error('Unknown or expired approval request')
      entry.pending.delete(requestId)
      entry.session.respondApproval(request, behavior)
    },
    async unqueue(threadId, queuedId) {
      const entry = entriesOf(threadId).find((e) => e.waiting.has(queuedId))
      const sent = store.events(threadId).find((e) => e.event.kind === 'user_text' && e.event.queuedId === queuedId)?.event
      if (!entry?.waiting.has(queuedId) || sent?.kind !== 'user_text' || !entry.session.cancelQueued) throw new Error('The agent has already taken this message')
      if (!(await entry.session.cancelQueued(queuedId))) throw new Error('The agent has already taken this message')
      entry.waiting.delete(queuedId)
      // The images sent with it are stored straight after it; they go back to the composer too.
      const events = store.events(threadId)
      const at = events.findIndex((e) => e.event.kind === 'user_text' && e.event.queuedId === queuedId)
      const after = events.slice(at + 1)
      const end = after.findIndex((e) => !(e.event.kind === 'image' && e.event.from === 'you'))
      const images = (end < 0 ? after : after.slice(0, end)).flatMap(({ event }) =>
        event.kind === 'image' ? [{ file: event.file, ...(event.name ? { name: event.name } : {}) }] : [])
      // The turn already ended and only this message kept it working: it is done now. Before
      // recording, so the update carries the new status.
      if (entry.afterResult && entry.waiting.size === 0) {
        entry.afterResult = false
        entry.turnRunning = false
        entry.stopRequested = false
        if (entry.helpers.size === 0) armIdleClose(entry)
      }
      record(threadId, { kind: 'user_unqueued', id: queuedId }, entry.workspaceId)
      return { text: sent.text, images }
    },
    answerQuestion(threadId, requestId, answers) {
      const entry = entriesOf(threadId).find((e) => e.questions.has(requestId)) ?? entriesOf(threadId)[0]
      if (!entry?.session.alive()) throw new Error('These questions belong to a session that has ended')
      const open = entry.questions.get(requestId)
      if (!open || !entry.turnRunning || !entry.session.respondQuestion) throw new Error('Unknown or expired questions')
      // Only answers to the questions asked, so a stale or forged key never reaches the agent.
      const kept = answers ? Object.fromEntries(Object.entries(answers).filter(([id, value]) => open.ids.has(id) && value.trim().length > 0)) : undefined
      entry.questions.delete(requestId)
      entry.session.respondQuestion(open.request, kept && Object.keys(kept).length > 0 ? kept : undefined)
    },
    interrupt(threadId, workspaceId) {
      hostActions.cancel(threadId, workspaceId)
      const entries = workspaceId === undefined ? entriesOf(threadId) : [entryIn(threadId, workspaceId)].filter((e): e is Live => e !== undefined)
      for (const entry of entries) {
        entry.stopRequested = true
        entry.session.interrupt()
      }
    },
    setCompleted(threadId, completed) {
      requireMeta(threadId)
      // J11: nothing to complete while any of its agents is still at it. Reopening is always allowed.
      if (completed && anyBusy(threadId)) throw new ThreadBusyError('Mark it complete when every agent in it has finished')
      const meta = store.update(threadId, { completed })
      record(threadId, { kind: 'completion_changed', completed })
      return meta
    },
    noteBranchChange(projectPath, from, to, byThreadId, workspaceId) {
      const byTitle = byThreadId ? store.get(byThreadId)?.title : undefined
      for (const meta of store.list()) {
        if (meta.projectPath !== projectPath || meta.id === byThreadId || deleted.has(meta.id)) continue
        if (workspaceId && currentWorkspace(meta) !== workspaceId) continue
        record(meta.id, { kind: 'branch_changed', from, to, ...(byTitle ? { byTitle } : {}) })
      }
    },
    dismissAwaiting(threadId) {
      requireMeta(threadId)
      if (!awaitingOf(store.events(threadId))) throw new Error('Nothing is waiting on you in this conversation')
      record(threadId, { kind: 'awaiting_dismissed' })
    },
    currentRunId: (threadId, workspaceId) => {
      const working = (workspaceId === undefined ? entriesOf(threadId) : [entryIn(threadId, workspaceId)]).filter((e) => e?.turnRunning)
      return working.length === 1 ? working[0]?.runId : undefined
    },
    async remove(threadId) {
      requireMeta(threadId)
      deleted.add(threadId)
      await retire(threadId)
      store.remove(threadId)
      images.remove(threadId)
      lastStatus.delete(threadId)
      const update: ThreadUpdate = { threadId, event: { kind: 'thread_deleted' }, status: 'idle' }
      for (const listener of listeners) listener(update)
    },
    handoffPreview(threadId) {
      const meta = requireMeta(threadId)
      return previewHandoff(store.events(threadId), workingFolder(meta), images.dir(threadId))
    },
    switchAgent(threadId, settings, shown) {
      const meta = requireMeta(threadId)
      if (anyBusy(threadId)) throw new Error('Stop the current turn before switching agents')
      const { text: handoff } = previewHandoff(store.events(threadId), workingFolder(meta), images.dir(threadId))
      if (shown !== undefined && handoffDigest(handoff) !== shown) throw new HandoffChangedError('The conversation changed since you reviewed the handoff. Review it again before switching.')
      void retire(threadId)
      store.append(threadId, { kind: 'agent_switch', from: meta.settings.agent, to: settings.agent })
      const next = store.update(threadId, { settings, sessionId: randomUUID(), bindingId: randomUUID(), sessionStarted: false, handoff })
      broadcast(threadId, { kind: 'agent_switch', from: meta.settings.agent, to: settings.agent })
      return next
    },
    changeSettings(threadId, settings) {
      const meta = requireMeta(threadId)
      if (settings.agent !== meta.settings.agent) throw new Error('Switch agents to change the agent')
      if (anyBusy(threadId)) throw new Error('Stop the current turn before changing settings')
      // Close the idle session; the next message relaunches it with the new flags and resumes it.
      void retire(threadId)
      const next = store.update(threadId, { settings })
      record(threadId, { kind: 'settings_changed', ...(settings.model ? { model: settings.model } : {}), ...(settings.effort ? { effort: settings.effort } : {}), permissionMode: settings.permissionMode,
        ...(Boolean(settings.useChrome) !== Boolean(meta.settings.useChrome) ? { chrome: settings.useChrome === true } : {}) })
      return next
    },
    resumeRecovered(threadId, agent, text, agentText) {
      const meta = requireMeta(threadId)
      if (anyBusy(threadId)) throw new Error('Stop the current turn before resuming recent work')
      const settings: ThreadSettings = { agent, permissionMode: 'manual', useHooks: false }
      if (agent !== meta.settings.agent) this.switchAgent(threadId, settings)
      else {
        // Re-launch even an idle session so an earlier permissive policy cannot survive recovery.
        void retire(threadId)
        store.update(threadId, { settings })
      }
      send(threadId, text, agentText)
      return requireMeta(threadId)
    },
    recoverInterrupted() {
      const recovered: string[] = []
      for (const meta of store.list()) {
        if (entriesOf(meta.id).length > 0 || deleted.has(meta.id)) continue
        // Each workspace's run is closed on its own: two may have been at work when Cockpit stopped.
        const events = store.events(meta.id)
        const runs = [...partition(events)].flatMap(([workspaceId, part]) => {
          const run = unfinishedRun(meta.id, part)
          return run ? [{ run, workspaceId }] : []
        })
        for (const { run, workspaceId } of runs) record(meta.id, { kind: 'result', ok: false, interrupted: true, runId: run.runId }, workspaceId || undefined)
        if (runs.length) recovered.push(meta.id)
      }
      return recovered
    },
    summaries() {
      const all = store.list().map((meta): ThreadSummary => {
        const events = store.events(meta.id)
        return {
          meta,
          status: deriveStatus(events, busyIn(meta.id)),
          preview: previewOf(events),
          messageCount: messageCountOf(events),
          lastActivityAt: events.findLast((e) => !QUIET.has(e.event.kind))?.ts ?? meta.updatedAt,
          ...(awaitingOf(events) ? { awaiting: awaitingOf(events) } : {}),
          ...(anyBusy(meta.id) && openQuestion(events) ? { asking: openQuestion(events) } : {}),
          ...(latestTurn(events) ? { turn: latestTurn(events) } : {}),
        }
      })
      return all.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
    },
    status: statusOf,
    partialText: (threadId, workspaceId) => (workspaceId === undefined ? entriesOf(threadId) : [entryIn(threadId, workspaceId)])
      .map((e) => e?.partial ?? '').filter(Boolean).join('\n\n'),
    runs: (threadId) => entriesOf(threadId).map((e) => ({ workspaceId: e.workspaceId, working: busy(e), partial: e.partial, ...(e.runId ? { runId: e.runId } : {}) })),
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    agentActivity(agent) {
      let working = 0
      let idle = 0
      for (const entry of live.values()) {
        if (entry.session.agent !== agent || !entry.session.alive()) continue
        if (busy(entry)) working++
        else idle++
      }
      return { busy: working, idle }
    },
    accountActivity(projectPath, agent) {
      let working = 0
      let queued = 0
      for (const entry of live.values()) {
        const meta = store.get(entry.threadId)
        if (!meta || meta.projectPath !== projectPath || meta.settings.agent !== agent || !entry.session.alive()) continue
        if (busy(entry)) working++
        if (entry.waiting.size > 0) queued++
      }
      return { busy: working, queued }
    },
    accountSessions(accountId) {
      let count = 0
      for (const entry of live.values()) {
        const meta = store.get(entry.threadId)
        if (meta && entry.session.alive() && busy(entry) && accountOf(meta) === accountId) count++
      }
      return count
    },
    async closeAccountSessions(accountId) {
      const idle = [...live.values()].filter((entry) => {
        const meta = store.get(entry.threadId)
        return meta && entry.session.alive() && !busy(entry) && accountOf(meta) === accountId
      })
      await Promise.all(idle.map((entry) => retire(entry.threadId, entry.workspaceId)))
    },
    async rebindProject(projectPath, agent, to) {
      const affected = store.list().filter((meta) => meta.projectPath === projectPath && meta.settings.agent === agent && !deleted.has(meta.id))
      if (affected.some((meta) => entriesOf(meta.id).some((e) => busy(e) || e.waiting.size > 0))) throw new ThreadBusyError('A conversation on this agent is still working in this project')
      await Promise.all(affected.map((meta) => retire(meta.id)))
      for (const meta of affected) if (!boundTo(meta, to) && hasAccount(meta)) rebind(store.get(meta.id) ?? meta, to, 'selected')
    },
    async identityChanged(accountId, to, from) {
      const affected = store.list().filter((meta) => !deleted.has(meta.id) && accountOf(meta) === accountId && hasAccount(meta) && !anyBusy(meta.id) && !boundTo(meta, to))
      await Promise.all(affected.map((meta) => retire(meta.id)))
      for (const meta of affected) rebind(store.get(meta.id) ?? meta, to, 'identity_changed', from)
    },
    async closeIdleSessions(agent) {
      const idle = [...live.values()].filter((entry) => entry.session.agent === agent && entry.session.alive() && !busy(entry))
      await Promise.all(idle.map(closeEntry))
    },
    async shutdown() {
      hostActions.cancel()
      await Promise.all([...closing, ...[...live.values()].map(closeEntry)])
    },
  }
}
